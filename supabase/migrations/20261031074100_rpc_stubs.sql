-- FE가 supabase.rpc()로 부르는 함수들
-- 지금은 응답 형식을 맞추기 위한 가짜 데이터(mock: true)를 돌려준다. data_status()만 실제 데이터.
-- 실제 로직이 준비되면 새 마이그레이션에서 같은 이름·인자로 create or replace 해서 본문만 바꾼다.
-- 도로망·센서·경로·fetch_log 테이블에는 앱(anon) 읽기 정책이 없으므로, 이들을 읽는 실제 RPC는 security definer로 만든다.
-- (hotspots·places·congestion_obs·edge_exposure만 anon 직접 읽기가 허용된다)
-- 테이블 좌표는 geometry(4326)라서 m 단위 거리는 geom::geography로 바꿔 계산한다.

-- ───────────── 공통 계산 함수 (실제 로직에서도 그대로 사용) ─────────────

-- 감각 부하 지수 S: 소리·빛·인파 값(0~1)을 사용자 민감도(0~3, 0이면 무시)로 가중 평균
create or replace function public.sensory_load(
  noise_n double precision,
  light_n double precision,
  crowd_n double precision,
  sens_sound integer,
  sens_light integer,
  sens_crowd integer
) returns double precision
language sql immutable
set search_path = ''
as $$
  select case
    when sens_sound + sens_light + sens_crowd <= 0 then 0
    else (sens_sound * noise_n + sens_light * light_n + sens_crowd * crowd_n)
         / (sens_sound + sens_light + sens_crowd)
  end
$$;

-- 감각 부하 구간
create or replace function public.load_level(s double precision) returns text
language sql immutable
set search_path = ''
as $$
  select case when s < 0.33 then 'low' when s < 0.66 then 'mid' when s >= 0.66 then 'high' end
$$;

-- 소음 등급 1~5: 감각 미리듣기와 지도 범례에 사용
create or replace function public.noise_grade(db double precision) returns integer
language sql immutable
set search_path = ''
as $$
  select case
    when db < 45 then 1  -- 매우 조용 (도서관 열람실)
    when db < 55 then 2  -- 조용
    when db < 65 then 3  -- 보통 (대화 소리)
    when db < 75 then 4  -- 시끄러움 (큰길)
    when db >= 75 then 5 -- 매우 시끄러움
  end
$$;

-- 실시간 도시데이터 혼잡도 등급 이름
create or replace function public.congestion_label(level integer) returns text
language sql immutable
set search_path = ''
as $$
  select (array['여유', '보통', '약간 붐빔', '붐빔'])[level]
$$;

-- ───────────── RPC ─────────────

-- 현장 쉼터: 현재 위치에서 도보 minutes분 안의 조용한 곳 (부하 낮은 순, 같으면 가까운 순)
create or replace function public.nearby_shelters(
  lat double precision,
  lng double precision,
  minutes integer default 10,
  sens_sound integer default 2,
  sens_light integer default 2,
  sens_crowd integer default 2,
  walk_mpm double precision default 75  -- 보행 속도(m/분). 고령자·아이 동반이면 60 정도
) returns jsonb
language sql stable
set search_path = public, extensions
as $$
  -- TODO(BE): places + 주변 edge_exposure로 실제 계산. places에 운영시간 컬럼이 없어 is_open은 아직 늘 true가 된다.
  -- 지금은 현재 위치 둘레에 가짜 쉼터를 놓는다
  with mock (n, kind, name, dist_m, noise_n, light_n, crowd_n, is_open) as (
    values
      (1, 'library', '샘플 구립도서관', 240, 0.10, 0.20, 0.10, true),
      (2, 'park',    '샘플 근린공원',   380, 0.30, 0.10, 0.25, true),
      (3, 'library', '샘플 작은도서관', 520, 0.15, 0.30, 0.05, false),
      (4, 'park',    '샘플 어린이공원', 640, 0.45, 0.15, 0.40, true),
      (5, 'library', '샘플 시립도서관', 730, 0.05, 0.10, 0.05, true)
  ),
  scored as (
    select m.*,
           radians(m.n * 72) as bearing,
           public.sensory_load(m.noise_n, m.light_n, m.crowd_n, sens_sound, sens_light, sens_crowd) as s
    from mock m
    where m.dist_m <= minutes * walk_mpm
  )
  select jsonb_build_object(
    'mock', true,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id',         'mock-' || n,
      'kind',       kind,
      'name',       name,
      'lat',        round((lat + dist_m * cos(bearing) / 111320)::numeric, 6),
      'lng',        round((lng + dist_m * sin(bearing) / (111320 * cos(radians(lat))))::numeric, 6),
      'distance_m', dist_m,
      'walk_min',   ceil(dist_m / walk_mpm)::integer,
      'is_open',    is_open,
      'load',       round(s::numeric, 2),
      'load_level', public.load_level(s)
    ) order by s, dist_m), '[]'::jsonb)
  )
  from scored
$$;

-- 장소 상세: 혼잡·소음·조도 근거
create or replace function public.place_detail(place_id text)
returns jsonb
language sql stable
set search_path = public, extensions
as $$
  -- TODO(BE): places + 가까운 sensor_obs · latest_congestion에서 근거를 만든다.
  -- places에 주소·운영시간 컬럼이 없어 address·open_info는 실제 데이터에서 null이 된다
  select jsonb_build_object(
    'mock', true,
    'place', jsonb_build_object(
      'id',        place_id,
      'kind',      case when right(place_id, 1) in ('0', '2', '4', '6', '8') then 'park' else 'library' end,
      'name',      '샘플 장소 ' || place_id,
      'address',   '서울특별시 (샘플 주소)',
      'open_info', jsonb_build_object('open', '09:00', 'close', '22:00', 'closed', '매주 월요일')
    ),
    'evidence', jsonb_build_object(
      'noise', jsonb_build_object(
        'db', 47.5, 'grade', public.noise_grade(47.5),
        'observed_at', date_trunc('hour', now()),
        'distance_m', 180, 'confidence', 0.72, 'source', 'S-DoT'),
      'light', jsonb_build_object(
        'lux', 85,
        'observed_at', date_trunc('hour', now()),
        'distance_m', 180, 'confidence', 0.72, 'source', 'S-DoT'),
      'crowd', jsonb_build_object(
        'level', 1, 'label', public.congestion_label(1), 'area_nm', '샘플 번화가',
        'observed_at', date_trunc('minute', now()) - interval '5 minutes', 'source', '실시간 도시데이터')
    )
  )
$$;

-- 출발 전 계획: 조용한 경로 후보 3개 (최단 · 균형 · 가장 조용한)
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
language sql stable
set search_path = public, extensions
as $$
  -- TODO(BE): road_edges(is_walkable) + edge_exposure에서 비용 L + L×S×k로 k를 바꿔 가며 pgRouting 계산하고,
  -- 결과를 route_requests · route_candidates에 저장한다. 그때는 volatile로 바꾼다. 지금은 직선과 우회선
  with mock (kind, label, detour, noise_n, light_n, crowd_n) as (
    values
      ('shortest', '최단',        0.00, 0.75, 0.50, 0.70),
      ('balanced', '균형',        0.15, 0.45, 0.35, 0.40),
      ('quietest', '가장 조용한', 0.30, 0.20, 0.20, 0.15)
  ),
  measured as (
    select m.*,
           ST_Length(line::geography) as dist_m,
           line,
           public.sensory_load(m.noise_n, m.light_n, m.crowd_n, sens_sound, sens_light, sens_crowd) as s
    from mock m,
         lateral (select ST_SetSRID(ST_MakeLine(array[
           ST_MakePoint(from_lng, from_lat),
           ST_MakePoint((from_lng + to_lng) / 2 - (to_lat - from_lat) * m.detour,
                        (from_lat + to_lat) / 2 + (to_lng - from_lng) * m.detour),
           ST_MakePoint(to_lng, to_lat)
         ]), 4326) as line) l
  ),
  base as (
    select dist_m as base_dist, s * dist_m as base_exposure from measured where kind = 'shortest'
  )
  select jsonb_build_object(
    'mock', true,
    'routes', jsonb_agg(jsonb_build_object(
      'kind',                m.kind,
      'label',               m.label,
      'distance_m',          round(m.dist_m),
      'walk_min',            ceil(m.dist_m / walk_mpm)::integer,
      'avg_load',            round(m.s::numeric, 2),
      'load_level',          public.load_level(m.s),
      'extra_distance_pct',  round(((m.dist_m / nullif(b.base_dist, 0) - 1) * 100)::numeric),
      'exposure_change_pct', round(((m.s * m.dist_m / nullif(b.base_exposure, 0) - 1) * 100)::numeric),
      'geometry',            ST_AsGeoJSON(m.line, 6)::jsonb
    ) order by m.detour)
  )
  from measured m cross join base b
$$;

-- 출발 전 계획: 목적지 근처 핫스팟의 앞으로 hours시간 예상 혼잡·소음. 덜 붐비는 3개 시간대에 recommended
create or replace function public.best_times(
  lat double precision,
  lng double precision,
  hours integer default 12
) returns jsonb
language sql stable
set search_path = public, extensions
as $$
  -- TODO(BE): 가장 가까운 hotspots의 혼잡도로 계산. 예측값을 담을 테이블이 아직 없어,
  -- citydata 예측(FCST_PPLTN)을 저장할 곳을 정하거나 congestion_obs 과거값의 시간대 평균을 쓴다. 지금은 시간대별 고정 패턴
  with slots as (
    select t,
           case
             when extract(hour from t at time zone 'Asia/Seoul') < 8                   then 1
             when extract(hour from t at time zone 'Asia/Seoul') in (12, 18, 19, 20)   then 4
             when extract(hour from t at time zone 'Asia/Seoul') in (11, 13, 17, 21)   then 3
             else 2
           end as level
    from generate_series(date_trunc('hour', now()) + interval '1 hour',
                         date_trunc('hour', now()) + hours * interval '1 hour',
                         interval '1 hour') as t
  ),
  ranked as (
    select t, level, 50 + level * 6 as noise_db,
           row_number() over (order by level, t) as rnk
    from slots
  )
  select jsonb_build_object(
    'mock', true,
    'area', jsonb_build_object('area_cd', 'POI000', 'area_nm', '샘플 번화가', 'distance_m', 300),
    'slots', coalesce(jsonb_agg(jsonb_build_object(
      'at',          t,
      'crowd_level', level,
      'crowd_label', public.congestion_label(level),
      'noise_db',    noise_db,
      'noise_grade', public.noise_grade(noise_db),
      'recommended', rnk <= 3
    ) order by t), '[]'::jsonb)
  )
  from ranked
$$;

-- 지도 레이어: 화면 범위 안의 도로 구간 부하 · 센서 · 핫스팟 (GeoJSON FeatureCollection)
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
set search_path = public, extensions
as $$
  -- TODO(BE): road_edges·edge_exposure, sensors·sensor_obs, hotspots·latest_congestion에서 읽는다.
  -- edge_exposure.confidence는 텍스트라서 응답의 0~1 숫자로 바꿔 준다(값 체계는 팀원과 맞출 것).
  -- 지금은 화면 범위에 5×5 가짜 격자를 깔고 가운데 가로·세로 줄을 시끄러운 큰길로 둔다
  with grid as (
    select g,
           min_lat + (max_lat - min_lat) * g / 6.0 as y,
           min_lng + (max_lng - min_lng) * g / 6.0 as x
    from generate_series(1, 5) as g
  ),
  mock_edges as (
    select g as id,
           ST_SetSRID(ST_MakeLine(ST_MakePoint(min_lng, y), ST_MakePoint(max_lng, y)), 4326) as geom,
           case when g = 3 then 0.85 else 0.15 + g * 0.05 end as noise_n,
           case when g = 3 then 0.70 else 0.20 end as light_n,
           case when g = 3 then 0.80 else 0.10 + g * 0.05 end as crowd_n
    from grid
    union all
    select 10 + g,
           ST_SetSRID(ST_MakeLine(ST_MakePoint(x, min_lat), ST_MakePoint(x, max_lat)), 4326),
           case when g = 3 then 0.75 else 0.10 + g * 0.04 end,
           0.25,
           case when g = 3 then 0.65 else 0.10 end
    from grid
  ),
  scored_edges as (
    select e.*, public.sensory_load(e.noise_n, e.light_n, e.crowd_n, sens_sound, sens_light, sens_crowd) as s
    from mock_edges e
  ),
  mock_sensors as (
    select 'MOCK-' || g as id, x, y, 48 + g * 5 as noise_db, 40 + g * 30 as lux
    from grid
    where g in (1, 3, 5)
  ),
  mock_hotspots as (
    select 'POI000' as area_cd, '샘플 번화가' as area_nm, 4 as level, x, y from grid where g = 3
    union all
    select 'POI001', '샘플 공원', 1, x, y from grid where g = 1
  )
  select jsonb_build_object(
    'mock', true,
    'edges', jsonb_build_object('type', 'FeatureCollection', 'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
        'properties', jsonb_build_object(
          'id', id,
          'noise_n', noise_n, 'light_n', light_n, 'crowd_n', crowd_n,
          'load', round(s::numeric, 2), 'load_level', public.load_level(s),
          'confidence', 0.6)
      )), '[]'::jsonb)
      from scored_edges)),
    'sensors', jsonb_build_object('type', 'FeatureCollection', 'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_MakePoint(x, y), 6)::jsonb,
        'properties', jsonb_build_object(
          'id', id, 'kind', 'env',
          'noise_db', noise_db, 'noise_grade', public.noise_grade(noise_db), 'lux', lux,
          'observed_at', date_trunc('hour', now()))
      )), '[]'::jsonb)
      from mock_sensors)),
    'hotspots', jsonb_build_object('type', 'FeatureCollection', 'features', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_MakePoint(x, y), 6)::jsonb,
        'properties', jsonb_build_object(
          'area_cd', area_cd, 'area_nm', area_nm,
          'crowd_level', level, 'crowd_label', public.congestion_label(level),
          'observed_at', date_trunc('minute', now()) - interval '5 minutes')
      )), '[]'::jsonb)
      from mock_hotspots))
  )
$$;

-- 데이터 신선도: 소스별 마지막 수집 성공 시각 (실제 데이터)
-- fetch_log 원문은 앱에 공개하지 않는다. 앱에는 error를 제외한 이 요약만 돌려준다.
create or replace function public.data_status()
returns jsonb
language sql stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'mock', false,
    'sources', coalesce(jsonb_agg(jsonb_build_object(
      'source',      source,
      'last_ok_at',  last_ok_at,
      'age_min',     floor(extract(epoch from now() - last_ok_at) / 60)::integer,
      'last_try_ok', last_try_ok
    ) order by source), '[]'::jsonb)
  )
  from (
    select source,
           max(fetched_at) filter (where ok) as last_ok_at,
           (array_agg(ok order by fetched_at desc))[1] as last_try_ok
    from public.fetch_log
    group by source
  ) s
$$;
