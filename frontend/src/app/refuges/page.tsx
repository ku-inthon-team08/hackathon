"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { PlaceField } from "@/components/PlaceField";
import { PlaceSheet, type SheetTarget } from "@/components/PlaceSheet";
import { ShelterList, TOP_N } from "@/components/ShelterList";
import { Mascot, SkeletonRows, TopBar } from "@/components/ui";
import { getPosition } from "@/lib/location";
import { useSensitivity } from "@/lib/storage";
import type { LatLng } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

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
