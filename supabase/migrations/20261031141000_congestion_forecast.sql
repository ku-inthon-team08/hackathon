-- 실시간 도시데이터의 인구 예측(FCST_PPLTN, 앞으로 12시간)을 담는다. best_times가 시간대별 혼잡 예상으로 쓴다.
-- collect-citydata가 수집할 때마다 같은 (장소, 예측 시각)을 최신 예측으로 덮어쓴다.

create table if not exists public.congestion_forecast (
  area_cd    text not null references public.hotspots (area_cd),
  fcst_at    timestamptz not null,
  level      smallint not null check (level between 1 and 4),
  ppl_min    integer,
  ppl_max    integer,
  fetched_at timestamptz not null default now(),
  primary key (area_cd, fcst_at)
);

alter table public.congestion_forecast enable row level security;  -- 정책 없음: best_times(security definer)로만 읽는다
