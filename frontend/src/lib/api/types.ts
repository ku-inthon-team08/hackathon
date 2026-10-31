// Copied from docs/api.md. Keep in sync with the BE.
export type LoadLevel = "low" | "mid" | "high";
export type PlaceKind = "library" | "park";
export type LineString = { type: "LineString"; coordinates: [number, number][] };
export type Point = { type: "Point"; coordinates: [number, number] };
export type FeatureCollection<G, P> = {
  type: "FeatureCollection";
  features: { type: "Feature"; geometry: G; properties: P }[];
};

export interface Shelter {
  id: string;
  kind: PlaceKind;
  name: string;
  lat: number;
  lng: number;
  distance_m: number;
  walk_min: number;
  is_open: boolean;
  load: number;
  load_level: LoadLevel;
}
export interface NearbyShelters {
  mock: boolean;
  items: Shelter[];
}

export interface PlaceDetail {
  mock: boolean;
  place: {
    id: string;
    kind: PlaceKind;
    name: string;
    address: string | null;
    open_info: Record<string, string> | null;
  };
  evidence: {
    noise: {
      db: number;
      grade: number;
      observed_at: string;
      distance_m: number;
      confidence: number;
      source: string;
    };
    light: {
      lux: number;
      observed_at: string;
      distance_m: number;
      confidence: number;
      source: string;
    };
    crowd: {
      level: number;
      label: string;
      area_nm: string;
      observed_at: string;
      source: string;
    };
  };
}

export type RouteKind = "shortest" | "balanced" | "quietest";
export interface Route {
  kind: RouteKind;
  label: string;
  distance_m: number;
  walk_min: number;
  avg_load: number;
  load_level: LoadLevel;
  extra_distance_pct: number | null;
  exposure_change_pct: number | null;
  geometry: LineString;
}
export interface QuietRoutes {
  mock: boolean;
  routes: Route[];
}

export interface TimeSlot {
  at: string;
  crowd_level: number;
  crowd_label: string;
  noise_db: number;
  noise_grade: number;
  recommended: boolean;
}
export interface BestTimes {
  mock: boolean;
  area: { area_cd: string; area_nm: string; distance_m: number };
  slots: TimeSlot[];
}

export interface EdgeProps {
  id: number;
  noise_n: number;
  light_n: number;
  crowd_n: number;
  load: number;
  load_level: LoadLevel;
  confidence: number;
}
export interface HotspotProps {
  area_cd: string;
  area_nm: string;
  crowd_level: number;
  crowd_label: string;
  observed_at: string;
}
export interface MapLayers {
  mock: boolean;
  edges: FeatureCollection<LineString, EdgeProps>;
  sensors: FeatureCollection<
    Point,
    {
      id: string;
      kind: "env" | "flow";
      noise_db: number | null;
      noise_grade: number | null;
      lux: number | null;
      observed_at: string;
    }
  >;
  hotspots: FeatureCollection<Point, HotspotProps>;
}

export interface DataStatus {
  mock: boolean;
  sources: {
    source: string;
    last_ok_at: string | null;
    age_min: number | null;
    last_try_ok: boolean;
  }[];
}

export interface Sensitivity {
  sens_sound: number;
  sens_light: number;
  sens_crowd: number;
}
export interface LatLng {
  lat: number;
  lng: number;
}
export interface Bounds {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
}
export interface NamedPlace extends LatLng {
  name: string;
}
