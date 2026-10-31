// Local data for every screen, shaped like docs/api.md.
// Add ?state=loading|empty|error|stale to any URL to preview that state.
import type {
  BestTimes,
  Bounds,
  DataStatus,
  LatLng,
  LoadLevel,
  MapLayers,
  NamedPlace,
  NearbyShelters,
  PlaceDetail,
  QuietRoutes,
  Route,
  RouteKind,
  Sensitivity,
} from "./types";

const WALK_MPM = 75;
const CROWD_LABELS = ["여유", "보통", "약간 붐빔", "붐빔"];

function scenario() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("state");
}

async function respond<T>(build: () => T, empty: () => T): Promise<T> {
  const state = scenario();
  if (state === "loading") await new Promise(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (state === "error") throw new Error("mock error");
  return state === "empty" ? empty() : build();
}

function sensoryLoad(noise: number, light: number, crowd: number, s: Sensitivity) {
  const total = s.sens_sound + s.sens_light + s.sens_crowd;
  if (total <= 0) return 0;
  return (s.sens_sound * noise + s.sens_light * light + s.sens_crowd * crowd) / total;
}

function loadLevel(s: number): LoadLevel {
  if (s < 0.33) return "low";
  return s < 0.66 ? "mid" : "high";
}

function noiseGrade(db: number) {
  if (db < 45) return 1;
  if (db < 55) return 2;
  if (db < 65) return 3;
  return db < 75 ? 4 : 5;
}

const round = (n: number, digits = 2) => Number(n.toFixed(digits));
const topOfHour = () => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
};
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

const SHELTERS = [
  [1, "library", "샘플 구립도서관", 240, 0.1, 0.2, 0.1, true],
  [2, "park", "샘플 근린공원", 380, 0.3, 0.1, 0.25, true],
  [3, "library", "샘플 작은도서관", 520, 0.15, 0.3, 0.05, false],
  [4, "park", "샘플 어린이공원", 640, 0.45, 0.15, 0.4, true],
  [5, "library", "샘플 시립도서관", 730, 0.05, 0.1, 0.05, true],
] as const;

export function nearbyShelters(
  { lat, lng }: LatLng,
  minutes: number,
  sens: Sensitivity,
): Promise<NearbyShelters> {
  return respond(
    () => ({
      mock: true,
      items: SHELTERS.filter((s) => s[3] <= minutes * WALK_MPM)
        .map(([n, kind, name, dist, noise, light, crowd, is_open]) => {
          const bearing = ((n * 72) / 180) * Math.PI;
          const load = sensoryLoad(noise, light, crowd, sens);
          return {
            id: `mock-${n}`,
            kind,
            name,
            lat: round(lat + (dist * Math.cos(bearing)) / 111320, 6),
            lng: round(
              lng + (dist * Math.sin(bearing)) / (111320 * Math.cos((lat / 180) * Math.PI)),
              6,
            ),
            distance_m: dist,
            walk_min: Math.ceil(dist / WALK_MPM),
            is_open,
            load: round(load),
            load_level: loadLevel(load),
          };
        })
        .sort((a, b) => a.load - b.load || a.distance_m - b.distance_m),
    }),
    () => ({ mock: true, items: [] }),
  );
}

export function placeDetail(placeId: string): Promise<PlaceDetail> {
  const build = (): PlaceDetail => ({
    mock: true,
    place: {
      id: placeId,
      kind: /[02468]$/.test(placeId) ? "park" : "library",
      name: `샘플 장소 ${placeId}`,
      address: "서울특별시 (샘플 주소)",
      open_info: { open: "09:00", close: "22:00", closed: "매주 월요일" },
    },
    evidence: {
      noise: {
        db: 47.5,
        grade: noiseGrade(47.5),
        observed_at: topOfHour(),
        distance_m: 180,
        confidence: 0.72,
        source: "S-DoT",
      },
      light: {
        lux: 85,
        observed_at: topOfHour(),
        distance_m: 180,
        confidence: 0.72,
        source: "S-DoT",
      },
      crowd: {
        level: 1,
        label: CROWD_LABELS[0],
        area_nm: "샘플 번화가",
        observed_at: minutesAgo(5),
        source: "실시간 도시데이터",
      },
    },
  });
  return respond(build, build);
}

function metres(a: [number, number], b: [number, number]) {
  const x = (b[0] - a[0]) * 111320 * Math.cos((a[1] / 180) * Math.PI);
  const y = (b[1] - a[1]) * 111320;
  return Math.hypot(x, y);
}

export function quietRoutes(
  from: LatLng,
  to: LatLng,
  sens: Sensitivity,
): Promise<QuietRoutes> {
  const options: [RouteKind, string, number, number, number, number][] = [
    ["shortest", "최단", 0, 0.75, 0.5, 0.7],
    ["balanced", "균형", 0.15, 0.45, 0.35, 0.4],
    ["quietest", "가장 조용한", 0.3, 0.2, 0.2, 0.15],
  ];
  return respond(
    () => {
      const measured = options.map(([kind, label, detour, noise, light, crowd]) => {
        const coordinates: [number, number][] = [
          [from.lng, from.lat],
          [
            (from.lng + to.lng) / 2 - (to.lat - from.lat) * detour,
            (from.lat + to.lat) / 2 + (to.lng - from.lng) * detour,
          ],
          [to.lng, to.lat],
        ];
        return {
          kind,
          label,
          coordinates,
          dist: metres(coordinates[0], coordinates[1]) + metres(coordinates[1], coordinates[2]),
          s: sensoryLoad(noise, light, crowd, sens),
          exposure: { light, noise, crowd },
        };
      });
      const base = measured[0];
      const routes: Route[] = measured.map((m) => ({
        kind: m.kind,
        label: m.label,
        distance_m: Math.round(m.dist),
        walk_min: Math.ceil(m.dist / WALK_MPM),
        avg_load: round(m.s),
        load_level: loadLevel(m.s),
        extra_distance_pct: Math.round((m.dist / base.dist - 1) * 100),
        exposure_change_pct: base.s
          ? Math.round(((m.s * m.dist) / (base.s * base.dist) - 1) * 100)
          : null,
        geometry: { type: "LineString", coordinates: m.coordinates },
        exposure: m.exposure,
      }));
      return { mock: true, routes };
    },
    () => ({ mock: true, routes: [] }),
  );
}

export function bestTimes(_at: LatLng, hours = 12): Promise<BestTimes> {
  const area = { area_cd: "POI000", area_nm: "샘플 번화가", distance_m: 300 };
  return respond(
    () => {
      const start = new Date();
      start.setMinutes(0, 0, 0);
      const slots = Array.from({ length: hours }, (_, i) => {
        const at = new Date(start.getTime() + (i + 1) * 3600000);
        const hour = Number(
          at.toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hour12: false }),
        );
        let level = 2;
        if (hour < 8) level = 1;
        else if ([12, 18, 19, 20].includes(hour)) level = 4;
        else if ([11, 13, 17, 21].includes(hour)) level = 3;
        return { at, level, noise_db: 50 + level * 6 };
      });
      const best = [...slots]
        .sort((a, b) => a.level - b.level || a.at.getTime() - b.at.getTime())
        .slice(0, 3);
      return {
        mock: true,
        area,
        slots: slots.map((s) => ({
          at: s.at.toISOString(),
          crowd_level: s.level,
          crowd_label: CROWD_LABELS[s.level - 1],
          noise_db: s.noise_db,
          noise_grade: noiseGrade(s.noise_db),
          recommended: best.includes(s),
        })),
      };
    },
    () => ({ mock: true, area, slots: [] }),
  );
}

// No sample lines or hotspots: the map stays clean until real road data exists.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function mapLayers(_bounds: Bounds, _sens: Sensitivity): Promise<MapLayers> {
  const none = () => ({ type: "FeatureCollection" as const, features: [] });
  const empty = () => ({ mock: true, edges: none(), sensors: none(), hotspots: none() });
  return respond(empty, empty);
}

export function dataStatus(): Promise<DataStatus> {
  const source = (name: string, age: number) => ({
    source: name,
    last_ok_at: minutesAgo(age),
    age_min: age,
    last_try_ok: false,
  });
  const empty = () => ({ mock: true, sources: [] });
  // Only ?state=stale shows a data age, to preview the stale banner.
  return respond(
    () =>
      scenario() === "stale"
        ? { mock: true, sources: [source("citydata", 95), source("sdot_env", 120)] }
        : empty(),
    empty,
  );
}

// Destination search belongs to the map SDK, not the BE. Replace with Kakao keyword search.
const SEARCHABLE: NamedPlace[] = [
  { name: "안암역", lat: 37.5863, lng: 127.0292 },
  { name: "고려대학교", lat: 37.5894, lng: 127.0323 },
  { name: "성신여대입구역", lat: 37.5927, lng: 127.0164 },
  { name: "서울역", lat: 37.5547, lng: 126.9707 },
  { name: "광화문역", lat: 37.5716, lng: 126.9769 },
  { name: "서울숲", lat: 37.5444, lng: 127.0374 },
  { name: "홍대입구역", lat: 37.5571, lng: 126.9245 },
  { name: "강남역", lat: 37.4979, lng: 127.0276 },
];

export async function searchPlaces(query: string): Promise<NamedPlace[]> {
  const q = query.trim();
  return q ? SEARCHABLE.filter((p) => p.name.includes(q)) : [];
}
