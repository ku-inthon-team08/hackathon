-- 쉼터 찾기 기준: "감각 과부하가 왔을 때 걸어서 금방 가서, 무료로, 조용히 머물 수 있는 곳"
--
-- 후보   공공도서관 · 작은도서관(library), 주민센터(center, 새 종류), 공원(park). 역·기타(poi)는 쉼터가 아니다
--        places.category에 화면에 보여줄 세부 종류(공공도서관 · 작은도서관 · 주민센터 · 공원 · 역)를 담는다
-- 점수   score = 0.6 × (1 − S) + 0.3 × (1 − min(도보분, 10) / 10) + 0.1 × q − 혼잡 감점
--        S  감각 부하. 실내(도서관·주민센터)는 실내 가정값(소음 0.15 · 조도 0.3 · 인파 0.3),
--           공원은 둘레 100m 도로의 실제 감각값. 둘 다 사용자 민감도로 가중 평균
--        q  데이터 신뢰도. 공원은 가장 가까운 환경 센서가 200m·60분 안이면 1, 500m·120분 안이면 0.5, 아니면 0.
--           실내는 가정값이라 0.5
--        혼잡 감점  공원이 혼잡 장소 영역 안이고 지금 등급이 약간 붐빔(3) 이상이면 0.1 × (등급 − 2)
-- 정렬   지금 열린 곳 먼저, 그다음 점수 높은 순. 직선거리로 도보 minutes분 밖은 뺀다

alter table public.places add column if not exists category text;

alter table public.places drop constraint if exists places_kind_check;
alter table public.places add constraint places_kind_check
  check (kind in ('station', 'library', 'park', 'poi', 'center'));

update public.places set category = case kind
    when 'station' then '역' when 'park' then '공원' when 'library' then '공공도서관' end
where category is null;

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
    select p.id, p.kind, p.category, p.name, p.geom, p.open_info,
           p.kind in ('library', 'center') as indoor,
           ST_Distance(p.geom::geography, h.pt::geography) as dist_m
    from places p cross join here h
    where p.kind in ('library', 'park', 'center')
      and ST_DWithin(p.geom::geography, h.pt::geography, minutes * walk_mpm)
  ),
  scored as (
    select c.*,
           public.place_is_open(c.open_info) as is_open,
           public.sensory_load(
             case when c.indoor then 0.15 else x.noise_n end,
             case when c.indoor then 0.3 else x.light_n end,
             case when c.indoor then 0.3 else x.crowd_n end,
             sens_sound, sens_light, sens_crowd) as s,
           case
             when c.indoor then 0.5
             when n.dist_m <= 200 and n.age_min <= 60 then 1
             when n.dist_m <= 500 and n.age_min <= 120 then 0.5
             else 0
           end as q,
           case when c.indoor then 0 else coalesce(0.1 * greatest(a.level - 2, 0), 0) end as crowd_penalty
    from candidates c
    cross join lateral public.place_exposure(c.geom) x
    left join lateral (
      select ST_Distance(s.geom::geography, c.geom::geography) as dist_m,
             extract(epoch from now() - o.observed_at) / 60 as age_min
      from sensors s
      cross join lateral (
        select observed_at from sensor_obs
        where sensor_id = s.sensor_id and noise_db is not null
        order by observed_at desc limit 1
      ) o
      where s.kind = 'env'
      order by s.geom <-> c.geom
      limit 1
    ) n on true
    left join lateral (
      select max(lc.level) as level
      from hotspots h
      join latest_congestion lc on lc.area_cd = h.area_cd and lc.observed_at > now() - interval '2 hours'
      where ST_Intersects(h.geom, c.geom)
    ) a on true
  ),
  ranked as (
    select s.*,
           0.6 * (1 - s.s)
           + 0.3 * (1 - least(s.dist_m / walk_mpm, 10) / 10)
           + 0.1 * s.q
           - s.crowd_penalty as score
    from scored s
  )
  select jsonb_build_object(
    'mock', false,
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id',         id,
      'kind',       kind,
      'category',   category,
      'name',       name,
      'lat',        round(ST_Y(geom)::numeric, 6),
      'lng',        round(ST_X(geom)::numeric, 6),
      'distance_m', round(dist_m),
      'walk_min',   ceil(dist_m / walk_mpm)::integer,
      'is_open',    is_open,
      'indoor',     indoor,
      'load',       round(s::numeric, 2),
      'load_level', public.load_level(s),
      'score',      round(score::numeric, 2)
    ) order by is_open desc, score desc), '[]'::jsonb)
  )
  from ranked
$$;

grant execute on function public.nearby_shelters(double precision, double precision, integer, integer, integer, integer,
  double precision) to anon, authenticated;
