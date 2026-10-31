/// <reference types="kakao.maps.d.ts" />
import type { NamedPlace } from "./api/types";

export const KAKAO_KEY = process.env.NEXT_KAKAO_MAP_KEY;

let sdk: Promise<true> | null = null;

export function loadKakao() {
  sdk ??= new Promise<true>((resolve, reject) => {
    if (!KAKAO_KEY) {
      reject(new Error("no Kakao key"));
      return;
    }
    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false&libraries=services`;
    script.onload = () => kakao.maps.load(() => resolve(true));
    script.onerror = () => reject(new Error("Kakao SDK failed to load"));
    document.head.append(script);
  });
  return sdk;
}

export async function searchKakaoPlaces(query: string): Promise<NamedPlace[]> {
  const q = query.trim();
  if (!q) return [];
  await loadKakao();
  return new Promise((resolve, reject) => {
    new kakao.maps.services.Places().keywordSearch(q, (results, status) => {
      if (status === kakao.maps.services.Status.ERROR) {
        reject(new Error("Kakao search failed"));
        return;
      }
      resolve(
        status === kakao.maps.services.Status.OK
          ? results.map((r) => ({
              name: r.place_name,
              lat: Number(r.y),
              lng: Number(r.x),
            }))
          : [],
      );
    });
  });
}
