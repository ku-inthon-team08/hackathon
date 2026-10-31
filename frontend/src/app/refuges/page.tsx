"use client";

import { useRouter } from "next/navigation";
import { useCallback, useLayoutEffect, useState } from "react";
import { PlaceField } from "@/components/PlaceField";
import { PlaceSheet, type SheetTarget } from "@/components/PlaceSheet";
import { LoadFailed, LoadTag, Mascot, Notice, SkeletonRows, TopBar } from "@/components/ui";
import { nearbyShelters } from "@/lib/api";
import { distance, KIND_LABEL } from "@/lib/format";
import { getPosition } from "@/lib/location";
import { useSensitivity } from "@/lib/storage";
import type { LatLng, Sensitivity } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

const TOP_N = 3;

function ShelterList({
  origin,
  sens,
  onPick,
}: {
  origin: LatLng;
  sens: Sensitivity;
  onPick: (target: SheetTarget) => void;
}) {
  const [minutes, setMinutes] = useState(10);
  const load = useCallback(() => nearbyShelters(origin, minutes, sens), [origin, minutes, sens]);
  const { data, error, loading, refresh } = useAsync(load);

  if (error) return <LoadFailed what="쉼터를" onRetry={refresh} />;
  if (loading || !data) return <SkeletonRows count={TOP_N} label="쉼터 찾는 중" />;
  if (data.items.length === 0) {
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

  // The BE already sorts: open, then unknown hours, then closed; best score first within each.
  const items = data.items.slice(0, TOP_N);
  return (
    <ul className="rows">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="row"
            onClick={() => onPick({ placeId: item.id, name: item.name, lat: item.lat, lng: item.lng })}
          >
            <span className="row-title">{item.name}</span>
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

export default function RefugesPage() {
  const router = useRouter();
  const { ready, sens } = useSensitivity();
  const [typed, setTyped] = useState<LatLng | null>(null);
  const [target, setTarget] = useState<SheetTarget | null>(null);
  const position = useAsync(getPosition);

  // Next keeps visited pages alive, so close the sheet when this page hides.
  useLayoutEffect(() => () => setTarget(null), []);

  const origin = typed ?? position.data;
  const denied = Boolean(position.error);

  return (
    <main className="page">
      <TopBar title="가까운 쉼터">
        <Mascot pose="sit" height={44} />
      </TopBar>

      {!origin && denied && (
        <>
          <div className="section-title">
            <Mascot pose="search" height={64} />
            <p>위치를 확인할 수 없어요. 역이나 장소 이름으로 찾아 주세요.</p>
          </div>
          <PlaceField label="지금 어디에 있나요?" onPick={setTyped} />
        </>
      )}
      {!origin && !denied && <SkeletonRows count={TOP_N} label="현재 위치 확인 중" />}
      {origin && ready && <ShelterList origin={origin} sens={sens} onPick={setTarget} />}

      {target && (
        <PlaceSheet
          target={target}
          onClose={() => setTarget(null)}
          onGo={(to) => {
            const query = new URLSearchParams({
              toName: to.name,
              toLat: String(to.lat),
              toLng: String(to.lng),
            });
            router.push(`/?${query}`);
          }}
        />
      )}
    </main>
  );
}
