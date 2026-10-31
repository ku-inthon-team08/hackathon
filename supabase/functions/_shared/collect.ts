// 수집기 공통: 서울 열린데이터광장 호출, Supabase 클라이언트, fetch_log 기록
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const KEY = Deno.env.get("SEOUL_API_KEY") ?? "";

// 서울 API는 평문 HTTP에 키를 URL에 담는다. 에러 문구에 URL이 섞여도 키가 남지 않게 지운다
function scrub(msg: string) {
  return KEY ? msg.replaceAll(KEY, "***") : msg;
}

export async function seoulApi(service: string, start: number, end: number, ...args: string[]) {
  if (!KEY) throw new Error("SEOUL_API_KEY 시크릿이 없습니다");
  const path = [KEY, "json", service, start, end, ...args.map(encodeURIComponent)].join("/");
  const res = await fetch(`http://openapi.seoul.go.kr:8088/${path}/`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${service} HTTP ${res.status}`);
  return await res.json();
}

// "2026-10-31_18:07:00" · "2026-10-31 18:10" → 한국 시간 ISO 문자열
export function kst(s: string) {
  const t = s.replace("_", "T");
  return `${t.length === 16 ? t + ":00" : t}+09:00`;
}

export function num(s: string | undefined) {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// REST는 한 번에 1000행까지만 돌려준다. 서울 전체 센서(1000개 넘음)를 읽을 때는 페이지를 넘긴다
export async function selectAll<T>(
  table: string,
  columns: string,
  // deno-lint-ignore no-explicit-any
  filter: (q: any) => any = (q) => q, // supabase-js의 필터 빌더 타입이 테이블마다 달라 any로 받는다
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order(columns.split(",")[0]).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// 요청마다 8초 제한이 있어 큰 upsert는 나눠 보낸다
export async function upsertChunks(table: string, rows: object[], onConflict: string, size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + size), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

// 서울 API를 한꺼번에 수백 번 부르지 않게 동시에 limit개씩만 부른다
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// 수집 결과를 fetch_log에 남기고 응답을 만든다.
// 도로 구간 노출값(refresh_edge_exposure)은 rpc 시간 제한을 넘어서 pg_cron이 따로 다시 계산한다
export async function run(source: string, job: () => Promise<number>) {
  try {
    const rows = await job();
    await db.from("fetch_log").insert({ source, ok: true, rows });
    return Response.json({ source, ok: true, rows });
  } catch (e) {
    const error = scrub(e instanceof Error ? e.message : String(e));
    await db.from("fetch_log").insert({ source, ok: false, error });
    return Response.json({ source, ok: false, error }, { status: 502 });
  }
}
