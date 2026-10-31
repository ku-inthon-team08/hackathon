"use client";

import { useEffect, useRef } from "react";
import { drawHeat, heatPoints, heatRamp } from "@/lib/heat";
import type { Bounds, HotspotProps, MapLayers, Point } from "@/lib/api/types";
import "@/lib/kakao";
import { useTheme, type Theme } from "@/lib/theme";
import type { Layer, MapRoute } from "./MapCanvas";

const toLatLng = ([lng, lat]: [number, number]) => new kakao.maps.LatLng(lat, lng);

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Extra canvas around the view, so dragging shows heat before the redraw on release.
const HEAT_MARGIN = 240;

function useKakaoMap(element: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<kakao.maps.Map | null>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    map.current = new kakao.maps.Map(node, {
      center: new kakao.maps.LatLng(37.563, 126.9102),
      level: 5,
    });
    return () => {
      map.current = null;
      node.replaceChildren();
    };
  }, [element]);
  return map;
}

function pin(label: string, position: kakao.maps.LatLng, target: kakao.maps.Map) {
  const content = document.createElement("span");
  content.className = "pin";
  content.textContent = label;
  return new kakao.maps.CustomOverlay({ map: target, position, content, xAnchor: 0.5, yAnchor: 0.5 });
}

// graphicsLayer sits above the tiles and below Kakao's lines and markers, so the heat
// never tints a route. Its origin moves around, so `place` positions by its coordinates.
function addToGraphicsLayer(target: kakao.maps.Map, canvas: HTMLCanvasElement, place: () => void) {
  const overlay = new kakao.maps.AbstractOverlay();
  overlay.onAdd = function (this: kakao.maps.AbstractOverlay) {
    const panels = this.getPanels() as unknown as { graphicsLayer?: HTMLElement };
    panels.graphicsLayer?.prepend(canvas);
  };
  overlay.draw = place;
  overlay.onRemove = () => canvas.remove();
  overlay.setMap(target);
  return overlay;
}

function useHeat(
  map: React.RefObject<kakao.maps.Map | null>,
  element: React.RefObject<HTMLDivElement | null>,
  layers: MapLayers | undefined,
  layer: Layer,
  // The ramp comes from the level tokens, so a theme change repaints it.
  theme: Theme,
) {
  useEffect(() => {
    const target = map.current;
    const node = element.current;
    if (!target || !node || !layers?.edges.features.length) return;

    const points = heatPoints(layers, layer);
    const ramp = heatRamp(token("--level-low"), token("--level-mid"), token("--level-high"));
    const canvas = document.createElement("canvas");
    canvas.className = "heat-canvas";

    // The map centre when the canvas was painted, which is the canvas's own centre.
    let anchor: kakao.maps.LatLng | null = null;
    // Kakao calls `place` from inside setMap, before this is assigned.
    let overlay: kakao.maps.AbstractOverlay | null = null;

    function place() {
      if (!anchor) {
        draw();
        return;
      }
      const point = overlay?.getProjection()?.pointFromCoords(anchor);
      if (!point) return;
      canvas.style.left = `${point.x - canvas.width / 2}px`;
      canvas.style.top = `${point.y - canvas.height / 2}px`;
    }

    function draw() {
      const view = target?.getBounds();
      if (!view || !node || !overlay?.getProjection()) return;
      const sw = view.getSouthWest();
      const ne = view.getNorthEast();
      const pxPerLng = node.clientWidth / (ne.getLng() - sw.getLng());
      const pxPerLat = node.clientHeight / (ne.getLat() - sw.getLat());
      const cosLat = Math.cos((ne.getLat() * Math.PI) / 180);
      canvas.width = node.clientWidth + HEAT_MARGIN * 2;
      canvas.height = node.clientHeight + HEAT_MARGIN * 2;
      canvas.style.visibility = "";
      drawHeat(
        canvas,
        points,
        {
          west: sw.getLng() - HEAT_MARGIN / pxPerLng,
          north: ne.getLat() + HEAT_MARGIN / pxPerLat,
          pxPerLng,
          pxPerLat,
          metersPerPx: (111320 * cosLat) / pxPerLng,
        },
        ramp,
      );
      anchor = target?.getCenter() ?? null;
      place();
    }

    overlay = addToGraphicsLayer(target, canvas, place);
    draw();

    const hide = () => {
      canvas.style.visibility = "hidden";
    };

    kakao.maps.event.addListener(target, "center_changed", place);
    kakao.maps.event.addListener(target, "zoom_start", hide);
    kakao.maps.event.addListener(target, "idle", draw);

    const resize = new ResizeObserver(() => {
      target.relayout();
      draw();
    });
    resize.observe(node);

    return () => {
      resize.disconnect();
      kakao.maps.event.removeListener(target, "center_changed", place);
      kakao.maps.event.removeListener(target, "zoom_start", hide);
      kakao.maps.event.removeListener(target, "idle", draw);
      overlay?.setMap(null);
    };
  }, [map, element, layers, layer, theme]);
}

// The load heat and hotspots, plus any routes on top, with the selected one highlighted.
export function KakaoMap({
  bounds,
  layers,
  layer,
  routes,
  onRoutePick,
  onHotspot,
}: {
  bounds: Bounds;
  layers?: MapLayers;
  layer: Layer;
  routes?: MapRoute[];
  onRoutePick?: (id: string) => void;
  onHotspot: (hotspot: HotspotProps, point: Point) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useKakaoMap(element);
  const picked = useRef(onHotspot);
  const pickedRoute = useRef(onRoutePick);
  // Heat and route colours are read from the CSS tokens when drawn, so redraw on a theme flip.
  const [theme] = useTheme();

  useEffect(() => {
    picked.current = onHotspot;
    pickedRoute.current = onRoutePick;
  }, [onHotspot, onRoutePick]);

  useHeat(map, element, layers, layer, theme);

  // Picking another option must not move the view, so frame only when the trip changes.
  const trip = routes?.map((route) => `${route.id}:${route.line.coordinates.length}`).join();
  const paths = useRef(routes);
  useEffect(() => {
    paths.current = routes;
  }, [routes]);

  useEffect(() => {
    const frame = new kakao.maps.LatLngBounds();
    if (trip && paths.current) {
      paths.current.forEach((route) => route.line.coordinates.forEach((c) => frame.extend(toLatLng(c))));
      map.current?.setBounds(frame, 48, 48, 48, 48);
    } else {
      frame.extend(new kakao.maps.LatLng(bounds.min_lat, bounds.min_lng));
      frame.extend(new kakao.maps.LatLng(bounds.max_lat, bounds.max_lng));
      map.current?.setBounds(frame);
    }
  }, [map, bounds, trip]);

  useEffect(() => {
    const target = map.current;
    if (!target || !layers) return;

    const hotspots = layers.hotspots.features.map((hotspot) => {
      const { area_nm, crowd_label, crowd_level } = hotspot.properties;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hotspot";
      button.ariaLabel = `${area_nm}, 혼잡도 ${crowd_label}`;
      const number = document.createElement("span");
      number.textContent = String(crowd_level);
      button.append(number);
      button.addEventListener("click", () => picked.current(hotspot.properties, hotspot.geometry));
      return new kakao.maps.CustomOverlay({
        map: target,
        position: toLatLng(hotspot.geometry.coordinates),
        content: button,
        clickable: true,
        xAnchor: 0.5,
        yAnchor: 0.5,
      });
    });

    return () => hotspots.forEach((hotspot) => hotspot.setMap(null));
  }, [map, layers]);

  useEffect(() => {
    const target = map.current;
    const selected = routes?.find((route) => route.selected);
    if (!target || !routes || !selected) return;

    const lines = routes.flatMap((route) => {
      const path = route.line.coordinates.map(toLatLng);
      const main = new kakao.maps.Polyline({
        map: target,
        path,
        strokeColor: route.selected ? token("--primary") : token("--text-muted"),
        strokeWeight: route.selected ? 7 : 5,
        strokeOpacity: route.selected ? 1 : 0.6,
        zIndex: route.selected ? 3 : 1,
      });
      kakao.maps.event.addListener(main, "click", () => pickedRoute.current?.(route.id));
      if (!route.selected) return [main];
      // An edge in the surface colour keeps the selected route readable over the hottest
      // colours: pale in light mode, dark in dark mode.
      const casing = new kakao.maps.Polyline({
        map: target,
        path,
        strokeColor: token("--surface"),
        strokeWeight: 11,
        strokeOpacity: 0.9,
        zIndex: 2,
      });
      return [casing, main];
    });

    const { coordinates } = selected.line;
    const pins = [
      pin("출발", toLatLng(coordinates[0]), target),
      pin("도착", toLatLng(coordinates[coordinates.length - 1]), target),
    ];

    return () => {
      lines.forEach((line) => line.setMap(null));
      pins.forEach((item) => item.setMap(null));
    };
  }, [map, routes, theme]);

  return <div ref={element} className="kakao-map" />;
}
