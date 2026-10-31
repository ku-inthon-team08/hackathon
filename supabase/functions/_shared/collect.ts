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
