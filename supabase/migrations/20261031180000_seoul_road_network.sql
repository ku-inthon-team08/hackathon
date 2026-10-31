-- 서울 전체 도로망(구간 약 25만 개, 마포의 약 15배)을 다룰 수 있게 도로망 관련 함수를 고친다.
--
-- 1) refresh_edge_road_prior: 큰길 옆 20m 안의 구간을 찾을 때 CTE끼리 비교해서 공간 인덱스를 못 썼다.
--    마포 22초, 서울은 3분이 넘어도 끝나지 않았다. road_edges의 공간 인덱스로 큰길을 찾는다.
--    마포 17,076개 결과가 예전 함수와 같다(차이 0). 마포 22초 → 3초.
-- 2) rebuild_edge_weights: 혼잡 장소 영역과 도로를 비교할 때와 칸마다 가까운 센서를 찾을 때 인덱스를 못 썼다.
--    중앙점은 한 번만 계산하고, 센서는 미터 좌표 임시 테이블에 인덱스를 만들어 찾는다. 계산 규칙은 그대로다.
-- 3) replace_road_network: build_graph.py가 만든 CSV 두 개를 받아 도로망을 한 트랜잭션에서 통째로 바꾸고
--    파생 데이터(도로 종류 기본값 · 칸 · 센서 가중치 · 혼잡 장소 · 노출값)를 다시 만든다. 하나라도 실패하면 전부 되돌아간다.
--    REST(1000행 배치, 8초 제한)로는 서울 규모 업로드와 --replace의 DELETE가 시간 초과로 실패했다.
--    구간 id는 CSV마다 1부터 다시 매겨지므로 덧붙이지 않고 통째로 바꾼다. 서울 도로망에 마포가 들어 있다.
--    DELETE로 지우므로 앱은 끝날 때까지 예전 도로망을 그대로 읽는다.
-- 4) map_layers 캐시: 5분만 쓰는 값을 1시간 동안 남겨 두었다. 서울 지도는 응답이 커서 용량(무료 500MB)을 빠르게 쓰므로 10분 지난 값을 지운다.

-- ───── 1) 도로 종류 기본값 ─────
create or replace function public.refresh_edge_road_prior()
returns integer
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  with own as (
    select e.id, p.noise, p.light, p.crowd
    from road_edges e
    cross join lateral road_type_prior(e.highway) p
  ),
  -- 큰길(기본 소음 0.75 이상: trunk · primary · busway · secondary)에서 약 20m 안의 구간은 그 큰길 기본값 × 0.9를 따른다
  near_major as (
    select o.id, max(mp.noise) * 0.9 noise, max(mp.light) * 0.9 light, max(mp.crowd) * 0.9 crowd
    from road_edges o
    join road_edges m on m.id <> o.id and ST_DWithin(m.geom, ST_LineInterpolatePoint(o.geom, 0.5), 0.0002)
    cross join lateral road_type_prior(m.highway) mp
    where mp.noise >= 0.75
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

-- ───── 2) 칸 · 센서 가중치 · 혼잡 장소 (도로망 · 센서 · 혼잡 장소가 바뀔 때만) ─────
create or replace function public.rebuild_edge_weights(cell_m double precision default 250)
returns integer
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  n integer;
begin
  delete from grid_cells;  -- edge_cell · cell_sensor_weight · cell_exposure는 cascade로 같이 지워진다
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

  analyze grid_cells;
  analyze edge_cell;
  analyze cell_sensor_weight;
  analyze edge_area;
  return n;
end;
$$;

revoke all on function public.rebuild_edge_weights(double precision) from public, anon, authenticated;

-- ───── 3) 도로망 통째로 바꾸기 ─────
--   select public.replace_road_network(<seoul_road_nodes.csv 본문>, <seoul_road_edges.csv 본문>);
-- CSV는 build_graph.py 형식 그대로다(노드: id,osm_id,geom / 구간: id,source,target,length_m,highway,geom).
-- 원격 DB에는 CSV를 공개 URL에 두고 pg_net으로 받아 넘긴다(scripts/road_network/import_road_network.sql).
-- 서울 기준 수 분 걸리므로 statement_timeout을 넉넉히 잡고 부른다.
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

  -- 도로망을 동시에 바꾸지 못하게 한다. 앱의 읽기는 막지 않는 잠금이다
  lock table road_nodes, road_edges in share row exclusive mode;

  delete from road_edges;  -- edge_cell · edge_road_prior · edge_area는 cascade로 같이 지워진다
  delete from road_nodes;
  took := took || jsonb_build_object('delete', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
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
  analyze road_nodes;
  analyze road_edges;
  took := took || jsonb_build_object('insert', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  perform refresh_edge_road_prior();
  analyze edge_road_prior;
  took := took || jsonb_build_object('road_prior', round(extract(epoch from clock_timestamp() - t)::numeric, 1));
  t := clock_timestamp();

  perform rebuild_edge_weights();
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

-- ───── 4) 지도 캐시: 5분 안의 값만 쓰므로 10분 지난 값은 지운다 ─────
create or replace function public.map_layers(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision,
  sens_sound integer default 2,
  sens_light integer default 2,
  sens_crowd integer default 2
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  cache_key text := concat_ws(',',
    round(min_lat::numeric, 6), round(min_lng::numeric, 6),
    round(max_lat::numeric, 6), round(max_lng::numeric, 6),
    sens_sound, sens_light, sens_crowd);
  result jsonb;
begin
  select c.body into result
  from map_layers_cache c
  where c.key = cache_key and c.computed_at > now() - interval '5 minutes';
  if found then
    return result;
  end if;

  result := map_layers_compute(min_lat, min_lng, max_lat, max_lng, sens_sound, sens_light, sens_crowd);

  insert into map_layers_cache (key, computed_at, body) values (cache_key, now(), result)
  on conflict (key) do update set computed_at = excluded.computed_at, body = excluded.body;
  delete from map_layers_cache where computed_at < now() - interval '10 minutes';

  return result;
end;
$$;

grant execute on function public.map_layers(double precision, double precision, double precision, double precision,
  integer, integer, integer) to anon, authenticated;
