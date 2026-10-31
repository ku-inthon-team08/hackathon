// 서울 실시간 도시데이터(인구) 수집, 10분. hotspots에 있는 장소마다 1번씩 부른다.
// 현재 혼잡도는 congestion_obs에, 앞으로 12시간 예측(FCST_PPLTN)은 congestion_forecast에 넣는다
import { db, kst, num, run, seoulApi } from "../_shared/collect.ts";

const LEVEL: Record<string, number> = { "여유": 1, "보통": 2, "약간 붐빔": 3, "붐빔": 4 };

type Fcst = { FCST_TIME: string; FCST_CONGEST_LVL: string; FCST_PPLTN_MIN: string; FCST_PPLTN_MAX: string };

Deno.serve(() =>
  run("citydata", async () => {
    const { data: hotspots, error } = await db.from("hotspots").select("area_cd");
    if (error) throw new Error(error.message);

    const results = await Promise.allSettled(hotspots.map(async ({ area_cd }) => {
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
    }));

    const ok = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    const rows = ok.map((r) => r.obs);
    const forecast = ok.flatMap((r) => r.forecast);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    if (rows.length) {
      const { error } = await db.from("congestion_obs").upsert(rows, { onConflict: "area_cd,observed_at" });
      if (error) throw new Error(error.message);
    }
    if (forecast.length) {
      const { error } = await db.from("congestion_forecast").upsert(forecast, { onConflict: "area_cd,fcst_at" });
      if (error) throw new Error(error.message);
    }
    if (rows.length === 0 && failed.length) throw new Error(String(failed[0].reason));
    return rows.length;
  })
);
