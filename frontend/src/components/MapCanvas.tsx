"use client";

// Kakao Map when NEXT_KAKAO_MAP_KEY works, otherwise a blurred, heatmap-like
// drawing of the same GeoJSON.
import { useAsync } from "@/hooks/useAsync";
import { levelOf } from "@/lib/format";
import type { HeatValue } from "@/lib/heat";
import { KAKAO_KEY, loadKakao } from "@/lib/kakao";
import type { Bounds, HotspotProps, LineString, MapLayers, Point } from "@/lib/api/types";
import { KakaoMap } from "./KakaoMap";

export type Layer = HeatValue;

export interface MapRoute {
  id: string;
  line: LineString;
  selected: boolean;
}

// A numbered marker, e.g. a shelter from the list beside the map.
export interface MapPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  label: string;
}

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

// Frames the routes with some room around them.
function routeBounds(routes: MapRoute[]): Bounds {
  const coordinates = routes.flatMap((route) => route.line.coordinates);
  const lngs = coordinates.map((c) => c[0]);
  const lats = coordinates.map((c) => c[1]);
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
  routes,
  routeLabel,
  onRoutePick,
  onHotspot,
  places,
  onPlace,
}: {
  bounds: Bounds;
  layers?: MapLayers;
  layer: Layer;
  // When set, the view moves to the routes and draws them over the heat.
  routes?: MapRoute[];
  routeLabel?: string;
  onRoutePick?: (id: string) => void;
  onHotspot: (hotspot: HotspotProps, point: Point) => void;
  // When set, these are the only markers besides the route pins.
  places?: MapPlace[];
  onPlace?: (place: MapPlace) => void;
}) {
  const { ready, failed } = useKakao();
  const frame = {
    className: routes ? "map routing" : "map",
    role: routes ? "img" : undefined,
    "aria-label": routeLabel,
  };
  if (ready) {
    return (
      <div {...frame}>
        <KakaoMap
          bounds={bounds}
          layers={layers}
          layer={layer}
          routes={routes}
          onRoutePick={onRoutePick}
          onHotspot={onHotspot}
          places={places}
          onPlace={onPlace}
        />
      </div>
    );
  }
  if (!failed) return <div className="map" />;

  const view = routes ? routeBounds(routes) : bounds;
  const selected = routes?.find((route) => route.selected);
  const start = selected && project(view, selected.line.coordinates[0]);
  const end =
    selected && project(view, selected.line.coordinates[selected.line.coordinates.length - 1]);

  return (
    <div {...frame}>
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
        {routes
          ?.toSorted((a, b) => Number(a.selected) - Number(b.selected))
          .map((route) => (
            <polyline
              key={route.id}
              className={route.selected ? "route-line" : "route-line other"}
              points={toPoints(view, route.line)}
              onClick={() => onRoutePick?.(route.id)}
            />
          ))}
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
      {places?.map((place) => {
        const { x, y } = project(view, [place.lng, place.lat]);
        return (
          <button
            key={place.id}
            type="button"
            className="place-pin"
            style={{ left: `${x}%`, top: `${y}%` }}
            aria-label={`${place.label}. ${place.name}`}
            onClick={() => onPlace?.(place)}
          >
            {place.label}
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
