-- refresh_edge_exposure를 pg_cron으로 DB 안에서 실행한다.
-- 도로 구간 17,000여 개를 매번 다시 계산해서 REST(rpc) 호출 시간 제한(약 8초)을 넘기 때문에, 수집기가 rpc로 부르지 않는다.
-- 수집 시각(유동인구 2분, 도시데이터 6분, 환경 매시 15분) 뒤인 8분마다 돈다.

select cron.schedule('refresh-edge-exposure', '8-59/10 * * * *', $$select public.refresh_edge_exposure()$$);
