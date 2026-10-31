import type { LoadLevel, PlaceKind } from "./api/types";

export const LOAD_LABEL: Record<LoadLevel, string> = {
  low: "낮음",
  mid: "보통",
  high: "높음",
};

export const KIND_LABEL: Record<PlaceKind, string> = {
  library: "도서관",
  park: "공원",
};

export const NOISE_LABEL = ["매우 조용", "조용", "보통", "시끄러움", "매우 시끄러움"];

// docs/api.md leaves the "low confidence" cut-off to us. Agree a number with the BE.
export const LOW_CONFIDENCE = 0.5;

export function levelOf(value: number): LoadLevel {
  if (value < 0.33) return "low";
  return value < 0.66 ? "mid" : "high";
}

export function distance(m: number) {
  return m < 1000 ? `${m}m` : `${(m / 1000).toFixed(1)}km`;
}

export function koreaTime(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function koreaHour(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
  });
}
