-- place_is_open: 작은도서관 운영시간의 여러 표기를 읽는다. 시간을 모르면 null(운영시간 확인 필요)을 돌려준다.
--   휴관일  "토, 일요일, 공휴일"처럼 요일을 줄여 쓴 것도 휴관으로 본다("공휴일"의 '일'은 요일로 보지 않는다)
--           "2,4주 월요일"처럼 주차가 붙으면 그 주에만 휴관
--   운영시간 "휴관일"이면 닫힘, "토요일:10:00~17:00"·"토10:00~17:00"처럼 토요일만 적혀 있으면 일요일은 닫힘
--           운영시간이 비어 있거나 시간을 읽지 못하면 null
-- nearby_shelters는 열린 곳 → 운영시간 모름 → 닫힌 곳 순으로 정렬한다.

create or replace function public.place_is_open(open_info jsonb, at timestamptz default now())
returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  kst timestamp := at at time zone 'Asia/Seoul';
  dow int := extract(isodow from kst);                         -- 1 월 ~ 7 일
  d text := (array['월', '화', '수', '목', '금', '토', '일'])[dow];
  week_of_month int := (extract(day from kst)::int - 1) / 7 + 1;
  closed text := coalesce(open_info ->> 'closed', '');
  hours text;
  m text[];
begin
  if open_info is null then
    return true;  -- 공원처럼 운영시간이 없는 곳
  end if;

  -- 정기 휴관일: 요일 글자가 단어 첫 글자로 나오면("토,", "일요일", "월요일") 그 요일. "공휴일"의 '일'은 앞이 한글이라 제외
  if closed ~ ('(^|[^가-힣])' || d || '(요일|[^가-힣]|$)') then
    m := regexp_match(closed, '([0-9,]+)주\s*' || d);
    if m is null or week_of_month::text = any (string_to_array(m[1], ',')) then
      return false;
    end if;
  end if;

  hours := case when dow >= 6 then open_info ->> 'weekend' else open_info ->> 'weekday' end;
  if hours is null or btrim(hours) = '' then
    return null;
  end if;
  if hours like '%휴관%' then
    return false;
  end if;
  -- 주말 칸에 토요일만 적혀 있으면 일요일은 닫힘
  if dow = 7 and hours ~ '토' and hours !~ '일' then
    return false;
  end if;
  m := regexp_match(hours, '(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})');
  if m is null then
    return null;
  end if;
  return kst::time >= m[1]::time and kst::time < m[2]::time;
end;
$$;

-- ───── nearby_shelters: 정렬만 바뀜(열림 → 모름 → 닫힘). 점수 계산은 20261031170000_shelter_scoring.sql과 같다 ─────
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
    ) order by case is_open when true then 0 when false then 2 else 1 end, score desc), '[]'::jsonb)
  )
  from ranked
$$;

grant execute on function public.nearby_shelters(double precision, double precision, integer, integer, integer, integer,
  double precision) to anon, authenticated;
