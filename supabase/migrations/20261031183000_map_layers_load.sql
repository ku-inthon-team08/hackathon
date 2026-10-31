-- 서울 도로망으로 바꾼 뒤 지도 요청이 DB CPU를 다 써서 길찾기 · 쉼터 · 지도 요청이 8초 제한에 걸렸다.
-- FE는 지도 전체 범위(MAP_BOUNDS)를 타일 24개로 나눠 부르고, 한 타일이 6,000개 상한에 닿으면 4조각으로 다시 나눠 부른다(최대 두 번).
-- 마포만 있을 때는 범위 대부분이 비어 있었지만, 서울 도로망에서는 타일마다 도로가 차서 상한에 닿는 타일이 늘었다
-- (지도 요청 1분에 40~77회, 타일 하나 1~3초). FE가 화면 범위만 부르게 바뀌기 전까지 DB를 보호한다.
--   1) 한 번에 돌려주는 도로를 긴 것부터 2,500개로 줄인다. FE의 쪼개기 기준(6,000)보다 작아서 더 쪼개 부르지 않는다.
--      약 1.7km 타일 하나에 2,500개면 촘촘한 동네에서만 짧은 골목·보도 일부가 빠진다
--   2) 범위 안 도로를 길이순으로 먼저 2,500개만 고른 뒤 감각값을 붙인다(전에는 범위 안 전부에 붙인 뒤 골랐다)
--   3) 캐시를 5분 → 10분 쓴다(감각값 갱신 주기와 같다). 20분 지난 값은 지운다
-- 응답 형식은 그대로다.

create or replace function public.map_layers_compute(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision,
  sens_sound integer default 2,
  sens_light integer default 2,
  sens_crowd integer default 2
) returns jsonb
language sql stable
security definer
set search_path = public, extensions
as $$
  with
  view_box as (
    select ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326) as box
  ),
  longest as (
    select e.id, e.geom
    from road_edges e
    cross join view_box v
    where e.is_walkable and e.geom && v.box
    order by e.length_m desc
    limit 2500
  ),
  edges as (
    select e.id,
           ST_Simplify(e.geom, 0.00002) as geom,  -- 약 2m
           x.noise_n, x.light_n, x.crowd_n, x.confidence,
           public.sensory_load(x.noise_n, x.light_n, x.crowd_n, sens_sound, sens_light, sens_crowd) as s
    from longest e
    join edge_exposure x on x.edge_id = e.id
  ),
  latest as (
    select distinct on (o.sensor_id) o.sensor_id, o.observed_at, o.noise_db, o.lux, o.flow_count
    from sensor_obs o
    join sensors s on s.sensor_id = o.sensor_id
    cross join view_box v
    where s.geom && v.box and o.observed_at > now() - interval '3 hours'
    order by o.sensor_id, o.observed_at desc
  ),
  spots as (
    select h.area_cd, h.area_nm, ST_PointOnSurface(h.geom) as pt, c.level, c.observed_at
    from hotspots h
    join latest_congestion c on c.area_cd = h.area_cd and c.observed_at > now() - interval '2 hours'
    cross join view_box v
    where h.geom && v.box
  )
  select jsonb_build_object(
    'mock', false,
    'edges', jsonb_build_object('type', 'FeatureCollection', 'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
        'properties', jsonb_build_object(
          'id', id,
          'noise_n', round(noise_n::numeric, 2),
          'light_n', round(light_n::numeric, 2),
          'crowd_n', round(crowd_n::numeric, 2),
          'load', round(s::numeric, 2),
          'load_level', public.load_level(s),
          'confidence', case confidence when 'high' then 0.9 when 'mid' then 0.6 else 0.3 end)
      )), '[]'::jsonb)
      from edges)),
    'sensors', jsonb_build_object('type', 'FeatureCollection', 'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(s.geom, 6)::jsonb,
        'properties', jsonb_build_object(
          'id', s.sensor_id,
          'kind', case s.kind when 'floating' then 'flow' else s.kind end,
          'noise_db', l.noise_db,
          'noise_grade', public.noise_grade(l.noise_db),
          'lux', l.lux,
          'flow_count', l.flow_count,
          'observed_at', l.observed_at)
      )), '[]'::jsonb)
      from latest l join sensors s on s.sensor_id = l.sensor_id)),
    'hotspots', jsonb_build_object('type', 'FeatureCollection', 'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(pt, 6)::jsonb,
        'properties', jsonb_build_object(
          'area_cd', area_cd, 'area_nm', area_nm,
          'crowd_level', level, 'crowd_label', public.congestion_label(level),
          'observed_at', observed_at)
      )), '[]'::jsonb)
      from spots))
  )
$$;

revoke execute on function public.map_layers_compute(double precision, double precision, double precision,
  double precision, integer, integer, integer) from public, anon, authenticated;

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
  where c.key = cache_key and c.computed_at > now() - interval '10 minutes';
  if found then
    return result;
  end if;

  result := map_layers_compute(min_lat, min_lng, max_lat, max_lng, sens_sound, sens_light, sens_crowd);

  insert into map_layers_cache (key, computed_at, body) values (cache_key, now(), result)
  on conflict (key) do update set computed_at = excluded.computed_at, body = excluded.body;
  delete from map_layers_cache where computed_at < now() - interval '20 minutes';

  return result;
end;
$$;

grant execute on function public.map_layers(double precision, double precision, double precision, double precision,
  integer, integer, integer) to anon, authenticated;
