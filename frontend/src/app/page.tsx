"use client";

import { ChevronLeft, ChevronRight, Moon, Sun, Trees } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FeedbackSheet } from "@/components/FeedbackSheet";
import { type Layer, type MapRoute, SensoryMap } from "@/components/MapCanvas";
import { PlaceSheet, type SheetTarget } from "@/components/PlaceSheet";
import { RoutePanel, usePlanner } from "@/components/RoutePanel";
import { SensitivityModal } from "@/components/SensitivityModal";
import { dataStatus, mapLayers } from "@/lib/api";
import { LOAD_LABEL, levelOf } from "@/lib/format";
import { getPosition, MAP_BOUNDS } from "@/lib/location";
import { useSensitivity } from "@/lib/storage";
import { useTheme } from "@/lib/theme";
import type { DataStatus, MapLayers, NamedPlace, Sensitivity } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

const POLL_MS = 5 * 60 * 1000;
const PANEL_ID = "route-panel";

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
    label: `${age}분 전 업데이트`,
    stale: status.sources.some((s) => !s.last_try_ok),
  };
}

function areaSummary(layers: MapLayers | undefined, layer: Layer) {
  const edges = layers?.edges.features;
  if (!edges?.length) return null;
  const total = edges.reduce((sum, edge) => sum + edge.properties[layer], 0);
  return LOAD_LABEL[levelOf(total / edges.length)];
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label="어두운 화면"
      aria-pressed={dark}
      title={dark ? "밝은 화면으로" : "어두운 화면으로"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </button>
  );
}

// The refuge page sends a destination back as ?toName=&toLat=&toLng=.
function destinationFrom(params: URLSearchParams): NamedPlace | null {
  const name = params.get("toName");
  const lat = Number(params.get("toLat"));
  const lng = Number(params.get("toLng"));
  return name && lat && lng ? { name, lat, lng } : null;
}

function Home({
  sens,
  firstVisit,
  initialTo,
  onSurvey,
}: {
  sens: Sensitivity;
  firstVisit: boolean;
  initialTo: NamedPlace | null;
  onSurvey: (answers?: Sensitivity) => void;
}) {
  const planner = usePlanner(sens, initialTo);
  const { plan, setPlan } = planner;
  const [panelOpen, setPanelOpen] = useState(true);
  const [layer, setLayer] = useState<Layer>("load");
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const [arrived, setArrived] = useState(false);

  // Next keeps visited pages alive, so close any sheet when this page hides.
  useLayoutEffect(
    () => () => {
      setTarget(null);
      setSurveyOpen(false);
      setArrived(false);
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
  const isEmpty = layers.data && layers.data.edges.features.length === 0;
  const shown =
    plan.step === "results"
      ? plan.routes.find((route) => route.kind === plan.open)
      : plan.step === "guiding"
        ? plan.route
        : undefined;
  const mapRoutes = useMemo<MapRoute[] | undefined>(() => {
    if (plan.step === "guiding") {
      return [{ id: plan.route.kind, line: plan.route.geometry, selected: true }];
    }
    if (plan.step !== "results" || plan.routes.length === 0) return undefined;
    return plan.routes.map((route) => ({
      id: route.kind,
      line: route.geometry,
      selected: route.kind === plan.open,
    }));
  }, [plan]);

  function closeSurvey(answers?: Sensitivity) {
    onSurvey(answers);
    setSurveyOpen(false);
    // Routes on screen were ranked for the old answers, so rank them again.
    if (answers && plan.step === "results") planner.search(plan.from, plan.to, answers);
    // Ask for location right after the first survey, when the reason is fresh.
    if (firstVisit) getPosition().catch(() => {});
  }

  function goTo(destination: NamedPlace) {
    setTarget(null);
    setPanelOpen(true);
    planner.search(plan.step === "search" ? plan.from : null, destination);
  }

  return (
    <main className={panelOpen ? "app" : "app collapsed"}>
      {panelOpen && (
        <RoutePanel
          id={PANEL_ID}
          planner={planner}
          onSettings={() => setSurveyOpen(true)}
          onArrive={() => setArrived(true)}
        />
      )}

      <section className="map-area" aria-label="감각 지도">
        <SensoryMap
          bounds={MAP_BOUNDS}
          layers={layers.data}
          layer={layer}
          routes={mapRoutes}
          routeLabel={shown && `${plan.to?.name}까지 ${shown.label} 경로`}
          onRoutePick={(id) => {
            const route = plan.step === "results" && plan.routes.find((r) => r.kind === id);
            if (route) setPlan({ ...plan, open: route.kind } as typeof plan);
          }}
          onHotspot={(hotspot, point) =>
            setTarget({
              name: hotspot.area_nm,
              lng: point.coordinates[0],
              lat: point.coordinates[1],
              crowd: { label: hotspot.crowd_label, observedAt: hotspot.observed_at },
            })
          }
        />

        <button
          type="button"
          className="panel-toggle"
          aria-expanded={panelOpen}
          aria-controls={PANEL_ID}
          aria-label={panelOpen ? "경로 패널 접기" : "경로 패널 펼치기"}
          onClick={() => setPanelOpen(!panelOpen)}
        >
          {panelOpen ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
        </button>

        <div className="map-top">
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
          <div className="map-status">
            <ThemeToggle />
            <span className="chip" role="status">
              {label}
            </span>
          </div>
          {stale && <p className="banner">최신 데이터를 받지 못해 예전 값을 보여주고 있어요.</p>}
          {Boolean(layers.error) && (
            <p className="banner">
              지금은 이 정보를 볼 수 없어요.
              <button type="button" className="text-button" onClick={layers.refresh}>
                다시 시도
              </button>
            </p>
          )}
          {isEmpty && !layers.error && <p className="banner">지금은 이 정보를 볼 수 없어요.</p>}
          {layers.loading && !layers.data && (
            <p className="banner" role="status">
              지도 정보를 불러오는 중…
            </p>
          )}
        </div>

        <div className="map-bottom">
          <div className="legend">
            <p role="status">
              {summary ? `이 지역 ${layerName}: ${summary}` : `${layerName} 정보 없음`}
            </p>
            <ul>
              <li>
                낮음 <i className="heat-scale" /> 높음
              </li>
              <li>
                <i className="swatch-hotspot" /> 혼잡 1~4
              </li>
            </ul>
          </div>
          <Link className="refuge-button" href="/refuges">
            <Trees aria-hidden />
            쉼공간 찾기
          </Link>
        </div>
      </section>

      {(firstVisit || surveyOpen) && (
        <SensitivityModal initial={firstVisit ? undefined : sens} onClose={closeSurvey} />
      )}
      {target && <PlaceSheet target={target} onClose={() => setTarget(null)} onGo={goTo} />}
      {arrived && plan.step === "guiding" && (
        <FeedbackSheet
          destination={plan.to}
          onClose={() => setArrived(false)}
          onDone={() => {
            setArrived(false);
            setPlan({ step: "search", from: plan.from, to: null });
          }}
        />
      )}
    </main>
  );
}

function HomeGate() {
  const params = useSearchParams();
  const { ready, saved, sens, save } = useSensitivity();

  if (!ready) return <main className="app" aria-busy />;
  // A new destination from the URL starts a fresh plan.
  return (
    <Home
      key={params.toString()}
      sens={sens}
      firstVisit={!saved}
      initialTo={destinationFrom(params)}
      // Dismissing the first survey keeps the defaults, so it does not come back.
      onSurvey={(answers) => save(answers ?? sens)}
    />
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<main className="app" aria-busy />}>
      <HomeGate />
    </Suspense>
  );
}
