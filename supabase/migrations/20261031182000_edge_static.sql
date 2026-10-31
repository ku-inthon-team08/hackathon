-- 서울 전체(구간 25만 개)에서 edge_exposure를 읽는 RPC가 느려지는 문제를 고치고, 도로망 교체를 빠르게 한다.
--
-- 1) edge_exposure 뷰가 road_edges · edge_cell · edge_road_prior · 혼잡 장소 집계를 매번 조인해서, 범위 안 몇천 개 구간만
--    필요한 quiet_routes · map_layers · place_exposure도 25만 행 전체를 조인했다. 서울로 바꾸는 트랜잭션 안에서
--    길찾기 점검 5개가 10분이 넘도록 끝나지 않아 취소했고, 도로망은 마포로 그대로 남았다.
--    도로망을 다시 만들 때만 바뀌는 구간별 값(칸 · 도로 종류 기본값 · 속한 혼잡 장소)을 edge_static 한 테이블에 모으고,
--    뷰는 edge_static에 칸 값(cell_exposure)과 혼잡 장소 인파(area_crowd)만 붙인다. 뷰의 컬럼과 계산식은 그대로다.
-- 2) replace_road_network: 25만 개 구간을 한 줄씩 넣으며 공간 인덱스를 갱신하는 데 무료 플랜에서 9분이 걸렸다.
--    TRUNCATE로 비우고, 보조 인덱스는 지웠다가 다 넣은 뒤 한 번에 다시 만든다. 그동안 앱은 도로망을 읽지 못하고 기다린다(수 분).

-- ───── 1) 구간별 고정값 ─────
create table public.edge_static (
  edge_id  bigint primary key references public.road_edges (id) on delete cascade,
  cell_id  bigint not null references public.grid_cells (cell_id) on delete cascade,
  noise    real not null,  -- 도로 종류 기본값(edge_road_prior, 없으면 0.4)
  light    real not null,
  crowd    real not null,
  area_cds text[]          -- 중앙점이 들어 있는 혼잡 장소(edge_area). 대부분 null
);
alter table public.edge_static enable row level security;  -- 정책 없음: security definer RPC가 edge_exposure 뷰로 읽는다

-- edge_cell(보행 가능 구간만) · edge_road_prior · edge_area에서 만든다. rebuild_edge_weights() 끝에서 부른다
create or replace function public.rebuild_edge_static()
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  n integer;
begin
  delete from edge_static;
  insert into edge_static (edge_id, cell_id, noise, light, crowd, area_cds)
  select ec.edge_id, ec.cell_id, coalesce(p.noise, 0.4), coalesce(p.light, 0.4), coalesce(p.crowd, 0.4), a.area_cds
  from edge_cell ec
  left join edge_road_prior p on p.edge_id = ec.edge_id
  left join (select edge_id, array_agg(area_cd order by area_cd) area_cds from edge_area group by edge_id) a
    on a.edge_id = ec.edge_id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.rebuild_edge_static() from public, anon, authenticated;

-- ───── 뷰: edge_static + 칸 값 + 혼잡 장소 인파. 컬럼 · 계산식은 20261031160000_grid_exposure.sql과 같다 ─────
create or replace view public.edge_exposure with (security_invoker = true) as
select s.edge_id,
       least(greatest(0.5 * coalesce(c.noise_n, 0) + 0.5 * s.noise, 0), 1)::real noise_n,
       least(greatest(0.5 * coalesce(c.light_n, 0) + 0.5 * s.light, 0), 1)::real light_n,
       least(greatest(case when a.crowd_n is not null then 0.7 * a.crowd_n + 0.3 * s.crowd
                           else 0.5 * coalesce(c.flow_n, 0) + 0.5 * s.crowd end, 0), 1)::real crowd_n,
       case
         when c.nearest_m <= 200 and c.nearest_age_min <= 60 then 'high'
         when c.nearest_m <= 500 and c.nearest_age_min <= 120 then 'mid'
         else 'low'
       end confidence,
       c.computed_at
from edge_static s
left join cell_exposure c on c.cell_id = s.cell_id
-- 혼잡 장소 안의 구간만 인파를 찾는다(나머지는 바로 null)
cross join lateral (
  select case when s.area_cds is null then null::real
              else (select max(ac.crowd_n) from area_crowd ac where ac.area_cd = any (s.area_cds)) end crowd_n
) a;

-- ───── rebuild_edge_weights: 끝에 edge_static을 다시 만든다(나머지는 20261031180000_seoul_road_network.sql과 같다) ─────
create or replace function public.rebuild_edge_weights(cell_m double precision default 250)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  n integer;
begin
  delete from grid_cells;  -- edge_cell · cell_sensor_weight · cell_exposure · edge_static은 cascade로 같이 지워진다
  delete from edge_area;

  -- 구간 중앙점(미터 좌표)은 칸 만들기와 구간 연결에 두 번 쓰이므로 한 번만 계산한다
  drop table if exists pg_temp.rebuild_mid;
  create temp table rebuild_mid on commit drop as
  select e.id, ST_Transform(ST_LineInterpolatePoint(e.geom, 0.5), 5179) g
  from road_edges e
  where e.is_walkable;

  insert into grid_cells (cell_id, geom, center)
  select i * 100000 + j,
         ST_MakeEnvelope(i * cell_m, j * cell_m, (i + 1) * cell_m, (j + 1) * cell_m, 5179),
         ST_SetSRID(ST_MakePoint((i + 0.5) * cell_m, (j + 0.5) * cell_m), 5179)
  from (select distinct floor(ST_X(g) / cell_m)::bigint i, floor(ST_Y(g) / cell_m)::bigint j from pg_temp.rebuild_mid) ij;
  get diagnostics n = row_count;

  insert into edge_cell (edge_id, cell_id)
  select id, floor(ST_X(g) / cell_m)::bigint * 100000 + floor(ST_Y(g) / cell_m)::bigint
  from pg_temp.rebuild_mid;

  -- 센서를 미터 좌표로 옮겨 공간 인덱스를 만들고, 칸마다 가까운 5개를 인덱스로 찾는다
  drop table if exists pg_temp.rebuild_sensor;
  create temp table rebuild_sensor on commit drop as
  select sensor_id, kind, ST_Transform(geom, 5179) g from sensors;
  create index on pg_temp.rebuild_sensor using gist (g);
  analyze pg_temp.rebuild_sensor;

  with nearest as (
    select c.cell_id, k.sensor_id, k.kind, k.d, min(k.d) over (partition by c.cell_id, k.kind) min_d
    from grid_cells c
    cross join lateral (
      (select s.sensor_id, s.kind, ST_Distance(s.g, c.center) d
       from pg_temp.rebuild_sensor s where s.kind = 'env' order by s.g <-> c.center limit 5)
      union all
      (select s.sensor_id, s.kind, ST_Distance(s.g, c.center) d
       from pg_temp.rebuild_sensor s where s.kind = 'floating' order by s.g <-> c.center limit 5)
    ) k
  )
  insert into cell_sensor_weight (cell_id, sensor_id, kind, d, w)
  select cell_id, sensor_id, kind, d, 1.0 / greatest(d, 1) ^ 2
  from nearest
  -- 환경 센서는 1km 안만 쓰되, 하나도 없으면 가장 가까운 5개를 그대로 쓴다. 유동인구는 가까운 5개
  where kind = 'floating' or d <= 1000 or min_d > 1000;

  -- 혼잡 장소 영역 안에 중앙점이 있는 구간. 영역의 사각형으로 도로 공간 인덱스를 먼저 거른다
  insert into edge_area (edge_id, area_cd)
  select e.id, h.area_cd
  from hotspots h
  join road_edges e on e.geom && h.geom and ST_Intersects(h.geom, ST_LineInterpolatePoint(e.geom, 0.5))
  where e.is_walkable;

  perform rebuild_edge_static();

  analyze grid_cells;
  analyze edge_cell;
  analyze cell_sensor_weight;
  analyze edge_area;
  analyze edge_static;
  return n;
end;
$$;

revoke all on function public.rebuild_edge_weights(double precision) from public, anon, authenticated;

-- ───── 2) 도로망 통째로 바꾸기: TRUNCATE + 인덱스를 다 넣은 뒤 한 번에 ─────
-- CSV 형식과 사용법은 20261031180000_seoul_road_network.sql과 같다.
-- TRUNCATE와 인덱스 삭제는 끝날 때까지 도로망 테이블을 잠그므로 그동안 앱 요청은 기다리다 시간 초과로 실패한다.
create or replace function public.replace_road_network(nodes_csv text, edges_csv text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  started timestamptz := clock_timestamp();
  t timestamptz := clock_timestamp();
  took jsonb := '{}';
  n_lines bigint;
  e_lines bigint;
  n_rows bigint;
  e_rows bigint;
begin
  if split_part(nodes_csv, E'\n', 1) !~ '^id,osm_id,geom\r?$'
     or split_part(edges_csv, E'\n', 1) !~ '^id,source,target,length_m,highway,geom\r?$' then
    raise exception 'CSV 머리줄이 build_graph.py 형식과 다릅니다';
  end if;

  -- 도로망과 구간별 파생 테이블(edge_cell · edge_road_prior · edge_area · edge_static)을 비운다. 실패하면 되돌아간다
  truncate road_edges, road_nodes, grid_cells cascade;
  -- 보조 인덱스는 다 넣은 뒤 한 번에 만든다. 기본키는 외래키가 쓰므로 둔다
  drop index road_edges_geom_idx, road_edges_source_idx, road_edges_target_idx, road_edges_walkable_idx, road_nodes_geom_idx;
  took := took || jsonb_build_object('truncate', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  select count(*) into n_lines
  from regexp_split_to_table(nodes_csv, E'\n') with ordinality r(line, i)
  where i > 1 and rtrim(line, E'\r') <> '';
  insert into road_nodes (id, osm_id, geom)
  select m[1]::bigint, nullif(m[2], '')::bigint, m[3]::geometry
  from (
    select regexp_match(rtrim(line, E'\r'), '^(\d+),(\d*),"?(SRID=4326;POINT ?\([^)]*\))"?$') m
    from regexp_split_to_table(nodes_csv, E'\n') with ordinality r(line, i)
    where i > 1 and rtrim(line, E'\r') <> ''
  ) p
  where m is not null;
  get diagnostics n_rows = row_count;
  if n_rows <> n_lines then
    raise exception '노드 CSV % 줄 중 % 줄만 읽었습니다', n_lines, n_rows;
  end if;

  select count(*) into e_lines
  from regexp_split_to_table(edges_csv, E'\n') with ordinality r(line, i)
  where i > 1 and rtrim(line, E'\r') <> '';
  -- highway는 "footway,steps"처럼 쉼표가 있으면 따옴표로 감싸여 있다
  insert into road_edges (id, source, target, length_m, highway, geom)
  select m[1]::bigint, m[2]::bigint, m[3]::bigint, m[4]::double precision, nullif(coalesce(m[5], m[6]), ''), m[7]::geometry
  from (
    select regexp_match(rtrim(line, E'\r'),
             '^(\d+),(-?\d+),(-?\d+),([0-9.eE+-]+),(?:"([^"]*)"|([^,"]*)),"?(SRID=4326;LINESTRING ?\([^)]*\))"?$') m
    from regexp_split_to_table(edges_csv, E'\n') with ordinality r(line, i)
    where i > 1 and rtrim(line, E'\r') <> ''
  ) p
  where m is not null;
  get diagnostics e_rows = row_count;
  if e_rows <> e_lines then
    raise exception '구간 CSV % 줄 중 % 줄만 읽었습니다', e_lines, e_rows;
  end if;
  took := took || jsonb_build_object('insert', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  create index road_nodes_geom_idx on road_nodes using gist (geom);
  create index road_edges_geom_idx on road_edges using gist (geom);
  create index road_edges_source_idx on road_edges (source);
  create index road_edges_target_idx on road_edges (target);
  create index road_edges_walkable_idx on road_edges (id) where is_walkable;
  analyze road_nodes;
  analyze road_edges;
  took := took || jsonb_build_object('index', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  perform refresh_edge_road_prior();
  analyze edge_road_prior;
  took := took || jsonb_build_object('road_prior', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  perform rebuild_edge_weights();  -- 칸 · 센서 가중치 · 혼잡 장소 · edge_static
  took := took || jsonb_build_object('edge_weights', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  perform refresh_edge_exposure();
  analyze cell_exposure;
  took := took || jsonb_build_object('exposure', round(extract(epoch from clock_timestamp() - t)::numeric, 1));

  delete from map_layers_cache;  -- 예전 구간 id로 만든 지도 캐시

  return jsonb_build_object(
    'nodes', n_rows,
    'edges', e_rows,
    'cells', (select count(*) from grid_cells),
    'seconds', took || jsonb_build_object('total', round(extract(epoch from clock_timestamp() - started)::numeric, 1))
  );
end;
$$;

revoke all on function public.replace_road_network(text, text) from public, anon, authenticated;

-- 지금 도로망(마포)으로 edge_static을 채운다
select public.rebuild_edge_static();
analyze public.edge_static;
