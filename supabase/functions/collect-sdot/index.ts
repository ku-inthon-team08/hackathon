// S-DoT 실시간 수집. ?kind=env(소음·조도, 매시 25·50분) | floating(유동인구, 10분)
// API에 지역 필터가 없어 서울 전체 측정값을 최신순으로 1000건씩 넘기며, sensors 테이블에 있는 센서(서울 전체)만 남긴다
import { kst, num, run, selectAll, seoulApi, upsertChunks } from "../_shared/collect.ts";

const SERVICE = { env: "sDoTEnv", floating: "sDoTPeople" } as const;
const PAGE = 1000; // 서울 API가 한 번에 주는 최대 행 수
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 최근 2시간치만 본다(환경 API는 측정을 1시간 가까이 늦게 올린다)
// 2시간 앞까지 내려가면 멈춘다. 서울 전체가 2시간에 몇 페이지인지는 센서 수와 측정 간격에 따라 달라서 넉넉히 잡고,
// API 정렬이 바뀌어도 끝없이 넘기지 않게 상한과 시간 예산을 둔다(Edge Function은 150초 안에 끝나야 한다)
const MAX_PAGES = 20;
const TIME_BUDGET_MS = 90_000;

type Row = Record<string, string>;

Deno.serve((req) => {
  const kind = new URL(req.url).searchParams.get("kind") ?? "env";
  if (!(kind in SERVICE)) return Response.json({ error: "kind는 env 또는 floating" }, { status: 400 });
  const service = SERVICE[kind as keyof typeof SERVICE];

  return run(`sdot_${kind}`, async () => {
    const sensors = await selectAll<{ sensor_id: string }>("sensors", "sensor_id", (q) => q.eq("kind", kind));
    const ids = new Set(sensors.map((s) => s.sensor_id));
    if (ids.size === 0) throw new Error(`sensors에 kind=${kind} 센서가 없습니다`);

    const started = Date.now();
    const cutoff = started - LOOKBACK_MS;
    const obs = new Map<string, object>();
    for (let p = 0; p < MAX_PAGES && Date.now() - started < TIME_BUDGET_MS; p++) {
      const body = await seoulApi(service, p * PAGE + 1, (p + 1) * PAGE);
      const res = body[service];
      if (!res) throw new Error(`${service}: ${JSON.stringify(body.RESULT ?? body).slice(0, 200)}`);
      const rows: Row[] = res.row ?? [];

      let oldest = Infinity;
      for (const r of rows) {
        const observed_at = kst(r.SENSING_TIME);
        oldest = Math.min(oldest, Date.parse(observed_at));
        if (!ids.has(r.SERIAL)) continue;
        obs.set(`${r.SERIAL}|${observed_at}`, kind === "env"
          ? { sensor_id: r.SERIAL, observed_at, noise_db: num(r.AVG_NOISE), lux: num(r.AVG_INTE_ILLU) }
          : { sensor_id: r.SERIAL, observed_at, flow_count: num(r.VISITOR_COUNT) });
      }
      if (rows.length < PAGE || oldest < cutoff) break;
    }

    const values = [...obs.values()];
    await upsertChunks("sensor_obs", values, "sensor_id,observed_at");
    return values.length;
  });
});
