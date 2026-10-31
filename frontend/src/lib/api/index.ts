import { KAKAO_KEY, searchKakaoPlaces } from "../kakao";
import { supabase } from "../supabase";
import * as mock from "./mock";
import type {
  BestTimes,
  Bounds,
  DataStatus,
  LatLng,
  MapLayers,
  NearbyShelters,
  PlaceDetail,
  QuietRoutes,
  Sensitivity,
} from "./types";

// Falls back to local data without keys, or while previewing a ?state= URL.
async function rpc<T>(
  name: string,
  args: Record<string, unknown>,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!supabase || mock.scenario()) return fallback();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

export function nearbyShelters(at: LatLng, minutes: number, sens: Sensitivity) {
  return rpc<NearbyShelters>("nearby_shelters", { ...at, minutes, ...sens }, () =>
    mock.nearbyShelters(at, minutes, sens),
  );
}

export function placeDetail(placeId: string) {
  return rpc<PlaceDetail>("place_detail", { place_id: placeId }, () =>
    mock.placeDetail(placeId),
  );
}

export function quietRoutes(from: LatLng, to: LatLng, sens: Sensitivity) {
  return rpc<QuietRoutes>(
    "quiet_routes",
    { from_lat: from.lat, from_lng: from.lng, to_lat: to.lat, to_lng: to.lng, ...sens },
    () => mock.quietRoutes(from, to, sens),
  );
}

export function bestTimes(at: LatLng, hours = 12) {
  return rpc<BestTimes>("best_times", { ...at, hours }, () => mock.bestTimes(at, hours));
}

export async function mapLayers(bounds: Bounds, sens: Sensitivity) {
  const empty = () => mock.mapLayers(bounds, sens);
  const layers = await rpc<MapLayers>("map_layers", { ...bounds, ...sens }, empty);
  // The BE's stub grid is not real roads, so keep the map clean until mock is false.
  return layers.mock ? empty() : layers;
}

export function dataStatus() {
  return rpc<DataStatus>("data_status", {}, () => mock.dataStatus());
}

export const searchPlaces = KAKAO_KEY ? searchKakaoPlaces : mock.searchPlaces;
