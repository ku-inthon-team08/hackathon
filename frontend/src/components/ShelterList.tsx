"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { nearbyShelters } from "@/lib/api";
import { distance, KIND_LABEL } from "@/lib/format";
import { getPosition } from "@/lib/location";
import type { LatLng, NamedPlace, Sensitivity, Shelter } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";
import { PlaceField } from "./PlaceField";
import type { SheetTarget } from "./PlaceSheet";
import { LoadFailed, LoadTag, Mascot, Notice, SkeletonRows } from "./ui";

export const TOP_N = 3;

// The number on each row matches the shelter's marker on the map.
export function ShelterList({
  origin,
  sens,
  onPick,
  onItems,
}: {
  origin: LatLng;
  sens: Sensitivity;
  onPick: (target: SheetTarget) => void;
  // The rows on screen, so the map can mark the same places.
  onItems?: (items: Shelter[]) => void;
}) {
  const [minutes, setMinutes] = useState(10);
  const load = useCallback(() => nearbyShelters(origin, minutes, sens), [origin, minutes, sens]);
  const { data, error, loading, refresh } = useAsync(load);
  // The BE already sorts: open, then unknown hours, then closed; best score first within each.
  const items = useMemo(() => data?.items.slice(0, TOP_N), [data]);

  useEffect(() => {
    onItems?.(items ?? []);
  }, [items, onItems]);

  if (error) return <LoadFailed what="쉼터를" onRetry={refresh} />;
  if (loading || !items) return <SkeletonRows count={TOP_N} label="쉼터 찾는 중" />;
  if (items.length === 0) {
    return (
      <Notice
        pose="lie-down-side"
        title={`도보 ${minutes}분 안에 쉼터가 없어요`}
        action={
          minutes < 20 && (
            <button type="button" className="button" onClick={() => setMinutes(20)}>
              도보 20분까지 찾기
            </button>
          )
        }
      />
    );
  }

  return (
    <ul className="rows">
      {items.map((item, i) => (
        <li key={item.id}>
          <button
            type="button"
            className="row"
            onClick={() => onPick({ placeId: item.id, name: item.name, lat: item.lat, lng: item.lng })}
          >
            <span className="row-title">
              <span className="place-rank" aria-hidden>
                {i + 1}
              </span>
              {item.name}
            </span>
            <span className="row-meta">
              {item.category ?? KIND_LABEL[item.kind]} · 도보 {item.walk_min}분 · {distance(item.distance_m)}
            </span>
            <span className="row-tags">
              <LoadTag level={item.load_level} />
              <span className="tag">
                {item.is_open === null ? "운영시간 확인 필요" : item.is_open ? "운영 중" : "운영 종료"}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Where to search from: the current location, or a place typed in the box.
// Like 출발지, the empty box offers 현재 위치 on focus, so a typed place can be undone.
export function ShelterSearch({
  sens,
  onPick,
  onItems,
}: {
  sens: Sensitivity;
  onPick: (target: SheetTarget) => void;
  onItems?: (items: Shelter[]) => void;
}) {
  const [typed, setTyped] = useState<NamedPlace | null>(null);
  const position = useAsync(getPosition);
  const here = position.data;
  const origin = typed ?? here;
  const denied = !here && Boolean(position.error);
  const fieldText = typed?.name ?? (here ? "현재 위치" : "");

  function pickHere() {
    setTyped(null);
    // A denied or failed lookup may work now, e.g. after allowing location in the browser.
    if (!here) position.refresh();
  }

  return (
    <>
      {!origin && denied && (
        <div className="section-title">
          <Mascot pose="search" height={64} />
          <p>위치를 확인할 수 없어요. 역이나 장소 이름으로 찾아 주세요.</p>
        </div>
      )}
      {(origin || denied) && (
        <PlaceField
          key={`at:${fieldText}`}
          label="지금 어디에 있나요?"
          value={fieldText}
          accent={!typed && Boolean(here)}
          clearOnFocus
          placeholder="역이나 장소 이름"
          leading={{ label: "현재 위치", onPick: pickHere }}
          onPick={setTyped}
        />
      )}
      {!origin && !denied && <SkeletonRows count={TOP_N} label="현재 위치 확인 중" />}
      {origin && <ShelterList origin={origin} sens={sens} onPick={onPick} onItems={onItems} />}
    </>
  );
}

// Shelter search inside the home panel.
export function ShelterPanel({
  id,
  sens,
  onPick,
  onItems,
  onClose,
}: {
  id: string;
  sens: Sensitivity;
  onPick: (target: SheetTarget) => void;
  onItems: (items: Shelter[]) => void;
  onClose: () => void;
}) {
  return (
    <aside id={id} className="panel">
      <header className="panel-brand">
        <h1>고요하길</h1>
        <button type="button" className="icon-button" aria-label="쉼터 찾기 닫기" onClick={onClose}>
          <X aria-hidden />
        </button>
      </header>
      <section className="stack" aria-labelledby={`${id}-shelters`}>
        <h2 id={`${id}-shelters`}>가까운 쉼터</h2>
        <ShelterSearch sens={sens} onPick={onPick} onItems={onItems} />
      </section>
    </aside>
  );
}
