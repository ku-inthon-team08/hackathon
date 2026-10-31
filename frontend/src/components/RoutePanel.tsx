"use client";

import { ArrowDownUp, Settings } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { quietRoutes } from "@/lib/api";
import { distance, LOAD_LABEL, levelOf } from "@/lib/format";
import { getPosition } from "@/lib/location";
import type { NamedPlace, Route, RouteKind, Sensitivity } from "@/lib/api/types";
import { PlaceField } from "./PlaceField";
import { LoadTag, Notice } from "./ui";

// `from: null` means "use my current location".
export type Plan =
  | {
      step: "search";
      from: NamedPlace | null;
      to: NamedPlace | null;
      error?: "no-location" | "failed";
    }
  | { step: "results"; from: NamedPlace | null; to: NamedPlace; routes: Route[]; open: RouteKind }
  | { step: "guiding"; from: NamedPlace | null; to: NamedPlace; route: Route };

const SENSES = [
  { key: "light", label: "빛", subject: "빛이" },
  { key: "noise", label: "소음", subject: "소음이" },
  { key: "crowd", label: "인파", subject: "인파가" },
] as const;

type Exposure = NonNullable<Route["exposure"]>;

function peakOf(exposure: Exposure) {
  const top = SENSES.reduce((a, b) => (exposure[b.key] > exposure[a.key] ? b : a));
  return `${top.subject} 가장 높아요`;
}

function recommendedOf(routes: Route[]) {
  return routes.length ? routes.reduce((a, b) => (b.avg_load < a.avg_load ? b : a)) : undefined;
}

// The BE can return one road for two kinds. The later kind wins, as the quieter promise.
function distinctRoutes(routes: Route[]) {
  const byPath = new Map<string, Route>();
  routes.forEach((route) => byPath.set(JSON.stringify(route.geometry.coordinates), route));
  return [...byPath.values()];
}

function tradeOff(route: Route) {
  const { extra_distance_pct: extra, exposure_change_pct: exposure } = route;
  if (route.kind === "shortest" || !extra || exposure === null) return "가장 짧은 길";
  const change = exposure < 0 ? `${-exposure}% 감소` : `${exposure}% 증가`;
  return `${extra}% 더 걷고 노출 ${change}`;
}

export function usePlanner(sens: Sensitivity, initialTo: NamedPlace | null) {
  const [plan, setPlan] = useState<Plan>({ step: "search", from: null, to: initialTo });
  const [busy, setBusy] = useState(false);

  // Pass `answers` right after the survey, before the saved value reaches this hook.
  async function search(from: NamedPlace | null, to: NamedPlace, answers = sens) {
    setBusy(true);
    const start = from ?? (await getPosition().catch(() => null));
    if (!start) {
      setPlan({ step: "search", from, to, error: "no-location" });
      setBusy(false);
      return;
    }
    try {
      const routes = distinctRoutes((await quietRoutes(start, to, answers)).routes);
      const open = recommendedOf(routes)?.kind ?? "balanced";
      setPlan({ step: "results", from, to, routes, open });
    } catch {
      setPlan({ step: "search", from, to, error: "failed" });
    } finally {
      setBusy(false);
    }
  }

  return { plan, setPlan, busy, search };
}

function SearchForm({
  plan,
  busy,
  onEdit,
  onSearch,
}: {
  plan: Extract<Plan, { step: "search" }>;
  busy: boolean;
  onEdit: (next: { from: NamedPlace | null; to: NamedPlace | null }) => void;
  onSearch: (from: NamedPlace | null, to: NamedPlace) => void;
}) {
  const { from, to, error } = plan;
  const [toError, setToError] = useState<string>();
  // An unreadable location leaves 출발지 empty instead of claiming "현재 위치".
  const fromText = from?.name ?? (error === "no-location" ? "" : "현재 위치");
  const toInput = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const noLocation = error === "no-location";

  // Carry on to the next empty step, so the whole search works from the keyboard.
  function pickFrom(place: NamedPlace | null) {
    onEdit({ from: place, to });
    (to ? submitButton : toInput).current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!to) {
      setToError("도착지를 검색해서 선택해 주세요.");
      return;
    }
    onSearch(from, to);
  }

  return (
    <form className="stack-large" onSubmit={submit} noValidate>
      <div className="stack">
        {/* One box for both ends, split by a line, with the swap button on that line. */}
        <div className="route-fields">
          <PlaceField
            key={`from:${fromText}`}
            hideLabel
            clearOnFocus
            label="출발지"
            value={fromText}
            accent={!from && !noLocation}
            placeholder="출발지 입력"
            leading={{ label: "현재 위치", onPick: () => pickFrom(null) }}
            invalid={noLocation}
            describedBy={noLocation ? `${id}-from-error` : undefined}
            onPick={pickFrom}
          />
          <PlaceField
            key={`to:${to?.name ?? ""}`}
            ref={toInput}
            hideLabel
            label="도착지"
            value={to?.name}
            placeholder="도착지 입력"
            invalid={Boolean(toError)}
            describedBy={toError ? `${id}-to-error` : undefined}
            onPick={(place) => {
              setToError(undefined);
              onEdit({ from, to: place });
              submitButton.current?.focus();
            }}
          />
          <button
            type="button"
            className="icon-button swap"
            aria-label="출발지와 도착지 바꾸기"
            disabled={!from || !to}
            onClick={() => onEdit({ from: to, to: from })}
          >
            <ArrowDownUp aria-hidden />
          </button>
        </div>
        {noLocation && (
          <p id={`${id}-from-error`} className="error" role="alert">
            위치를 확인할 수 없어요. 출발지를 검색해 주세요.
          </p>
        )}
        {toError && (
          <p id={`${id}-to-error`} className="error" role="alert">
            {toError}
          </p>
        )}
      </div>
      {error === "failed" && (
        <p className="error" role="alert">
          경로를 찾지 못했어요. 연결을 확인하고 다시 시도해 주세요.
        </p>
      )}
      <button
        ref={submitButton}
        type="submit"
        className="button primary"
        aria-busy={busy}
        disabled={busy}
      >
        {busy ? "경로 찾는 중…" : "길찾기"}
      </button>
    </form>
  );
}

function Bars({ exposure }: { exposure: Exposure }) {
  return (
    <ul className="bars" aria-label="이 경로의 감각 노출">
      {SENSES.map((sense) => {
        const value = exposure[sense.key];
        return (
          <li key={sense.key}>
            <span className="bar" aria-hidden>
              <span style={{ height: `${Math.round(value * 100)}%` }} />
            </span>
            <span className="bar-label">{sense.label}</span>
            <span className="bar-level">{LOAD_LABEL[levelOf(value)]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RouteOptions({
  plan,
  onPlan,
}: {
  plan: Extract<Plan, { step: "results" }>;
  onPlan: (plan: Plan) => void;
}) {
  const { from, to, routes, open } = plan;
  const recommended = recommendedOf(routes);
  const edit = () => onPlan({ step: "search", from, to });

  return (
    <div className="stack-large">
      <p className="trip-summary">
        <span>{from?.name ?? "현재 위치"}</span>
        <span aria-label="에서">→</span>
        <span>{to.name}</span>
        <button type="button" className="text-button" onClick={edit}>
          변경
        </button>
      </p>
      {routes.length === 0 ? (
        <Notice pose="lie-down-side" title="경로를 찾지 못했어요">
          서울 안의 다른 장소로 다시 찾아 주세요.
        </Notice>
      ) : (
        <ul className="options">
          {routes.map((route, i) => {
            const expanded = route.kind === open;
            const bodyId = `option-${route.kind}`;
            return (
              <li key={route.kind} className={expanded ? "option open" : "option"}>
                <button
                  type="button"
                  className="option-head"
                  aria-expanded={expanded}
                  aria-controls={bodyId}
                  onClick={() => onPlan({ ...plan, open: route.kind })}
                >
                  <span className="row-title">
                    옵션 {i + 1}
                    {route === recommended && <span className="tag recommended">추천</span>}
                  </span>
                  <span className="row-meta">
                    {route.label} · 도보 {route.walk_min}분
                    {route.exposure && ` · ${peakOf(route.exposure)}`}
                  </span>
                </button>
                {expanded && (
                  <div id={bodyId} className="option-body">
                    {route.exposure && <Bars exposure={route.exposure} />}
                    <p className="row-meta">{tradeOff(route)}</p>
                    <p className="row-meta">
                      {distance(route.distance_m)} <LoadTag level={route.load_level} />
                    </p>
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => onPlan({ step: "guiding", from, to, route })}
                    >
                      선택
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Guiding({
  plan,
  onPlan,
  onArrive,
}: {
  plan: Extract<Plan, { step: "guiding" }>;
  onPlan: (plan: Plan) => void;
  onArrive: () => void;
}) {
  const { from, to, route } = plan;
  return (
    <section className="stack-large" aria-labelledby="guiding-title">
      <div className="stack">
        <p className="eyebrow" role="status">
          안내 중
        </p>
        <h2 id="guiding-title">{to.name}까지</h2>
        <p className="row-meta">
          {route.label} · 도보 {route.walk_min}분 · {distance(route.distance_m)}{" "}
          <LoadTag level={route.load_level} />
        </p>
      </div>
      <div className="stack">
        <button type="button" className="button primary" onClick={onArrive}>
          도착했어요
        </button>
        <button type="button" className="button" onClick={() => onPlan({ step: "search", from, to })}>
          안내 종료
        </button>
      </div>
    </section>
  );
}

export function RoutePanel({
  id,
  planner,
  onSettings,
  onArrive,
}: {
  id: string;
  planner: ReturnType<typeof usePlanner>;
  onSettings: () => void;
  onArrive: () => void;
}) {
  const { plan, setPlan, busy, search } = planner;
  return (
    <aside id={id} className="panel">
      <header className="panel-brand">
        <h1>고요하길</h1>
        <button type="button" className="icon-button" aria-label="민감도 설정" onClick={onSettings}>
          <Settings aria-hidden />
        </button>
      </header>
      {plan.step === "search" && (
        <section className="stack" aria-labelledby={`${id}-search`}>
          <h2 id={`${id}-search`}>고요한 길 찾기</h2>
          <SearchForm
            plan={plan}
            busy={busy}
            onEdit={(next) => setPlan({ step: "search", ...next })}
            onSearch={search}
          />
        </section>
      )}
      {plan.step === "results" && <RouteOptions plan={plan} onPlan={setPlan} />}
      {plan.step === "guiding" && <Guiding plan={plan} onPlan={setPlan} onArrive={onArrive} />}
    </aside>
  );
}
