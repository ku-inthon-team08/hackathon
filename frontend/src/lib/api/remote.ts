// Calls the Supabase RPCs described in docs/api.md. Same signatures as ./mock.
import { supabase } from "../supabase";
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

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export function nearbyShelters(
  { lat, lng }: LatLng,
  minutes: number,
  sens: Sensitivity,
): Promise<NearbyShelters> {
  return rpc("nearby_shelters", { lat, lng, minutes, ...sens });
}

export function placeDetail(placeId: string): Promise<PlaceDetail> {
  return rpc("place_detail", { place_id: placeId });
}

export function quietRoutes(from: LatLng, to: LatLng, sens: Sensitivity): Promise<QuietRoutes> {
  return rpc("quiet_routes", {
    from_lat: from.lat,
    from_lng: from.lng,
    to_lat: to.lat,
    to_lng: to.lng,
    ...sens,
  });
}

export function bestTimes({ lat, lng }: LatLng, hours = 12): Promise<BestTimes> {
  return rpc("best_times", { lat, lng, hours });
}

export async function mapLayers(bounds: Bounds, sens: Sensitivity): Promise<MapLayers> {
  const layers = await rpc<MapLayers>("map_layers", { ...bounds, ...sens });
  // The BE stub draws a fake grid. Keep the map clean until real road data is served.
  if (layers.mock) {
    const none = () => ({ type: "FeatureCollection" as const, features: [] });
    return { mock: true, edges: none(), sensors: none(), hotspots: none() };
  }
  return layers;
}

export function dataStatus(): Promise<DataStatus> {
  return rpc("data_status");
}
