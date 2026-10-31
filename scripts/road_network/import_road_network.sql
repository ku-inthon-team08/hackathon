-- 원격 DB의 도로망을 build_graph.py CSV로 통째로 바꾼다. 서비스 키나 DB 비밀번호 없이 SQL만으로 한다
-- (Supabase SQL 편집기, MCP execute_sql, psql 어디서나).
--
-- upload_graph.py(REST)는 1000행 배치가 8초 제한에 걸려 서울 규모(구간 25만 개)에서 멈추고, --replace의 DELETE도 시간 초과로 실패한다.
-- 그래서 CSV를 공개 URL에 두고 DB가 pg_net으로 직접 받아 replace_road_network()에 넘긴다.
-- 이 레포는 공개라서 GitHub raw 주소를 쓴다. 파일이 바뀌지 않게 브랜치 이름 대신 커밋 해시로 고정한다.
-- pg_net 요청은 요청한 트랜잭션이 끝난 뒤에 나가므로 아래 세 단계를 따로 실행한다.

-- ───── 1) 받기 ─────
-- GitHub raw는 큰 파일도 주지만 10MB씩 나눠(Range) 받는다. 반환된 요청 id 순서가 곧 파일 순서다
select f.file, f.part, net.http_get(
         'https://raw.githubusercontent.com/ku-inthon-team08/hackathon/<커밋 해시>/data/road_network/seoul_road_' || f.file || '.csv',
         headers := jsonb_build_object('Range', format('bytes=%s-%s', f.part * 10000000, f.part * 10000000 + 9999999)),
         timeout_milliseconds := 120000) as request_id
from (values ('nodes', 0), ('nodes', 1),
             ('edges', 0), ('edges', 1), ('edges', 2), ('edges', 3)) f(file, part)  -- 파일 크기 / 10MB 만큼
order by f.file, f.part;

-- ───── 2) 확인: 모든 조각이 206이고, 이어 붙인 MD5가 로컬 파일(md5sum)과 같아야 한다 ─────
select id, status_code, octet_length(content) bytes, error_msg
from net._http_response where id between <첫 id> and <마지막 id> order by id;

select md5(string_agg(content, '' order by id)) from net._http_response where id in (<nodes 조각 id들>);
select md5(string_agg(content, '' order by id)) from net._http_response where id in (<edges 조각 id들>);

-- ───── 3) 바꾸기: 한 트랜잭션. 중간에 실패하면 예전 도로망이 그대로 남는다 ─────
-- 서울 기준 몇 분 걸린다. SQL 편집기·MCP의 요청 시간 제한에 걸리면 pg_cron으로 한 번만 돌린다:
--   select cron.schedule('replace-road-network', '<분> <시> * * *', $job$ ...아래 내용... $job$);
--   끝나면 cron.job_run_details에서 결과를 보고 select cron.unschedule('replace-road-network');
set statement_timeout = '30min';
select public.replace_road_network(
  (select string_agg(content, '' order by id) from net._http_response where id in (<nodes 조각 id들>)),
  (select string_agg(content, '' order by id) from net._http_response where id in (<edges 조각 id들>))
);

-- 4) 정리: 받아 둔 CSV 본문(약 50MB)을 지우고 지도 캐시를 한 번 더 비운다(바꾸는 동안 예전 값으로 만들어진 캐시)
delete from net._http_response where id in (<받은 id 전부>);
delete from public.map_layers_cache;
