// Grey stand-ins that draw the real GeoJSON. Replace with Kakao Map once a key exists.
import { levelOf } from "@/lib/format";
import type { Bounds, EdgeProps, HotspotProps, LineString, MapLayers, Point } from "@/lib/api/types";

export type Layer = "load" | "noise_n" | "light_n" | "crowd_n";

function project(b: Bounds, [lng, lat]: [number, number]) {
  return {
    x: ((lng - b.min_lng) / (b.max_lng - b.min_lng)) * 100,
    y: ((b.max_lat - lat) / (b.max_lat - b.min_lat)) * 100,
  };
}

function toPoints(b: Bounds, line: LineString) {
  return line.coordinates
    .map((c) => {
      const { x, y } = project(b, c);
      return `${x},${y}`;
    })
    .join(" ");
}

export function HomeMap({
  bounds,
  layers,
  layer,
  onHotspot,
}: {
  bounds: Bounds;
  layers?: MapLayers;
  layer: Layer;
  onHotspot: (hotspot: HotspotProps, point: Point) => void;
}) {
  const level = (props: EdgeProps) => levelOf(props[layer]);
  return (
    <div className="map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {layers?.edges.features.map((edge) => (
          <polyline
            key={edge.properties.id}
            className={`edge load-${level(edge.properties)}`}
            points={toPoints(bounds, edge.geometry)}
          />
        ))}
      </svg>
      {layers?.hotspots.features.map((hotspot) => {
        const { x, y } = project(bounds, hotspot.geometry.coordinates);
        const { area_cd, area_nm, crowd_label, crowd_level } = hotspot.properties;
        return (
          <button
            key={area_cd}
            type="button"
            className="hotspot"
            style={{ left: `${x}%`, top: `${y}%` }}
            aria-label={`${area_nm}, 혼잡도 ${crowd_label}`}
            onClick={() => onHotspot(hotspot.properties, hotspot.geometry)}
          >
            <span>{crowd_level}</span>
          </button>
        );
      })}
    </div>
  );
}

export function RouteMap({ line, label }: { line: LineString; label: string }) {
  const lngs = line.coordinates.map((c) => c[0]);
  const lats = line.coordinates.map((c) => c[1]);
  const pad = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats)) * 0.2;
  const bounds = {
    min_lng: Math.min(...lngs) - pad,
    max_lng: Math.max(...lngs) + pad,
    min_lat: Math.min(...lats) - pad,
    max_lat: Math.max(...lats) + pad,
  };
  const start = project(bounds, line.coordinates[0]);
  const end = project(bounds, line.coordinates[line.coordinates.length - 1]);
  return (
    <div className="map route-map" role="img" aria-label={label}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <polyline className="route-line" points={toPoints(bounds, line)} />
      </svg>
      <span className="pin" style={{ left: `${start.x}%`, top: `${start.y}%` }}>
        출발
      </span>
      <span className="pin" style={{ left: `${end.x}%`, top: `${end.y}%` }}>
        도착
      </span>
    </div>
  );
}
