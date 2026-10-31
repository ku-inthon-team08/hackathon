"use client";

import { Check, LocateFixed } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { BestTimes } from "@/components/BestTimes";
import { RouteMap } from "@/components/MapCanvas";
import { PlaceField } from "@/components/PlaceField";
import { LoadTag, Mascot, Notice, TopBar } from "@/components/ui";
import { quietRoutes } from "@/lib/api";
import { distance } from "@/lib/format";
import { getPosition } from "@/lib/location";
import { saveTrip, useSensitivity } from "@/lib/storage";
import type { NamedPlace, Route, RouteKind } from "@/lib/api/types";

function tradeOff(route: Route) {
  const { extra_distance_pct: extra, exposure_change_pct: exposure } = route;
  if (route.kind === "shortest" || extra === null || exposure === null) return "가장 짧은 길";
  const change = exposure < 0 ? `${-exposure}% 감소` : `${exposure}% 증가`;
  return `${extra}% 더 걷고 노출 ${change}`;
}

function Chosen({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: () => void;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="chosen">
        <span>{value}</span>
        <button type="button" className="text-button" onClick={onChange}>
          변경
        </button>
      </div>
    </div>
  );
}

function initialDestination(params: URLSearchParams): NamedPlace | null {
  const name = params.get("toName");
  const lat = Number(params.get("toLat"));
  const lng = Number(params.get("toLng"));
  return name && lat && lng ? { name, lat, lng } : null;
}

export function RoutePlanner() {
  const router = useRouter();
  const params = useSearchParams();
  const { sens } = useSensitivity();

  // null means "use my current location".
  const [from, setFrom] = useState<NamedPlace | null>(null);
  const [editingFrom, setEditingFrom] = useState(false);
  const [to, setTo] = useState(() => initialDestination(params));
  const [fromError, setFromError] = useState<string>();
  const [toError, setToError] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [selected, setSelected] = useState<RouteKind>("quietest");

  const onCompare = params.get("step") === "2" && routes !== null && to !== null;

  async function findRoutes(event: React.FormEvent) {
    event.preventDefault();
    setFailed(false);
    if (!to) {
      setToError("도착지를 검색해서 선택해 주세요.");
      return;
    }
    setBusy(true);
    const start = from ?? (await getPosition().catch(() => null));
    if (!start) {
      setBusy(false);
      setEditingFrom(true);
      setFromError("위치를 확인할 수 없어요. 출발지를 검색해 주세요.");
      return;
    }
    try {
      const result = await quietRoutes(start, to, sens);
      setRoutes(result.routes);
      setSelected("quietest");
      router.push("/route?step=2");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (onCompare) {
    const chosen = routes.find((route) => route.kind === selected);
    return (
      <main className="page with-action">
        <TopBar title={`${to.name}까지`} onBack={() => router.back()} />
        {routes.length === 0 ? (
          <Notice pose="lie-down-side" title="경로를 찾지 못했어요">
            서울 안의 다른 장소로 다시 찾아 주세요.
          </Notice>
        ) : (
          <>
            <div className="section-title">
              <Mascot pose="point-present" height={56} />
              <p>가장 조용한 경로를 먼저 골라뒀어요.</p>
            </div>
            {chosen && (
              <RouteMap
                line={chosen.geometry}
                label={`${chosen.label} 경로 미리보기, 도보 ${chosen.walk_min}분`}
              />
            )}
            <ul className="rows">
              {routes.map((route) => (
                <li key={route.kind}>
                  <button
                    type="button"
                    className="row"
                    aria-pressed={route.kind === selected}
                    onClick={() => setSelected(route.kind)}
                  >
                    <span className="row-title">
                      {route.label}
                      {route.kind === selected && <Check aria-hidden />}
                    </span>
                    <span className="row-meta">
                      도보 {route.walk_min}분 · {distance(route.distance_m)}
                    </span>
                    <span className="row-meta">{tradeOff(route)}</span>
                    <span className="row-tags">
                      <LoadTag level={route.load_level} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <details className="more">
              <summary>덜 붐비는 시간 보기</summary>
              <BestTimes lat={to.lat} lng={to.lng} />
            </details>
            <div className="bottom-action">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  if (!chosen) return;
                  saveTrip({ route: chosen, destination: to });
                  router.push(`/navigate/${chosen.kind}`);
                }}
              >
                안내 시작
              </button>
            </div>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="page">
      <TopBar title="길 찾기" />
      <form className="stack-large" onSubmit={findRoutes} noValidate>
        {editingFrom && !from ? (
          <PlaceField
            label="출발"
            error={fromError}
            onPick={(place) => {
              setFrom(place);
              setFromError(undefined);
            }}
          />
        ) : (
          <Chosen
            label="출발"
            value={from?.name ?? "현재 위치"}
            onChange={() => {
              setFrom(null);
              setEditingFrom(true);
            }}
          />
        )}
        {editingFrom && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setFrom(null);
              setFromError(undefined);
              setEditingFrom(false);
            }}
          >
            <LocateFixed aria-hidden />
            현재 위치 사용
          </button>
        )}
        {to ? (
          <Chosen label="도착" value={to.name} onChange={() => setTo(null)} />
        ) : (
          <PlaceField
            label="도착"
            error={toError}
            onPick={(place) => {
              setTo(place);
              setToError(undefined);
            }}
          />
        )}
        {failed && (
          <p className="error" role="alert">
            경로를 찾지 못했어요. 연결을 확인하고 다시 시도해 주세요.
          </p>
        )}
        <button type="submit" className="button primary" aria-busy={busy} disabled={busy}>
          {busy ? "경로 찾는 중…" : "경로 찾기"}
        </button>
      </form>
    </main>
  );
}
