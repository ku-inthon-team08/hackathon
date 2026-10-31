-- nearby_shelters · place_detail · best_times 실제 로직. 인자·응답 형식은 docs/api.md 그대로(mock: false).
-- 도로·센서·예측 테이블은 앱이 직접 읽지 못하므로 셋 다 security definer로 둔다.

-- 장소 둘레의 감각값: 장소에서 100m 안 도로 구간 edge_exposure의 길이 가중 평균. 구간이 없으면 0.5
create or replace function public.place_exposure(p extensions.geometry, out noise_n double precision,
  out light_n double precision, out crowd_n double precision)
language sql stable
security definer
set search_path = public, extensions
as $$
  select coalesce(sum(x.noise_n * e.length_m) / nullif(sum(e.length_m), 0), 0.5),
         coalesce(sum(x.light_n * e.length_m) / nullif(sum(e.length_m), 0), 0.5),
         coalesce(sum(x.crowd_n * e.length_m) / nullif(sum(e.length_m), 0), 0.5)
  from road_edges e
  join edge_exposure x on x.edge_id = e.id
  where e.geom && ST_Expand(p, 0.0012) and ST_DWithin(e.geom::geography, p::geography, 100)
$$;

revoke all on function public.place_exposure(extensions.geometry) from public, anon, authenticated;

-- ───── nearby_shelters ─────
-- 도서관·공원 중 직선거리로 도보 minutes분 안. 부하 낮은 순(같으면 가까운 순)
-- 도서관은 실내라 둘레 도로값 대신 실내 가정값(소음 0.15 · 조도 0.3 · 인파 0.3)을 쓴다
create or replace function public.nearby_shelters(
  lat double precision,
  lng double precision,
  minutes integer default 10,
  sens_sound integer default 2,
  sens_light integer default 2,
  sens_crowd integer default 2,
  walk_mpm double precision default 75
) returns jsonb
language sql stable
security definer
set search_path = public, extensions
as $$
  with here as (
    select ST_SetSRID(ST_MakePoint(lng, lat), 4326) as pt
  ),
  candidates as (
    select p.id, p.kind, p.name, p.geom, p.open_info,
           ST_Distance(p.geom::geography, h.pt::geography) as dist_m
    from places p cross join here h
    where p.kind in ('library', 'park')
      and ST_DWithin(p.geom::geography, h.pt::geography, minutes * walk_mpm)
  ),
  scored as (
    select c.*,
           public.sensory_load(
             case when c.kind = 'library' then 0.15 else x.noise_n end,
             case when c.kind = 'library' then 0.3 else x.light_n end,
             case when c.kind = 'library' then 0.3 else x.crowd_n end,
             sens_sound, sens_light, sens_crowd) as s
    from candidates c
    cross join lateral public.place_exposure(c.geom) x
  )
  select jsonb_build_object(
    'mock', false,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id',         id,
      'kind',       kind,
      'name',       name,
      'lat',        round(ST_Y(geom)::numeric, 6),
      'lng',        round(ST_X(geom)::numeric, 6),
      'distance_m', round(dist_m),
      'walk_min',   ceil(dist_m / walk_mpm)::integer,
      'is_open',    public.place_is_open(open_info),
      'load',       round(s::numeric, 2),
      'load_level', public.load_level(s)
    ) order by s, dist_m), '[]'::jsonb)
  )
  from scored
$$;

-- ───── place_detail ─────
-- 소음·조도 근거: 가장 가까운 환경 센서의 최신 측정(최근 3시간 안이 없으면 마지막 측정)
-- confidence: 센서 거리·데이터 나이로 0.9(200m·60분) · 0.6(500m·120분) · 0.3
-- 인파 근거: 장소를 품은 혼잡 장소, 없으면 가장 가까운 혼잡 장소의 최신 등급
create or replace function public.place_detail(place_id text)
returns jsonb
language plpgsql stable
security definer
set search_path = public, extensions
as $$
declare
  p places%rowtype;
  result jsonb;
begin
  select * into p from places where id = place_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'NOT_FOUND', detail = '없는 장소예요: ' || place_id;
  end if;

  with sensor as (
    select s.sensor_id, o.noise_db, o.lux, o.observed_at,
           ST_Distance(s.geom::geography, p.geom::geography) as dist_m,
           extract(epoch from now() - o.observed_at) / 60 as age_min
    from sensors s
    cross join lateral (
      select noise_db, lux, observed_at from sensor_obs
      where sensor_id = s.sensor_id and noise_db is not null and lux is not null
      order by observed_at desc limit 1
    ) o
    where s.kind = 'env'
    order by s.geom <-> p.geom
    limit 1
  ),
  conf as (
    select case
             when dist_m <= 200 and age_min <= 60 then 0.9
             when dist_m <= 500 and age_min <= 120 then 0.6
             else 0.3
           end as c
    from sensor
  ),
  crowd as (
    select h.area_nm, c.level, c.observed_at
    from hotspots h
    join latest_congestion c on c.area_cd = h.area_cd
    order by ST_Distance(h.geom, p.geom)  -- 영역 안이면 0
    limit 1
  )
  select jsonb_build_object(
    'mock', false,
    'place', jsonb_build_object(
      'id', p.id, 'kind', p.kind, 'name', p.name,
      'address', p.address, 'open_info', p.open_info),
    'evidence', jsonb_build_object(
      'noise', (select jsonb_build_object(
        'db', s.noise_db, 'grade', public.noise_grade(s.noise_db), 'observed_at', s.observed_at,
        'distance_m', round(s.dist_m), 'confidence', c.c, 'source', 'S-DoT')
        from sensor s, conf c),
      'light', (select jsonb_build_object(
        'lux', s.lux, 'observed_at', s.observed_at,
        'distance_m', round(s.dist_m), 'confidence', c.c, 'source', 'S-DoT')
        from sensor s, conf c),
      'crowd', (select jsonb_build_object(
        'level', level, 'label', public.congestion_label(level), 'area_nm', area_nm,
        'observed_at', observed_at, 'source', '실시간 도시데이터')
        from crowd))
  ) into result;
  return result;
end;
$$;

-- ───── best_times ─────
-- 기준점에서 가장 가까운 혼잡 장소(영역 안이면 거리 0)의 앞으로 hours시간
-- 혼잡: 도시데이터 예측(congestion_forecast) → 없으면 그 장소의 같은 시각 과거 평균 → 없으면 지금 등급
-- 소음: 가장 가까운 환경 센서의 같은 요일 유형(평일·주말)·같은 시각 과거 평균 dB
-- 덜 붐비는(같으면 조용한) 3개 시간대에 recommended
create or replace function public.best_times(
  lat double precision,
  lng double precision,
  hours integer default 12
) returns jsonb
language sql stable
security definer
set search_path = public, extensions
as $$
  with here as (
    select ST_SetSRID(ST_MakePoint(lng, lat), 4326) as pt
  ),
  area as (
    select h.area_cd, h.area_nm, ST_Distance(h.geom::geography, here.pt::geography) as dist_m
    from hotspots h, here
    order by h.geom <-> here.pt
    limit 1
  ),
  sensor as (
    select s.sensor_id
    from sensors s, here
    where s.kind = 'env'
    order by s.geom <-> here.pt
    limit 1
  ),
  slots as (
    select t,
           extract(hour from t at time zone 'Asia/Seoul') as kst_hour,
           extract(isodow from t at time zone 'Asia/Seoul') >= 6 as weekend
    from generate_series(date_trunc('hour', now()) + interval '1 hour',
                         date_trunc('hour', now()) + least(greatest(hours, 1), 24) * interval '1 hour',
                         interval '1 hour') as t
  ),
  filled as (
    select sl.t,
           coalesce(
             (select f.level from congestion_forecast f, area a where f.area_cd = a.area_cd and f.fcst_at = sl.t),
             (select round(avg(o.level))::int from congestion_obs o, area a
               where o.area_cd = a.area_cd and extract(hour from o.observed_at at time zone 'Asia/Seoul') = sl.kst_hour),
             (select c.level from latest_congestion c, area a where c.area_cd = a.area_cd),
             2) as crowd_level,
           coalesce(
             (select round(avg(o.noise_db)) from sensor_obs o, sensor s
               where o.sensor_id = s.sensor_id and o.noise_db is not null
                 and extract(hour from o.observed_at at time zone 'Asia/Seoul') = sl.kst_hour
                 and (extract(isodow from o.observed_at at time zone 'Asia/Seoul') >= 6) = sl.weekend),
             (select round(avg(o.noise_db)) from sensor_obs o, sensor s
               where o.sensor_id = s.sensor_id and o.noise_db is not null)) as noise_db
    from slots sl
  ),
  ranked as (
    select f.*, row_number() over (order by crowd_level, noise_db, t) as rnk
    from filled f
  )
  select jsonb_build_object(
    'mock', false,
    'area', (select jsonb_build_object('area_cd', area_cd, 'area_nm', area_nm, 'distance_m', round(dist_m)) from area),
    'slots', coalesce(jsonb_agg(jsonb_build_object(
      'at',          t,
      'crowd_level', crowd_level,
      'crowd_label', public.congestion_label(crowd_level),
      'noise_db',    noise_db,
      'noise_grade', public.noise_grade(noise_db),
      'recommended', rnk <= 3
    ) order by t), '[]'::jsonb)
  )
  from ranked
$$;

grant execute on function public.nearby_shelters(double precision, double precision, integer, integer, integer, integer,
  double precision) to anon, authenticated;
grant execute on function public.place_detail(text) to anon, authenticated;
grant execute on function public.best_times(double precision, double precision, integer) to anon, authenticated;
