// 서울 실시간 도시데이터(인구) 수집, 10분. hotspots에 있는 장소마다 1번씩 부른다
import { db, kst, num, run, seoulApi } from "../_shared/collect.ts";

const LEVEL: Record<string, number> = { "여유": 1, "보통": 2, "약간 붐빔": 3, "붐빔": 4 };

Deno.serve(() =>
  run("citydata", async () => {
    const { data: hotspots, error } = await db.from("hotspots").select("area_cd");
    if (error) throw new Error(error.message);

    const results = await Promise.allSettled(hotspots.map(async ({ area_cd }) => {
      const body = await seoulApi("citydata_ppltn", 1, 5, area_cd);
      const s = body["SeoulRtd.citydata_ppltn"]?.[0];
      // 01~05시에는 비어 있을 수 있다
      if (!s?.PPLTN_TIME || !(s.AREA_CONGEST_LVL in LEVEL)) return null;
      return {
        area_cd,
        observed_at: kst(s.PPLTN_TIME),
        level: LEVEL[s.AREA_CONGEST_LVL],
        ppl_min: num(s.AREA_PPLTN_MIN),
        ppl_max: num(s.AREA_PPLTN_MAX),
      };
    }));

    const rows = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    if (rows.length) {
      const { error } = await db.from("congestion_obs").upsert(rows, { onConflict: "area_cd,observed_at" });
      if (error) throw new Error(error.message);
    }
    if (rows.length === 0 && failed.length) throw new Error(String(failed[0].reason));
    return rows.length;
  })
);
