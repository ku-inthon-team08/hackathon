-- 1) S-DoT 환경 API는 매시 07분 측정을 1시간 가까이 늦게 올린다. 매시 15분 한 번 수집으로는 직전 측정을 놓쳐
--    데이터가 2시간 가까이 묵었다. 매시 25분·50분 두 번 가져온다(같은 측정은 upsert로 덮어쓴다).
-- 2) nearby_shelters: 운영시간이 지나 닫힌 도서관이 부하가 낮다는 이유로 맨 위에 오던 것을, 열린 곳 먼저로 바꾼다.

select cron.schedule('collect-sdot-env', '25,50 * * * *', $$select public.invoke_collector('collect-sdot?kind=env')$$);

-- ───── nearby_shelters ─────
-- 도서관·공원 중 직선거리로 도보 minutes분 안. 지금 열린 곳 먼저, 그다음 부하 낮은 순(같으면 가까운 순)
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
    ) order by public.place_is_open(open_info) desc, s, dist_m), '[]'::jsonb)
  )
  from scored
$$;

