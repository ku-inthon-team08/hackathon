-- refresh_edge_exposure 속도 개선: 앞 버전은 구간마다 geography 거리를 수백만 번 계산해 REST 호출 시간 제한(약 8초)을 넘었다.
-- 좌표를 미터 단위 평면 좌표(EPSG:5179, 한국 중부원점)로 한 번 바꾼 뒤 평면 거리로 계산한다. 계산 규칙은 같다.
--
-- 도로 구간별 감각 노출값(edge_exposure)을 센서·혼잡도 측정값으로 다시 계산한다.
-- 수집 Edge Function이 수집 직후 rpc('refresh_edge_exposure')로 부른다. 반환값은 갱신한 구간 수.
--
-- 1) 센서별 현재값: 최근 3시간 안 가장 최신 측정. 없으면(새벽 공백 등) 과거 같은 요일 유형·같은 시각 평균
-- 2) 센서별 정규화
--    소음 noise_n = clip((dB - 40) / 30)            40dB 이하 0, 70dB 이상 1
--    조도 light_n = 지금 값들 사이의 백분위        낮에는 lux가 포화돼 절댓값 차이가 작아서 상대값을 쓴다
--    인파 flow_n  = 그 센서 자기 과거 값 대비 백분위
-- 3) 구간 중심점에서 IDW(거리 제곱 역수). 1km 안 가장 가까운 센서 최대 5개, 없으면 가장 가까운 5개
-- 4) 인파 crowd_n: 혼잡 장소 영역 안이면 최신 혼잡 등급(여유 0 · 보통 0.33 · 약간 붐빔 0.67 · 붐빔 1), 밖이면 유동인구 IDW
-- 5) confidence: 가장 가까운 환경 센서와 데이터 나이로 high(200m·60분) · mid(500m·120분) · low

create or replace function public.refresh_edge_exposure()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  updated integer;
  kst timestamp := now() at time zone 'Asia/Seoul';
  day_type int := case when extract(isodow from kst) >= 6 then 1 else 0 end;  -- 1 주말
begin
  with
  -- ───── 1) 센서별 현재값 ─────
  latest as (
    select distinct on (o.sensor_id) o.sensor_id, o.observed_at, o.noise_db, o.lux, o.flow_count
    from sensor_obs o
    where o.observed_at > now() - interval '3 hours'
      and (o.noise_db is not null or o.lux is not null or o.flow_count is not null)
    order by o.sensor_id, o.observed_at desc
  ),
  profile as (
    select o.sensor_id, avg(o.noise_db) noise_db, avg(o.lux) lux, avg(o.flow_count) flow_count
    from sensor_obs o
    where extract(hour from o.observed_at at time zone 'Asia/Seoul') = extract(hour from kst)
      and (case when extract(isodow from o.observed_at at time zone 'Asia/Seoul') >= 6 then 1 else 0 end) = day_type
    group by o.sensor_id
  ),
  cur as (
    select s.sensor_id, s.kind, s.geom,
           coalesce(l.noise_db, p.noise_db) noise_db,
           coalesce(l.lux, p.lux) lux,
           coalesce(l.flow_count, p.flow_count) flow_count,
           extract(epoch from now() - l.observed_at) / 60 age_min  -- 과거 평균으로 채웠으면 null
    from sensors s
    left join latest l using (sensor_id)
    left join profile p using (sensor_id)
  ),
  -- ───── 2) 센서별 정규화 ─────
  env as (
    select sensor_id, st_transform(geom, 5179) g, age_min,
           least(greatest((noise_db - 40) / 30.0, 0), 1) noise_n,
           percent_rank() over (order by lux) light_n
    from cur
    where kind = 'env' and noise_db is not null and lux is not null
  ),
  flow as (
    select c.sensor_id, st_transform(c.geom, 5179) g,
           (select count(*) filter (where h.flow_count <= c.flow_count)::real / nullif(count(*), 0)
            from sensor_obs h where h.sensor_id = c.sensor_id and h.flow_count is not null) flow_n
    from cur c
    where c.kind = 'floating' and c.flow_count is not null
  ),
  -- ───── 3) 구간별 IDW ─────
  edges as (
    select id, mid, st_transform(mid, 5179) g
    from (select e.id, st_lineinterpolatepoint(e.geom, 0.5) mid from road_edges e where e.is_walkable) x
  ),
  env_idw as (
    select e.id,
           sum(k.noise_n * k.w) / sum(k.w) noise_n,
           sum(k.light_n * k.w) / sum(k.w) light_n,
           min(k.d) nearest_m,
           (array_agg(k.age_min order by k.d))[1] nearest_age_min
    from edges e
    cross join lateral (
      select nb.*, 1.0 / greatest(nb.d, 1) ^ 2 w, min(nb.d) over () min_d
      from (
        select v.noise_n, v.light_n, v.age_min, st_distance(v.g, e.g) d
        from env v
        order by v.g <-> e.g
        limit 5
      ) nb
    ) k
    -- 1km 안 센서만 쓰되, 하나도 없으면 가장 가까운 5개를 그대로 쓴다
    where k.d <= 1000 or k.min_d > 1000
    group by e.id
  ),
  flow_idw as (
    select e.id, sum(k.flow_n * k.w) / sum(k.w) flow_n
    from edges e
    cross join lateral (
      select v.flow_n, 1.0 / greatest(st_distance(v.g, e.g), 1) ^ 2 w
      from flow v
      where v.flow_n is not null
      order by v.g <-> e.g
      limit 5
    ) k
    group by e.id
  ),
  -- ───── 4) 혼잡 장소 영역 ─────
  area_crowd as (
    select e.id, max((c.level - 1) / 3.0) crowd_n
    from edges e
    join hotspots h on st_intersects(h.geom, e.mid)
    join latest_congestion c on c.area_cd = h.area_cd and c.observed_at > now() - interval '2 hours'
    group by e.id
  ),
  result as (
    select e.id edge_id,
           coalesce(i.noise_n, 0) noise_n,
           coalesce(i.light_n, 0) light_n,
           least(greatest(coalesce(a.crowd_n, f.flow_n, 0), 0), 1) crowd_n,
           case
             when i.nearest_m <= 200 and i.nearest_age_min <= 60 then 'high'
             when i.nearest_m <= 500 and i.nearest_age_min <= 120 then 'mid'
             else 'low'
           end confidence
    from edges e
    left join env_idw i on i.id = e.id
    left join flow_idw f on f.id = e.id
    left join area_crowd a on a.id = e.id
  )
  insert into edge_exposure (edge_id, noise_n, light_n, crowd_n, confidence, computed_at)
  select edge_id, noise_n, light_n, crowd_n, confidence, now() from result
  on conflict (edge_id) do update set
    noise_n = excluded.noise_n,
    light_n = excluded.light_n,
    crowd_n = excluded.crowd_n,
    confidence = excluded.confidence,
    computed_at = excluded.computed_at;

  get diagnostics updated = row_count;
  return updated;
end;
$$;

revoke all on function public.refresh_edge_exposure() from public, anon, authenticated;
grant execute on function public.refresh_edge_exposure() to service_role;
