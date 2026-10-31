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

// map_layers stops at this many roads per call, and a busy area can hit the DB time limit.
const EDGE_LIMIT = 6000;
const GRID_ROWS = 4;
const GRID_COLS = 6;
// More at once than this makes the DB cancel requests.
const MAX_PARALLEL = 3;
const MAX_SPLITS = 2;

function split(b: Bounds, rows: number, cols: number): Bounds[] {
  const height = (b.max_lat - b.min_lat) / rows;
  const width = (b.max_lng - b.min_lng) / cols;
  return Array.from({ length: rows * cols }, (_, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    return {
      min_lat: b.min_lat + height * row,
      max_lat: b.min_lat + height * (row + 1),
      min_lng: b.min_lng + width * col,
      max_lng: b.min_lng + width * (col + 1),
    };
  });
}

// Works through a queue, and splits any area that came back cut short.
// A failed area is not split and retried: on a busy DB that multiplies the requests and makes
// every other call (quiet_routes too) time out. The BE caches each area for 5 minutes instead.
async function layersIn(bounds: Bounds, sens: Sensitivity): Promise<MapLayers[]> {
  const queue = split(bounds, GRID_ROWS, GRID_COLS).map((area) => ({ area, splits: 0 }));
  const parts: MapLayers[] = [];

  function splitUp(job: (typeof queue)[number]) {
    const smaller = split(job.area, 2, 2).map((area) => ({ area, splits: job.splits + 1 }));
    queue.push(...smaller);
  }

  async function worker() {
    for (let job = queue.pop(); job; job = queue.pop()) {
      try {
        const layers = await rpc<MapLayers>("map_layers", { ...job.area, ...sens });
        parts.push(layers);
        if (layers.edges.features.length >= EDGE_LIMIT && job.splits < MAX_SPLITS) splitUp(job);
      } catch {
        // Skip this area; the rest of the map still shows.
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
  return parts;
}

function unique<T>(items: T[], key: (item: T) => unknown) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

// A full load is heavy, so callers asking for the same thing share one that is running.
const running = new Map<string, Promise<MapLayers>>();

export function mapLayers(bounds: Bounds, sens: Sensitivity): Promise<MapLayers> {
  const key = JSON.stringify([bounds, sens]);
  const load = running.get(key) ?? loadLayers(bounds, sens).finally(() => running.delete(key));
  running.set(key, load);
  return load;
}

async function loadLayers(bounds: Bounds, sens: Sensitivity): Promise<MapLayers> {
  const parts = await layersIn(bounds, sens);
  if (parts.length === 0) throw new Error("map_layers: every area failed");

  const none = () => ({ type: "FeatureCollection" as const, features: [] });
  // The BE stub draws a fake grid. Keep the map clean until real road data is served.
  if (parts.some((layers) => layers.mock)) {
    return { mock: true, edges: none(), sensors: none(), hotspots: none() };
  }
  // A road or hotspot crossing a tile edge comes back from both tiles.
  return {
    mock: false,
    edges: {
      ...none(),
      features: unique(parts.flatMap((p) => p.edges.features), (f) => f.properties.id),
    },
    sensors: {
      ...none(),
      features: unique(parts.flatMap((p) => p.sensors.features), (f) => f.properties.id),
    },
    hotspots: {
      ...none(),
      features: unique(parts.flatMap((p) => p.hotspots.features), (f) => f.properties.area_cd),
    },
  };
}

export function dataStatus(): Promise<DataStatus> {
  return rpc("data_status");
}
