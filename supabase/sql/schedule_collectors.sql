-- 수집 Edge Function을 pg_cron으로 주기 실행한다. 대시보드 SQL Editor에서 한 번 실행.
--
-- 먼저 할 일 (값은 직접 넣는다. 이 파일에 키를 적어 커밋하지 않는다):
--   1) Database → Extensions에서 pg_cron, pg_net 켜기
--   2) SQL Editor에서 Vault에 두 값 저장
--        select vault.create_secret('https://oojowgovzmjlhzuqzqcp.supabase.co', 'project_url');
--        select vault.create_secret('<service_role 키>', 'service_role_key');
--   3) 함수 배포 뒤 실행: npx supabase functions deploy collect-sdot collect-citydata

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_collector(path text)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/' || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$;

revoke all on function public.invoke_collector(text) from public, anon, authenticated;

-- 다시 실행해도 같은 이름이면 덮어쓴다
-- S-DoT 환경: 센서 시각이 매시 07분 무렵이라 15분에 가져온다
select cron.schedule('collect-sdot-env',      '15 * * * *',   $$select public.invoke_collector('collect-sdot?kind=env')$$);
-- S-DoT 유동인구·도시데이터: 10분마다, 서로 겹치지 않게 어긋나게
select cron.schedule('collect-sdot-floating', '2-59/10 * * * *', $$select public.invoke_collector('collect-sdot?kind=floating')$$);
select cron.schedule('collect-citydata',      '6-59/10 * * * *', $$select public.invoke_collector('collect-citydata')$$);

-- 확인
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select * from net._http_response order by created desc limit 10;
--   select source, fetched_at, ok, rows, error from public.fetch_log order by fetched_at desc limit 10;
