// 서울 실시간 도시데이터(인구) 수집, 10분. hotspots에 있는 장소마다 1번씩 부른다(서울 전체 약 120곳 → 10분에 약 120회).
// 현재 혼잡도는 congestion_obs에, 앞으로 12시간 예측(FCST_PPLTN)은 congestion_forecast에 넣는다
import { kst, mapLimit, num, run, selectAll, seoulApi, upsertChunks } from "../_shared/collect.ts";

const LEVEL: Record<string, number> = { "여유": 1, "보통": 2, "약간 붐빔": 3, "붐빔": 4 };
// 120곳을 한꺼번에 부르면 서울 API가 일부를 거절하거나 늦게 답한다. 동시에 8곳씩 부른다(1곳 약 1초 → 한 번에 약 15초)
const CONCURRENCY = 8;

type Fcst = { FCST_TIME: string; FCST_CONGEST_LVL: string; FCST_PPLTN_MIN: string; FCST_PPLTN_MAX: string };

Deno.serve(() =>
  run("citydata", async () => {
    const hotspots = await selectAll<{ area_cd: string }>("hotspots", "area_cd");

    const results = await mapLimit(hotspots, CONCURRENCY, async ({ area_cd }) => {
      const body = await seoulApi("citydata_ppltn", 1, 5, area_cd);
      const s = body["SeoulRtd.citydata_ppltn"]?.[0];
      // 01~05시에는 비어 있을 수 있다
      if (!s?.PPLTN_TIME || !(s.AREA_CONGEST_LVL in LEVEL)) return null;
      const forecast = ((s.FCST_PPLTN ?? []) as Fcst[])
        .filter((f) => f.FCST_CONGEST_LVL in LEVEL)
        .map((f) => ({
          area_cd,
          fcst_at: kst(f.FCST_TIME),
          level: LEVEL[f.FCST_CONGEST_LVL],
          ppl_min: num(f.FCST_PPLTN_MIN),
          ppl_max: num(f.FCST_PPLTN_MAX),
          fetched_at: new Date().toISOString(),
        }));
      return {
        obs: {
          area_cd,
          observed_at: kst(s.PPLTN_TIME),
          level: LEVEL[s.AREA_CONGEST_LVL],
          ppl_min: num(s.AREA_PPLTN_MIN),
          ppl_max: num(s.AREA_PPLTN_MAX),
        },
        forecast,
      };
    });

    const ok = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    const rows = ok.map((r) => r.obs);
    const forecast = ok.flatMap((r) => r.forecast);  // 장소당 12건 → 서울 전체 약 1,400건
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    await upsertChunks("congestion_obs", rows, "area_cd,observed_at");
    await upsertChunks("congestion_forecast", forecast, "area_cd,fcst_at", 500);
    if (rows.length === 0 && failed.length) throw new Error(String(failed[0].reason));
    return rows.length;
  })
);
