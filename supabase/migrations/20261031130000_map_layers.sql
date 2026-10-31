-- map_layers 실제 로직: 화면 범위 안의 도로 구간 감각값, 센서 최신값, 혼잡 장소를 GeoJSON으로 돌려준다.
-- 인자·응답 형식은 docs/api.md 그대로(mock: false).
--
-- edges    road_edges(보행 가능) + edge_exposure. load = sensory_load(민감도)
--          confidence는 텍스트(high·mid·low)라서 0.9 · 0.6 · 0.3 숫자로 바꾼다
--          화면이 넓으면 구간이 수천 개라 응답이 커지므로, 긴 구간부터 최대 max_edges개만 주고 선을 단순화한다
-- sensors  화면 안 센서와 최근 3시간 안 최신 측정. kind는 FE 타입에 맞춰 floating → flow
-- hotspots 화면과 겹치는 혼잡 장소. 위치는 영역 안 대표점, 최근 2시간 안 혼잡 등급이 있는 곳만

create or replace function public.map_layers(
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
  edges as (
    select e.id,
           ST_Simplify(e.geom, 0.00002) as geom,  -- 약 2m
           x.noise_n, x.light_n, x.crowd_n, x.confidence,
           public.sensory_load(x.noise_n, x.light_n, x.crowd_n, sens_sound, sens_light, sens_crowd) as s
    from road_edges e
    join edge_exposure x on x.edge_id = e.id
    cross join view_box v
    where e.is_walkable and e.geom && v.box
    order by e.length_m desc
    limit 6000
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

grant execute on function public.map_layers(double precision, double precision, double precision, double precision,
  integer, integer, integer) to anon, authenticated;
