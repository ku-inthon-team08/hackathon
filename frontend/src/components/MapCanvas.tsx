"use client";

// Kakao Map when NEXT_PUBLIC_KAKAO_MAP_KEY works, otherwise a blurred, heatmap-like
// drawing of the same GeoJSON.
import { useAsync } from "@/hooks/useAsync";
import { levelOf } from "@/lib/format";
import { KAKAO_KEY, loadKakao } from "@/lib/kakao";
import type { Bounds, HotspotProps, LineString, MapLayers, Point } from "@/lib/api/types";
import { KakaoMap } from "./KakaoMap";

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

// Frames the route with some room around it.
function routeBounds(line: LineString): Bounds {
  const lngs = line.coordinates.map((c) => c[0]);
  const lats = line.coordinates.map((c) => c[1]);
  const pad = Math.max(Math.max(...lngs) - Math.min(...lngs), Math.max(...lats) - Math.min(...lats)) * 0.2;
  return {
    min_lng: Math.min(...lngs) - pad,
    max_lng: Math.max(...lngs) + pad,
    min_lat: Math.min(...lats) - pad,
    max_lat: Math.max(...lats) + pad,
  };
}

function useKakao() {
  const { data, error } = useAsync(loadKakao);
  return { ready: Boolean(data), failed: !KAKAO_KEY || Boolean(error) };
}

export function SensoryMap({
  bounds,
  layers,
  layer,
  route,
  onHotspot,
}: {
  bounds: Bounds;
  layers?: MapLayers;
  layer: Layer;
  // When set, the view moves to the route and draws it over the heat.
  route?: { line: LineString; label: string };
  onHotspot: (hotspot: HotspotProps, point: Point) => void;
}) {
  const { ready, failed } = useKakao();
  if (ready) {
    return (
      <div className="map" role={route ? "img" : undefined} aria-label={route?.label}>
        <KakaoMap
          bounds={bounds}
          layers={layers}
          layer={layer}
          route={route?.line}
          onHotspot={onHotspot}
        />
      </div>
    );
  }
  if (!failed) return <div className="map" />;

  const view = route ? routeBounds(route.line) : bounds;
  const start = route && project(view, route.line.coordinates[0]);
  const end = route && project(view, route.line.coordinates[route.line.coordinates.length - 1]);

  return (
    <div className="map" role={route ? "img" : undefined} aria-label={route?.label}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <defs>
          <filter id="heat-blur" filterUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
            <feGaussianBlur stdDeviation="1.6" />
          </filter>
        </defs>
        <g className="heat" filter="url(#heat-blur)">
          {layers?.edges.features.map((edge) => (
            <polyline
              key={edge.properties.id}
              className={`heat-line load-${levelOf(edge.properties[layer])}`}
              points={toPoints(view, edge.geometry)}
            />
          ))}
        </g>
        {route && <polyline className="route-line" points={toPoints(view, route.line)} />}
      </svg>
      {layers?.hotspots.features.map((hotspot) => {
        const { x, y } = project(view, hotspot.geometry.coordinates);
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
      {start && end && (
        <>
          <span className="pin" style={{ left: `${start.x}%`, top: `${start.y}%` }}>
            출발
          </span>
          <span className="pin" style={{ left: `${end.x}%`, top: `${end.y}%` }}>
            도착
          </span>
        </>
      )}
    </div>
  );
}
