-- 감각 노출값의 센서 부분을 도로 구간마다가 아니라 250m 격자 칸마다 계산한다(서울 전체 확장 준비).
-- 구간마다 계산하면 10분 갱신이 마포 1.7만 구간에 약 25초, 서울 전체(약 25배)면 약 10분이 걸려 그동안 앱 요청이 시간 초과로 실패하고,
-- 구간별 센서 가중치(edge_sensor_weight)만 서울 기준 수백 MB가 된다.
-- S-DoT 센서는 수백 m 간격이라 이웃한 길끼리 IDW 값이 거의 같다. 그래서 센서 IDW는 칸 중심에서 한 번만 계산하고,
-- 도로 종류 기본값(edge_road_prior)과 혼잡 장소(edge_area)는 지금처럼 구간별로 섞는다.
-- edge_exposure는 컬럼이 같은 뷰가 되므로 quiet_routes · map_layers · place_exposure는 바꾸지 않는다.
-- 정규화 · IDW(1km/5개) · 신뢰도 · 섞는 비율은 20261031150000_precompute_edge_weights.sql과 같고, 거리 기준만 "구간 중앙점" → "칸 중심"이다.
--
-- 마포 비교(같은 시점 데이터, 도로 17,076개): 갱신 25초 → 0.6초, 부하 평균 차이 0.012(95%가 0.039 이하), 등급 일치 97%,
-- 역·공원 36쌍 경로: 최단은 모두 같고 균형·가장 조용한 경로는 평균 92% 겹침. 길 찾기는 0.13초 → 0.20초.
--
-- 도로망 · 센서 · 혼잡 장소가 바뀌면 rebuild_edge_weights()를 다시 부른다(이름은 그대로 두고 칸 기준으로 다시 만든다).

-- ───── 격자 ─────
create table public.grid_cells (
  cell_id bigint primary key,           -- i * 100000 + j. EPSG:5179(미터)에서 i = floor(x / 칸크기), j = floor(y / 칸크기)
  geom    geometry(Polygon, 5179) not null,
  center  geometry(Point, 5179) not null
);

-- 구간 중앙점이 들어 있는 칸
create table public.edge_cell (
  edge_id bigint primary key references public.road_edges (id) on delete cascade,
  cell_id bigint not null references public.grid_cells (cell_id) on delete cascade
);
create index edge_cell_cell_idx on public.edge_cell (cell_id);

-- 칸 중심에서 가까운 센서와 IDW 가중치
create table public.cell_sensor_weight (
  cell_id   bigint not null references public.grid_cells (cell_id) on delete cascade,
  sensor_id text not null references public.sensors (sensor_id) on delete cascade,
  kind      text not null,              -- env · floating
  d         real not null,              -- 칸 중심에서 센서까지 거리(m)
  w         double precision not null,  -- 1 / d²
  primary key (cell_id, sensor_id)
);
create index cell_sensor_weight_sensor_idx on public.cell_sensor_weight (sensor_id);

-- 칸별 센서 IDW 결과(도로 종류 기본값과 섞기 전). 10분마다 refresh_edge_exposure()가 채운다
create table public.cell_exposure (
  cell_id         bigint primary key references public.grid_cells (cell_id) on delete cascade,
  noise_n         real,
  light_n         real,
  flow_n          real,
  nearest_m       real,  -- 가장 가까운 환경 센서까지 거리
  nearest_age_min real,  -- 그 센서 값이 몇 분 전 측정인지(과거 평균으로 채웠으면 null)
  computed_at     timestamptz not null default now()
);

-- 혼잡 장소별 현재 인파(최근 2시간 안에 관측된 곳만)
create table public.area_crowd (
  area_cd text primary key references public.hotspots (area_cd) on delete cascade,
  crowd_n real not null
);

alter table public.grid_cells         enable row level security;  -- 정책 없음: 내부 계산용
alter table public.edge_cell          enable row level security;
alter table public.cell_sensor_weight enable row level security;
alter table public.cell_exposure      enable row level security;
alter table public.area_crowd         enable row level security;

-- ───── 구간별 테이블 정리 ─────
drop function if exists public.rebuild_edge_weights();
drop table public.edge_sensor_weight;
drop table public.edge_exposure;

-- ───── 고정값 다시 만들기 (도로망 · 센서 · 혼잡 장소가 바뀔 때만) ─────
create or replace function public.rebuild_edge_weights(cell_m double precision default 250)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n integer;
begin
  delete from grid_cells;  -- edge_cell · cell_sensor_weight · cell_exposure는 cascade로 같이 지워진다
  delete from edge_area;

  insert into grid_cells (cell_id, geom, center)
  select i * 100000 + j,
         ST_MakeEnvelope(i * cell_m, j * cell_m, (i + 1) * cell_m, (j + 1) * cell_m, 5179),
         ST_SetSRID(ST_MakePoint((i + 0.5) * cell_m, (j + 0.5) * cell_m), 5179)
  from (
    select distinct floor(ST_X(g) / cell_m)::bigint i, floor(ST_Y(g) / cell_m)::bigint j
    from (select ST_Transform(ST_LineInterpolatePoint(e.geom, 0.5), 5179) g from road_edges e where e.is_walkable) m
  ) ij;
  get diagnostics n = row_count;

  insert into edge_cell (edge_id, cell_id)
  select id, floor(ST_X(g) / cell_m)::bigint * 100000 + floor(ST_Y(g) / cell_m)::bigint
  from (select e.id, ST_Transform(ST_LineInterpolatePoint(e.geom, 0.5), 5179) g from road_edges e where e.is_walkable) m;

  with s as (
    select sensor_id, kind, ST_Transform(geom, 5179) g from sensors
  ),
  nearest as (
    select c.cell_id, k.sensor_id, k.kind, k.d, min(k.d) over (partition by c.cell_id, k.kind) min_d
    from grid_cells c
    cross join lateral (
      (select s.sensor_id, s.kind, ST_Distance(s.g, c.center) d from s where s.kind = 'env' order by s.g <-> c.center limit 5)
      union all
      (select s.sensor_id, s.kind, ST_Distance(s.g, c.center) d from s where s.kind = 'floating' order by s.g <-> c.center limit 5)
    ) k
  )
  insert into cell_sensor_weight (cell_id, sensor_id, kind, d, w)
  select cell_id, sensor_id, kind, d, 1.0 / greatest(d, 1) ^ 2
  from nearest
  -- 환경 센서는 1km 안만 쓰되, 하나도 없으면 가장 가까운 5개를 그대로 쓴다. 유동인구는 가까운 5개
  where kind = 'floating' or d <= 1000 or min_d > 1000;

  insert into edge_area (edge_id, area_cd)
  select e.id, h.area_cd
  from road_edges e
  join hotspots h on ST_Intersects(h.geom, ST_LineInterpolatePoint(e.geom, 0.5))
  where e.is_walkable;

  return n;
end;
$$;

-- ───── 10분마다: 칸별 센서값 · 혼잡 장소 인파 ─────
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
  -- ───── 3) 미리 계산한 칸 가중치로 IDW ─────
  env_idw as (
    select w.cell_id,
           sum(v.noise_n * w.w) / sum(w.w) noise_n,
           sum(v.light_n * w.w) / sum(w.w) light_n,
           min(w.d) nearest_m,
           (array_agg(v.age_min order by w.d))[1] nearest_age_min
    from cell_sensor_weight w
    join env v using (sensor_id)
    group by w.cell_id
  ),
  flow_idw as (
    select w.cell_id, sum(v.flow_n * w.w) / sum(w.w) flow_n
    from cell_sensor_weight w
    join flow v using (sensor_id)
    where v.flow_n is not null
    group by w.cell_id
  ),
  upserted as (
    insert into cell_exposure (cell_id, noise_n, light_n, flow_n, nearest_m, nearest_age_min, computed_at)
    select c.cell_id, i.noise_n, i.light_n, f.flow_n, i.nearest_m, i.nearest_age_min, now()
    from grid_cells c
    left join env_idw i using (cell_id)
    left join flow_idw f using (cell_id)
    on conflict (cell_id) do update set
      noise_n = excluded.noise_n,
      light_n = excluded.light_n,
      flow_n = excluded.flow_n,
      nearest_m = excluded.nearest_m,
      nearest_age_min = excluded.nearest_age_min,
      computed_at = excluded.computed_at
    returning 1
  )
  select count(*) into updated from upserted;

  -- ───── 4) 혼잡 장소 인파 ─────
  delete from area_crowd;
  insert into area_crowd (area_cd, crowd_n)
  select area_cd, (level - 1) / 3.0 from latest_congestion where observed_at > now() - interval '2 hours';

  return updated;
end;
$$;

-- ───── 구간별 노출값: 칸 값 + 도로 종류 기본값 + 혼잡 장소를 읽을 때 섞는다 ─────
-- 컬럼은 예전 edge_exposure 테이블과 같다. 읽는 쪽 RPC는 모두 security definer라 RLS와 상관없이 읽는다
create view public.edge_exposure with (security_invoker = true) as
select e.id edge_id,
       least(greatest(0.5 * coalesce(c.noise_n, 0) + 0.5 * coalesce(p.noise, 0.4), 0), 1)::real noise_n,
       least(greatest(0.5 * coalesce(c.light_n, 0) + 0.5 * coalesce(p.light, 0.4), 0), 1)::real light_n,
       least(greatest(case when a.crowd_n is not null then 0.7 * a.crowd_n + 0.3 * coalesce(p.crowd, 0.4)
                           else 0.5 * coalesce(c.flow_n, 0) + 0.5 * coalesce(p.crowd, 0.4) end, 0), 1)::real crowd_n,
       case
         when c.nearest_m <= 200 and c.nearest_age_min <= 60 then 'high'
         when c.nearest_m <= 500 and c.nearest_age_min <= 120 then 'mid'
         else 'low'
       end confidence,
       c.computed_at
from road_edges e
join edge_cell ec on ec.edge_id = e.id
left join cell_exposure c on c.cell_id = ec.cell_id
left join edge_road_prior p on p.edge_id = e.id
left join (
  select ea.edge_id, max(ac.crowd_n) crowd_n
  from edge_area ea join area_crowd ac using (area_cd)
  group by ea.edge_id
) a on a.edge_id = e.id
where e.is_walkable;

revoke all on function public.rebuild_edge_weights(double precision) from public, anon, authenticated;
revoke all on function public.refresh_edge_exposure() from public, anon, authenticated;
grant execute on function public.refresh_edge_exposure() to service_role;

select public.rebuild_edge_weights();
select public.refresh_edge_exposure();
delete from public.map_layers_cache;  -- 예전 구간값으로 만든 지도 캐시
