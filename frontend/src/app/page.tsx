"use client";

import { Route as RouteIcon, Settings, Trees } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { HomeMap, type Layer } from "@/components/MapCanvas";
import { PlaceSheet, type SheetTarget } from "@/components/PlaceSheet";
import { SensitivitySheet } from "@/components/SensitivitySheet";
import { dataStatus, mapLayers } from "@/lib/api";
import { LOAD_LABEL, levelOf } from "@/lib/format";
import { MAP_BOUNDS } from "@/lib/location";
import { useSensitivity } from "@/lib/storage";
import type { DataStatus, MapLayers, Sensitivity } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

const POLL_MS = 5 * 60 * 1000;
// docs/api.md has no staleness rule beyond last_try_ok, so this is our own cut-off.
const STALE_MIN = 30;

const LAYERS: { value: Layer; label: string }[] = [
  { value: "load", label: "종합" },
  { value: "noise_n", label: "소리" },
  { value: "light_n", label: "빛" },
  { value: "crowd_n", label: "인파" },
];

function freshness(status?: DataStatus) {
  if (!status) return { label: "데이터 확인 중", stale: false };
  const ages = status.sources.flatMap((s) => (s.age_min === null ? [] : [s.age_min]));
  if (ages.length === 0) return { label: "아직 수집된 데이터가 없어요", stale: false };
  const age = Math.max(...ages);
  return {
    label: `${age}분 전 데이터`,
    stale: age >= STALE_MIN || status.sources.some((s) => !s.last_try_ok),
  };
}

function areaSummary(layers: MapLayers | undefined, layer: Layer) {
  const edges = layers?.edges.features;
  if (!edges?.length) return null;
  const total = edges.reduce((sum, edge) => sum + edge.properties[layer], 0);
  return LOAD_LABEL[levelOf(total / edges.length)];
}

function Home({ sens }: { sens: Sensitivity }) {
  const [layer, setLayer] = useState<Layer>("load");
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const [editing, setEditing] = useState(false);

  // Next keeps visited pages alive, so close any sheet when this page hides.
  useLayoutEffect(
    () => () => {
      setTarget(null);
      setEditing(false);
    },
    [],
  );

  const loadLayers = useCallback(() => mapLayers(MAP_BOUNDS, sens), [sens]);
  const layers = useAsync(loadLayers);
  const status = useAsync(dataStatus);
  const { refresh: refreshLayers } = layers;
  const { refresh: refreshStatus } = status;

  useEffect(() => {
    const timer = setInterval(() => {
      refreshLayers();
      refreshStatus();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshLayers, refreshStatus]);

  const { label, stale } = freshness(status.data);
  const summary = areaSummary(layers.data, layer);
  const layerName = LAYERS.find((l) => l.value === layer)?.label;
  const hasLayers = Boolean(
    layers.data?.edges.features.length || layers.data?.hotspots.features.length,
  );

  return (
    <main className="home">
      <h1 className="visually-hidden">감각 지도</h1>
      <HomeMap
        bounds={MAP_BOUNDS}
        layers={layers.data}
        layer={layer}
        onHotspot={(hotspot, point) =>
          setTarget({
            name: hotspot.area_nm,
            lng: point.coordinates[0],
            lat: point.coordinates[1],
            crowd: { label: hotspot.crowd_label, observedAt: hotspot.observed_at },
          })
        }
      />

      <div className="home-top">
        <div className="chip-row">
          <span className="chip" role="status">
            {label}
          </span>
          <button
            type="button"
            className="icon-button float"
            aria-label="내 감각 설정"
            onClick={() => setEditing(true)}
          >
            <Settings aria-hidden />
          </button>
        </div>
        {stale && <p className="banner">최신 데이터를 받지 못해 예전 값을 보여주고 있어요.</p>}
        {hasLayers && (
          <fieldset className="segments">
            <legend className="visually-hidden">지도 레이어</legend>
            {LAYERS.map((item) => (
              <label key={item.value}>
                <input
                  type="radio"
                  name="layer"
                  checked={layer === item.value}
                  onChange={() => setLayer(item.value)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </fieldset>
        )}
        {Boolean(layers.error) && (
          <p className="banner">
            지금은 이 정보를 볼 수 없어요.
            <button type="button" className="text-button" onClick={layers.refresh}>
              다시 시도
            </button>
          </p>
        )}
        {layers.loading && !layers.data && (
          <p className="banner" role="status">
            지도 정보를 불러오는 중…
          </p>
        )}
      </div>

      <div className="home-bottom">
        {hasLayers && (
          <div className="legend">
            <p role="status">
              {summary ? `이 지역 ${layerName}: ${summary}` : `${layerName} 정보 없음`}
            </p>
            <ul>
              <li>
                <i className="swatch load-low" /> 낮음
              </li>
              <li>
                <i className="swatch load-mid" /> 보통
              </li>
              <li>
                <i className="swatch load-high" /> 높음
              </li>
              <li>
                <i className="swatch-hotspot" /> 혼잡 1~4
              </li>
            </ul>
          </div>
        )}
        <div className="home-actions">
          <Link className="button float" href="/route">
            <RouteIcon aria-hidden />길 찾기
          </Link>
          <Link className="refuge-button" href="/refuges">
            <Trees aria-hidden />
            쉼터 찾기
          </Link>
        </div>
      </div>

      {target && <PlaceSheet target={target} onClose={() => setTarget(null)} />}
      {editing && <SensitivitySheet onClose={() => setEditing(false)} />}
    </main>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { ready, saved, sens } = useSensitivity();

  useEffect(() => {
    if (ready && !saved) router.replace("/welcome");
  }, [ready, saved, router]);

  if (!ready || !saved) return <main className="home" aria-busy />;
  return <Home sens={sens} />;
}
