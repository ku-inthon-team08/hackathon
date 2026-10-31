-- map_layers 시간 초과 대응
--
-- 원인: 지도 화면이 열릴 때마다 FE가 map_layers를 타일 24개로 나눠 부르고, 실패하면 더 잘게 나눠 다시 부른다.
--       도로 1만 7천 개를 GeoJSON으로 매번 새로 만드느라 DB가 바빠지고, anon 기본 제한(3초)에 걸려
--       map_layers와 quiet_routes가 함께 취소됐다(로그: canceling statement due to statement timeout).
--
-- 1) map_layers 결과를 5분 동안 저장해 두고 같은 범위·민감도 요청에는 저장된 값을 돌려준다.
--    edge_exposure는 10분마다, 센서·혼잡은 10분 안팎으로 갱신되므로 5분 묵은 값이면 충분하다.
--    기존 계산 함수는 map_layers_compute로 이름만 바꿔 그대로 쓴다. 인자·응답 형식은 docs/api.md 그대로.
-- 2) anon 역할의 statement_timeout을 3초에서 8초로 올린다(authenticated와 같은 값).
--    함수에 `set statement_timeout`을 붙이는 방식은 이미 시작된 요청의 제한을 늘리지 못해서 역할 단위로 바꾼다.

-- ───── 1) 캐시 ─────
create table if not exists public.map_layers_cache (
  key         text primary key,
  computed_at timestamptz not null default now(),
  body        jsonb not null
);
-- 앱(anon)은 이 테이블을 직접 읽지 않는다. map_layers(security definer)만 읽고 쓴다
alter table public.map_layers_cache enable row level security;

alter function public.map_layers(double precision, double precision, double precision, double precision,
  integer, integer, integer) rename to map_layers_compute;
revoke execute on function public.map_layers_compute(double precision, double precision, double precision,
  double precision, integer, integer, integer) from public, anon, authenticated;

-- 캐시에 쓰므로 volatile이다(PostgREST는 stable 함수를 읽기 전용 트랜잭션에서 실행한다)
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
  delete from map_layers_cache where computed_at < now() - interval '1 hour';

  return result;
end;
$$;

grant execute on function public.map_layers(double precision, double precision, double precision, double precision,
  integer, integer, integer) to anon, authenticated;

-- ───── 2) anon 시간 제한 ─────
alter role anon set statement_timeout = '8s';
notify pgrst, 'reload config';
