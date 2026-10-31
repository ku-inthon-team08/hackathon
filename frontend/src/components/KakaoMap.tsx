"use client";

import { useEffect, useRef } from "react";
import { levelOf } from "@/lib/format";
import type { Bounds, HotspotProps, LineString, MapLayers, Point } from "@/lib/api/types";
import "@/lib/kakao";
import type { Layer } from "./MapCanvas";

const toLatLng = ([lng, lat]: [number, number]) => new kakao.maps.LatLng(lat, lng);

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Same width and dash per level as the stand-in, so level never rests on colour alone.
function lineStyle(level: "low" | "mid" | "high") {
  return {
    low: { strokeWeight: 3, strokeStyle: "shortdash" as const },
    mid: { strokeWeight: 5, strokeStyle: "solid" as const },
    high: { strokeWeight: 8, strokeStyle: "solid" as const },
  }[level];
}

function useKakaoMap(element: React.RefObject<HTMLDivElement | null>) {
  const map = useRef<kakao.maps.Map | null>(null);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    map.current = new kakao.maps.Map(node, {
      center: new kakao.maps.LatLng(37.5894, 127.0323),
      level: 5,
    });
    return () => {
      map.current = null;
      node.replaceChildren();
    };
  }, [element]);
  return map;
}

export function KakaoHomeMap({
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
  const element = useRef<HTMLDivElement>(null);
  const map = useKakaoMap(element);
  const picked = useRef(onHotspot);

  useEffect(() => {
    picked.current = onHotspot;
  }, [onHotspot]);

  useEffect(() => {
    map.current?.setBounds(
      new kakao.maps.LatLngBounds(
        new kakao.maps.LatLng(bounds.min_lat, bounds.min_lng),
        new kakao.maps.LatLng(bounds.max_lat, bounds.max_lng),
      ),
    );
  }, [map, bounds]);

  useEffect(() => {
    const target = map.current;
    if (!target || !layers) return;

    const lines = layers.edges.features.map((edge) => {
      const level = levelOf(edge.properties[layer]);
      return new kakao.maps.Polyline({
        map: target,
        path: edge.geometry.coordinates.map(toLatLng),
        strokeColor: token(`--level-${level}`),
        strokeOpacity: 0.5,
        ...lineStyle(level),
      });
    });

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

    return () => {
      lines.forEach((line) => line.setMap(null));
      hotspots.forEach((hotspot) => hotspot.setMap(null));
    };
  }, [map, layers, layer]);

  return <div ref={element} className="kakao-map" />;
}

function pin(label: string, position: kakao.maps.LatLng, target: kakao.maps.Map) {
  const content = document.createElement("span");
  content.className = "pin";
  content.textContent = label;
  return new kakao.maps.CustomOverlay({ map: target, position, content, xAnchor: 0.5, yAnchor: 0.5 });
}

export function KakaoRouteMap({ line }: { line: LineString }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useKakaoMap(element);

  useEffect(() => {
    const target = map.current;
    if (!target) return;
    const path = line.coordinates.map(toLatLng);
    const bounds = new kakao.maps.LatLngBounds();
    path.forEach((point) => bounds.extend(point));
    target.setBounds(bounds, 48, 48, 48, 48);

    const route = new kakao.maps.Polyline({
      map: target,
      path,
      strokeColor: token("--focus"),
      strokeWeight: 6,
      strokeOpacity: 0.85,
    });
    const pins = [pin("출발", path[0], target), pin("도착", path[path.length - 1], target)];

    return () => {
      route.setMap(null);
      pins.forEach((item) => item.setMap(null));
    };
  }, [map, line]);

  return <div ref={element} className="kakao-map" />;
}
