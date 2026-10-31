-- 감각 과부하 지도 기본 스키마 (원격 DB에 팀원이 만든 스키마를 옮겨 적은 것)
-- 원격에는 이미 적용돼 있으므로 원격에 다시 실행하지 않는다. migration 기록에 "적용됨"으로만 올려 둔다:
--   npx supabase migration repair --status applied 20261031074000
-- 원격 DB 카탈로그(컬럼·제약·인덱스·RLS 정책)를 그대로 옮겼다.

create extension if not exists postgis with schema extensions;
create extension if not exists pgrouting with schema extensions;

-- ───────────── 기준 데이터 ─────────────

-- 실시간 도시데이터 장소 영역
create table public.hotspots (
  area_cd  text primary key,
  area_nm  text not null,
  category text,
  geom     geometry(MultiPolygon, 4326) not null
);
create index hotspots_geom_idx on public.hotspots using gist (geom);

-- kind: env 환경 센서(소음·조도) · floating 유동인구 센서
create table public.sensors (
  sensor_id text primary key,
  kind      text not null check (kind in ('env', 'floating')),
  geom      geometry(Point, 4326) not null
);
create index sensors_geom_idx on public.sensors using gist (geom);

-- 쉼터(갈 곳)와 검색용 장소
create table public.places (
  id   text primary key,
  name text not null,
  kind text not null check (kind in ('station', 'library', 'park', 'poi')),
  geom geometry(Point, 4326) not null
);
create index places_geom_idx on public.places using gist (geom);
create index places_name_idx on public.places (name text_pattern_ops);

-- 보행 도로망 (scripts/road_network로 적재)
create table public.road_nodes (
  id     bigint primary key,
  osm_id bigint,
  geom   geometry(Point, 4326) not null
);
create index road_nodes_geom_idx on public.road_nodes using gist (geom);

create table public.road_edges (
  id          bigint primary key,
  source      bigint not null references public.road_nodes (id),
  target      bigint not null references public.road_nodes (id),
  length_m    double precision not null check (length_m >= 0),
  highway     text,
  is_walkable boolean not null default true,
  geom        geometry(LineString, 4326) not null
);
create index road_edges_geom_idx on public.road_edges using gist (geom);
create index road_edges_source_idx on public.road_edges (source);
create index road_edges_target_idx on public.road_edges (target);
create index road_edges_walkable_idx on public.road_edges (id) where is_walkable;

-- ───────────── 수집 데이터 ─────────────

-- level: 1 여유 · 2 보통 · 3 약간 붐빔 · 4 붐빔
create table public.congestion_obs (
  area_cd     text not null references public.hotspots (area_cd),
  observed_at timestamptz not null,
  level       smallint not null check (level between 1 and 4),
  ppl_min     integer,
  ppl_max     integer,
  primary key (area_cd, observed_at)
);
create index congestion_obs_time_idx on public.congestion_obs (observed_at desc);

-- 장소별 가장 최근 혼잡도
create view public.latest_congestion as
select distinct on (area_cd) area_cd, observed_at, level, ppl_min, ppl_max
from public.congestion_obs
order by area_cd, observed_at desc;

create table public.sensor_obs (
  sensor_id   text not null references public.sensors (sensor_id),
  observed_at timestamptz not null,
  noise_db    real,
  lux         real,
  flow_count  integer,
  primary key (sensor_id, observed_at)
);
create index sensor_obs_time_idx on public.sensor_obs (observed_at desc);

-- ───────────── 계산 결과 ─────────────

-- 도로 구간별 감각 부하 (0~1)
create table public.edge_exposure (
  edge_id     bigint primary key references public.road_edges (id) on delete cascade,
  noise_n     real not null check (noise_n between 0 and 1),
  light_n     real not null check (light_n between 0 and 1),
  crowd_n     real not null check (crowd_n between 0 and 1),
  confidence  text not null check (confidence in ('high', 'mid', 'low')),
  computed_at timestamptz not null default now()
);

-- 경로 요청과 후보. route_requests.selected_id ↔ route_candidates.id는 서로를 가리킨다
-- noise_w·light_w·crowd_w는 1~5 (RPC의 sens_* 0~3과 범위가 다르다)
create table public.route_requests (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null,
  noise_w      smallint not null check (noise_w between 1 and 5),
  light_w      smallint not null check (light_w between 1 and 5),
  crowd_w      smallint not null check (crowd_w between 1 and 5),
  origin       geometry(Point, 4326) not null,
  origin_name  text,
  destination  geometry(Point, 4326) not null,
  dest_name    text,
  requested_at timestamptz not null default now(),
  data_as_of   timestamptz,
  selected_id  uuid
);

-- kind는 fastest · quiet · quietest (FE의 shortest · balanced · quietest와 이름이 다르다)
create table public.route_candidates (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.route_requests (id) on delete cascade,
  rank            smallint not null check (rank between 1 and 3),
  kind            text not null check (kind in ('fastest', 'quiet', 'quietest')),
  k               real not null,
  distance_m      integer not null,
  duration_min    smallint not null,
  extra_min       smallint not null default 0,
  avg_load        real check (avg_load between 0 and 1),
  high_load_ratio real check (high_load_ratio between 0 and 1),
  dominant_sense  text check (dominant_sense in ('noise', 'light', 'crowd')),
  avoided_areas   text[] not null default '{}',
  reason          text not null,
  geom            geometry(LineString, 4326) not null,
  segments        jsonb not null default '[]',
  unique (request_id, rank)
);
create index route_candidates_req_idx on public.route_candidates (request_id);

alter table public.route_requests
  add constraint route_requests_selected_fk
  foreign key (selected_id) references public.route_candidates (id) on delete set null;

-- ───────────── 운영 ─────────────

-- 수집 기록
create table public.fetch_log (
  id         bigserial primary key,
  source     text not null check (source in ('sdot_env', 'sdot_floating', 'citydata')),
  fetched_at timestamptz not null default now(),
  ok         boolean not null,
  rows       integer,
  error      text
);
create index fetch_log_source_idx on public.fetch_log (source, fetched_at desc);

-- ───────────── 권한 ─────────────
-- 모든 테이블에 RLS를 켠다. 앱(anon)의 직접 읽기는 공개 가능한 데이터 테이블에만 허용한다.
-- fetch_log.error에는 API 오류 원문이 들어갈 수 있으므로 fetch_log는 anon/authenticated에 공개하지 않는다.
-- 도로망·센서·경로·fetch_log를 읽는 RPC는 필요한 경우 security definer로 만든다.

alter table public.hotspots         enable row level security;
alter table public.sensors          enable row level security;
alter table public.places           enable row level security;
alter table public.road_nodes       enable row level security;
alter table public.road_edges       enable row level security;
alter table public.congestion_obs   enable row level security;
alter table public.sensor_obs       enable row level security;
alter table public.edge_exposure    enable row level security;
alter table public.route_requests   enable row level security;
alter table public.route_candidates enable row level security;
alter table public.fetch_log        enable row level security;

create policy "public read" on public.hotspots       for select to anon, authenticated using (true);
create policy "public read" on public.places         for select to anon, authenticated using (true);
create policy "public read" on public.congestion_obs for select to anon, authenticated using (true);
create policy "public read" on public.edge_exposure  for select to anon, authenticated using (true);
