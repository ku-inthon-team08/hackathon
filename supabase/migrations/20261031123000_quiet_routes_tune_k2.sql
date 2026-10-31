-- quiet_routes 튜닝 2: k를 키우면(0 / 3 / 10) balanced도 가장 조용한 길까지 가 버려 quietest와 겹치는 경우가 늘었다.
-- balanced는 낮추고 quietest는 되돌려 k = 0 / 1.5 / 6. 탐색 범위 여유(40%, 최소 약 450m)는 유지한다.

create or replace function public.quiet_routes(
  from_lat double precision,
  from_lng double precision,
  to_lat double precision,
  to_lng double precision,
  sens_sound integer default 2,
  sens_light integer default 2,
  sens_crowd integer default 2,
  walk_mpm double precision default 75
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  p_from geometry := ST_SetSRID(ST_MakePoint(from_lng, from_lat), 4326);
  p_to   geometry := ST_SetSRID(ST_MakePoint(to_lng, to_lat), 4326);
  n_from bigint;
  n_to   bigint;
  d_from double precision;
  d_to   double precision;
  bbox   geometry;
  result jsonb;
begin
  -- 1) 출발·도착을 가장 가까운 보행 도로 노드에 붙인다
  select n.id, ST_Distance(n.geom::geography, p_from::geography) into n_from, d_from
  from road_nodes n
  where exists (select 1 from road_edges e where e.source = n.id and e.is_walkable)
  order by n.geom <-> p_from limit 1;

  select n.id, ST_Distance(n.geom::geography, p_to::geography) into n_to, d_to
  from road_nodes n
  where exists (select 1 from road_edges e where e.source = n.id and e.is_walkable)
  order by n.geom <-> p_to limit 1;

  if n_from is null or n_to is null or d_from > 500 or d_to > 500 then
    raise exception using errcode = 'P0001', message = 'OUT_OF_COVERAGE',
      detail = '출발지나 도착지가 시연 지역(홍대입구·연남·합정) 밖이에요';
  end if;

  -- 2) 탐색 범위: 두 점을 감싼 사각형에 거리의 30%(최소 약 300m) 여유
  bbox := ST_Expand(ST_Envelope(ST_Collect(p_from, p_to)),
                    greatest(0.004, 0.4 * ST_Distance(p_from, p_to)));

  -- 3) k마다 경로 찾기 → 4) 구간 선을 진행 방향으로 이어 붙이기 → 5) 수치 계산
  with ks (kind, label, k) as (
    values ('shortest', '최단', 0), ('balanced', '균형', 1.5), ('quietest', '가장 조용한', 6)
  ),
  steps as (
    select ks.kind, ks.label, ks.k, d.seq,
           case when e.source = d.node then e.geom else ST_Reverse(e.geom) end as geom,
           e.length_m,
           public.sensory_load(coalesce(x.noise_n, 0.5), coalesce(x.light_n, 0.5), coalesce(x.crowd_n, 0.5),
                               sens_sound, sens_light, sens_crowd) as s
    from ks
    cross join lateral pgr_dijkstra(
      format($q$
        select e.id, e.source, e.target,
               e.length_m * (1 + %s * public.sensory_load(
                 coalesce(x.noise_n, 0.5), coalesce(x.light_n, 0.5), coalesce(x.crowd_n, 0.5), %s, %s, %s)) as cost
        from public.road_edges e
        left join public.edge_exposure x on x.edge_id = e.id
        where e.is_walkable and e.geom && ST_GeomFromText(%L, 4326)
      $q$, ks.k, sens_sound, sens_light, sens_crowd, ST_AsText(bbox)),
      n_from, n_to, directed := false
    ) d
    join road_edges e on e.id = d.edge
    left join edge_exposure x on x.edge_id = e.id
  ),
  routes as (
    select kind, label, k,
           sum(length_m) as dist_m,
           sum(s * length_m) as exposure,
           ST_RemoveRepeatedPoints(ST_MakeLine(geom order by seq)) as line
    from steps
    group by kind, label, k
  ),
  base as (
    select dist_m as base_dist, exposure as base_exposure from routes where kind = 'shortest'
  )
  select jsonb_build_object(
    'mock', false,
    'routes', jsonb_agg(jsonb_build_object(
      'kind',                r.kind,
      'label',               r.label,
      'distance_m',          round(r.dist_m),
      'walk_min',            ceil(r.dist_m / walk_mpm)::integer,
      'avg_load',            round((r.exposure / nullif(r.dist_m, 0))::numeric, 2),
      'load_level',          public.load_level(r.exposure / nullif(r.dist_m, 0)),
      'extra_distance_pct',  round(((r.dist_m / nullif(b.base_dist, 0) - 1) * 100)::numeric),
      'exposure_change_pct', round(((r.exposure / nullif(b.base_exposure, 0) - 1) * 100)::numeric),
      'geometry',            ST_AsGeoJSON(r.line, 6)::jsonb
    ) order by r.k)
  )
  into result
  from routes r cross join base b;

  if result is null then
    raise exception using errcode = 'P0001', message = 'NO_ROUTE',
      detail = '두 지점을 잇는 보행 경로를 찾지 못했어요';
  end if;
  return result;
end;
$$;

grant execute on function public.quiet_routes(double precision, double precision, double precision, double precision,
  integer, integer, integer, double precision) to anon, authenticated;
