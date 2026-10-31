/// <reference types="kakao.maps.d.ts" />
import type { NamedPlace } from "./api/types";
import { MAP_BOUNDS } from "./location";

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

function inMapo(address: string) {
  return address.includes("마포구");
}

function searchAddresses(query: string): Promise<NamedPlace[]> {
  return new Promise((resolve, reject) => {
    new kakao.maps.services.Geocoder().addressSearch(query, (results, status) => {
      if (status === kakao.maps.services.Status.ERROR) {
        reject(new Error("Kakao address search failed"));
        return;
      }
      resolve(
        results
          .filter((r) => inMapo(r.address_name))
          .map((r) => ({
            name: r.address_name.replace(/^서울(특별시)? /, ""),
            lat: Number(r.y),
            lng: Number(r.x),
          })),
      );
    });
  });
}

function searchKeywords(query: string): Promise<NamedPlace[]> {
  const { min_lng, min_lat, max_lng, max_lat } = MAP_BOUNDS;
  return new Promise((resolve, reject) => {
    new kakao.maps.services.Places().keywordSearch(
      query,
      (results, status) => {
        if (status === kakao.maps.services.Status.ERROR) {
          reject(new Error("Kakao search failed"));
          return;
        }
        // Inside a rect Kakao pads weak matches with nearby places, so check the words too.
        const words = query.split(/\s+/);
        resolve(
          results
            .filter((r) => {
              const address = r.road_address_name || r.address_name;
              const matched = words.some((w) => r.place_name.includes(w) || address.includes(w));
              return inMapo(address) && matched;
            })
            .map((r) => ({ name: r.place_name, lat: Number(r.y), lng: Number(r.x) })),
        );
      },
      { rect: `${min_lng},${min_lat},${max_lng},${max_lat}` },
    );
  });
}

// Road names and addresses come from the geocoder; keyword search only finds places on them.
// Results stop at Mapo-gu, the only area with road data.
export async function searchKakaoPlaces(query: string): Promise<NamedPlace[]> {
  const q = query.trim();
  if (!q) return [];
  await loadKakao();
  const [addresses, keywords] = await Promise.all([searchAddresses(q), searchKeywords(q)]);
  const seen = new Set<string>();
  return [...addresses.slice(0, 4), ...keywords]
    .filter((place) => !seen.has(place.name) && seen.add(place.name))
    .slice(0, 8);
}
