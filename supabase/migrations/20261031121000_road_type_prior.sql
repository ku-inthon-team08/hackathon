-- 도로 종류 기본값(edge_road_prior)을 감각 노출값에 섞는다.
-- S-DoT 센서는 수백 m 간격이라 IDW 값이 이웃한 길끼리 거의 같아서, 큰길과 골목·공원길의 차이가 경로 선택에 잘 드러나지 않았다.
-- 큰길(trunk·primary·secondary)은 시끄럽고 밝고, 골목·공원길(path·track·steps)은 조용하다는 기본값을 구간마다 정해 두고
--   소음·조도 = 0.5 × 센서 IDW + 0.5 × 도로 기본값
--   인파      = 혼잡 장소 영역 안이면 0.7 × 혼잡 등급 + 0.3 × 기본값, 밖이면 0.5 × 유동인구 IDW + 0.5 × 기본값
-- 으로 섞는다. OSM에서 큰길 옆 보도는 footway로 따로 그려져 있어서, 큰길에서 20m 안의 구간은 그 큰길의 기본값(× 0.9)을 따른다.
-- 1)~5) 단계는 20261031111000_refresh_edge_exposure_fast.sql과 같다.

-- ───── 도로 종류 기본값 (도로망이 바뀔 때만 다시 계산) ─────
create table if not exists public.edge_road_prior (
  edge_id bigint primary key references public.road_edges (id) on delete cascade,
  noise   real not null check (noise between 0 and 1),
  light   real not null check (light between 0 and 1),
  crowd   real not null check (crowd between 0 and 1)
);
alter table public.edge_road_prior enable row level security;  -- 정책 없음: 앱은 edge_exposure만 읽는다

create or replace function public.road_type_prior(highway text, out noise real, out light real, out crowd real)
language sql immutable
set search_path = ''
as $$
  -- highway가 "['footway', 'steps']"처럼 목록 문자열일 수 있어 포함 여부로 본다
  select * from (values (
    case
      when highway ~ 'trunk|primary|busway' then 0.9  when highway ~ 'secondary' then 0.75
      when highway ~ 'tertiary' then 0.6              when highway ~ 'path|track|steps' then 0.15
      when highway ~ 'footway|pedestrian|corridor' then 0.3 else 0.35 end,
    case
      when highway ~ 'trunk|primary|busway' then 0.8  when highway ~ 'secondary' then 0.7
      when highway ~ 'tertiary' then 0.6              when highway ~ 'path|track|steps' then 0.2
      else 0.4 end,
    case
      when highway ~ 'trunk|primary|busway' then 0.6  when highway ~ 'secondary' then 0.55
      when highway ~ 'tertiary' then 0.5              when highway ~ 'path|track|steps' then 0.15
      when highway ~ 'footway|pedestrian|living_street' then 0.45 else 0.35 end
  )) v(noise, light, crowd)
$$;

create or replace function public.refresh_edge_road_prior()
returns integer
language sql
security definer
set search_path = public, extensions
as $$
  with own as (
    select e.id, e.geom, p.*
    from road_edges e, road_type_prior(e.highway) p
  ),
  major as (
    select id, geom, noise, light, crowd from own where noise >= 0.75
  ),
  near_major as (
    select o.id, max(m.noise) * 0.9 noise, max(m.light) * 0.9 light, max(m.crowd) * 0.9 crowd
    from own o
    join major m on m.id <> o.id and ST_DWithin(m.geom, ST_LineInterpolatePoint(o.geom, 0.5), 0.0002)  -- 약 20m
    group by o.id
  ),
  upserted as (
    insert into edge_road_prior (edge_id, noise, light, crowd)
    select o.id,
           greatest(o.noise, coalesce(n.noise, 0)),
           greatest(o.light, coalesce(n.light, 0)),
           greatest(o.crowd, coalesce(n.crowd, 0))
    from own o left join near_major n on n.id = o.id
    on conflict (edge_id) do update set noise = excluded.noise, light = excluded.light, crowd = excluded.crowd
    returning 1
  )
  select count(*)::integer from upserted
$$;

revoke all on function public.refresh_edge_road_prior() from public, anon, authenticated;
select public.refresh_edge_road_prior();

-- ───── 감각 노출값 계산 (6단계 추가) ─────
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
  ),
  -- ───── 6) 도로 종류 기본값과 섞기 ─────
  blended as (
    select r.edge_id,
           least(greatest(0.5 * r.noise_n + 0.5 * coalesce(p.noise, 0.4), 0), 1) noise_n,
           least(greatest(0.5 * r.light_n + 0.5 * coalesce(p.light, 0.4), 0), 1) light_n,
           least(greatest(case when a.id is not null then 0.7 * r.crowd_n + 0.3 * coalesce(p.crowd, 0.4)
                               else 0.5 * r.crowd_n + 0.5 * coalesce(p.crowd, 0.4) end, 0), 1) crowd_n,
           r.confidence
    from result r
    left join edge_road_prior p on p.edge_id = r.edge_id
    left join area_crowd a on a.id = r.edge_id
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

revoke all on function public.refresh_edge_exposure() from public, anon, authenticated;
grant execute on function public.refresh_edge_exposure() to service_role;

-- 새 값으로 바로 한 번 다시 계산 (이후는 pg_cron이 10분마다)
select public.refresh_edge_exposure();
