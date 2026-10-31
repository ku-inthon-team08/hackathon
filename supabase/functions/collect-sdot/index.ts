// S-DoT 실시간 수집. ?kind=env(소음·조도, 60분) | floating(유동인구, 10분)
// API에 지역 필터가 없어 최신순으로 페이지를 넘기며 sensors 테이블에 있는 센서(마포 시연 지역)만 남긴다
import { db, kst, num, run, seoulApi } from "../_shared/collect.ts";

const SERVICE = { env: "sDoTEnv", floating: "sDoTPeople" } as const;
const PAGE = 1000;
const MAX_PAGES = 4;
const LOOKBACK_MS = 2 * 60 * 60 * 1000; // 최근 2시간치만 본다

type Row = Record<string, string>;

Deno.serve((req) => {
  const kind = new URL(req.url).searchParams.get("kind") ?? "env";
  if (!(kind in SERVICE)) return Response.json({ error: "kind는 env 또는 floating" }, { status: 400 });
  const service = SERVICE[kind as keyof typeof SERVICE];

  return run(`sdot_${kind}`, async () => {
    const { data: sensors, error } = await db.from("sensors").select("sensor_id").eq("kind", kind);
    if (error) throw new Error(error.message);
    const ids = new Set(sensors.map((s) => s.sensor_id));
    if (ids.size === 0) throw new Error(`sensors에 kind=${kind} 센서가 없습니다`);

    const cutoff = Date.now() - LOOKBACK_MS;
    const obs = new Map<string, object>();
    for (let p = 0; p < MAX_PAGES; p++) {
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
    if (values.length) {
      const { error } = await db.from("sensor_obs").upsert(values, { onConflict: "sensor_id,observed_at" });
      if (error) throw new Error(error.message);
    }
    return values.length;
  });
});
