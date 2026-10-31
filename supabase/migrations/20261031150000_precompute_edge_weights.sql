-- refresh_edge_exposure 속도 개선 2: 한 번에 약 63초가 걸려 10분마다 DB CPU를 거의 다 쓰고,
-- 그동안 들어온 quiet_routes 같은 앱 요청이 3초 시간 제한에 걸려 "경로를 찾지 못했어요"가 났다.
--
-- 센서 위치는 고정이므로 "구간마다 가까운 센서 최대 5개와 IDW 가중치", "구간이 속한 혼잡 장소"를 한 번만 계산해
-- edge_sensor_weight · edge_area에 저장한다. 10분마다는 센서별 현재값을 이 가중치와 조인해 합치기만 한다.
-- 계산 규칙(정규화 · IDW 1km/5개 · 혼잡 장소 · 신뢰도 · 도로 종류 기본값 섞기)은
-- 20261031121000_road_type_prior.sql과 같다. 센서·도로망이 바뀌면 rebuild_edge_weights()를 다시 부른다.

create table if not exists public.edge_sensor_weight (
  edge_id   bigint not null references public.road_edges (id) on delete cascade,
  sensor_id text not null references public.sensors (sensor_id) on delete cascade,
  kind      text not null,              -- env · floating
  d         real not null,              -- 구간 중심에서 센서까지 거리(m)
  w         double precision not null,  -- 1 / d²
  primary key (edge_id, sensor_id)
);
create index if not exists edge_sensor_weight_sensor_idx on public.edge_sensor_weight (sensor_id);

create table if not exists public.edge_area (
  edge_id bigint not null references public.road_edges (id) on delete cascade,
  area_cd text not null references public.hotspots (area_cd) on delete cascade,
  primary key (edge_id, area_cd)
);

alter table public.edge_sensor_weight enable row level security;  -- 정책 없음: 내부 계산용
alter table public.edge_area enable row level security;

create or replace function public.rebuild_edge_weights()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n integer;
begin
  delete from edge_sensor_weight;
  delete from edge_area;

  with edges as (
    select id, mid, st_transform(mid, 5179) g
    from (select e.id, st_lineinterpolatepoint(e.geom, 0.5) mid from road_edges e where e.is_walkable) x
  ),
  s as (
    select sensor_id, kind, st_transform(geom, 5179) g from sensors
  ),
  nearest as (
    select e.id edge_id, k.sensor_id, k.kind, k.d, min(k.d) over (partition by e.id, k.kind) min_d
    from edges e
    cross join lateral (
      (select s.sensor_id, s.kind, st_distance(s.g, e.g) d from s where s.kind = 'env' order by s.g <-> e.g limit 5)
      union all
      (select s.sensor_id, s.kind, st_distance(s.g, e.g) d from s where s.kind = 'floating' order by s.g <-> e.g limit 5)
    ) k
  )
  insert into edge_sensor_weight (edge_id, sensor_id, kind, d, w)
  select edge_id, sensor_id, kind, d, 1.0 / greatest(d, 1) ^ 2
  from nearest
  -- 환경 센서는 1km 안만 쓰되, 하나도 없으면 가장 가까운 5개를 그대로 쓴다. 유동인구는 가까운 5개
  where kind = 'floating' or d <= 1000 or min_d > 1000;
  get diagnostics n = row_count;

  insert into edge_area (edge_id, area_cd)
  select e.id, h.area_cd
  from road_edges e
  join hotspots h on st_intersects(h.geom, st_lineinterpolatepoint(e.geom, 0.5))
  where e.is_walkable;

  return n;
end;
$$;

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
    select s.sensor_id, s.kind,
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
    select sensor_id, age_min,
           least(greatest((noise_db - 40) / 30.0, 0), 1) noise_n,
           percent_rank() over (order by lux) light_n
    from cur
    where kind = 'env' and noise_db is not null and lux is not null
  ),
  flow as (
    select c.sensor_id,
           (select count(*) filter (where h.flow_count <= c.flow_count)::real / nullif(count(*), 0)
            from sensor_obs h where h.sensor_id = c.sensor_id and h.flow_count is not null) flow_n
    from cur c
    where c.kind = 'floating' and c.flow_count is not null
  ),
  -- ───── 3) 미리 계산한 가중치로 IDW ─────
  env_idw as (
    select w.edge_id,
           sum(v.noise_n * w.w) / sum(w.w) noise_n,
           sum(v.light_n * w.w) / sum(w.w) light_n,
           min(w.d) nearest_m,
           (array_agg(v.age_min order by w.d))[1] nearest_age_min
    from edge_sensor_weight w
    join env v using (sensor_id)
    group by w.edge_id
  ),
  flow_idw as (
    select w.edge_id, sum(v.flow_n * w.w) / sum(w.w) flow_n
    from edge_sensor_weight w
    join flow v using (sensor_id)
    where v.flow_n is not null
    group by w.edge_id
  ),
  -- ───── 4) 혼잡 장소 영역 ─────
  area_crowd as (
    select a.edge_id, max((c.level - 1) / 3.0) crowd_n
    from edge_area a
    join latest_congestion c on c.area_cd = a.area_cd and c.observed_at > now() - interval '2 hours'
    group by a.edge_id
  ),
  -- ───── 5) 신뢰도 · 6) 도로 종류 기본값과 섞기 ─────
  result as (
    select e.id edge_id,
           coalesce(i.noise_n, 0) noise_n,
           coalesce(i.light_n, 0) light_n,
           coalesce(a.crowd_n, f.flow_n, 0) crowd_n,
           a.edge_id is not null in_area,
           case
             when i.nearest_m <= 200 and i.nearest_age_min <= 60 then 'high'
             when i.nearest_m <= 500 and i.nearest_age_min <= 120 then 'mid'
             else 'low'
           end confidence
    from road_edges e
    left join env_idw i on i.edge_id = e.id
    left join flow_idw f on f.edge_id = e.id
    left join area_crowd a on a.edge_id = e.id
    where e.is_walkable
  ),
  blended as (
    select r.edge_id,
           least(greatest(0.5 * r.noise_n + 0.5 * coalesce(p.noise, 0.4), 0), 1) noise_n,
           least(greatest(0.5 * r.light_n + 0.5 * coalesce(p.light, 0.4), 0), 1) light_n,
           least(greatest(case when r.in_area then 0.7 * r.crowd_n + 0.3 * coalesce(p.crowd, 0.4)
                               else 0.5 * r.crowd_n + 0.5 * coalesce(p.crowd, 0.4) end, 0), 1) crowd_n,
           r.confidence
    from result r
    left join edge_road_prior p on p.edge_id = r.edge_id
  )
  insert into edge_exposure (edge_id, noise_n, light_n, crowd_n, confidence, computed_at)
  select edge_id, noise_n, light_n, crowd_n, confidence, now() from blended
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

revoke all on function public.rebuild_edge_weights() from public, anon, authenticated;
revoke all on function public.refresh_edge_exposure() from public, anon, authenticated;
grant execute on function public.refresh_edge_exposure() to service_role;

select public.rebuild_edge_weights();
select public.refresh_edge_exposure();
