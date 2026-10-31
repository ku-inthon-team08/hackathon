"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import { FeedbackSheet } from "@/components/FeedbackSheet";
import { RouteMap } from "@/components/MapCanvas";
import { LoadTag, Mascot, Notice, TopBar } from "@/components/ui";
import { distance } from "@/lib/format";
import { useTrip } from "@/lib/storage";

export function NavigateView() {
  const { routeId } = useParams<{ routeId: string }>();
  const { ready, trip } = useTrip();
  const [arrived, setArrived] = useState(false);

  // Next keeps visited pages alive, so the next trip must not reopen this sheet.
  useLayoutEffect(() => () => setArrived(false), []);

  if (!ready) return <main className="page" aria-busy />;

  if (trip?.route.kind !== routeId) {
    return (
      <main className="page">
        <TopBar title="길 안내" />
        <Notice
          pose="lie-down-side"
          title="경로 정보가 없어요"
          action={
            <Link className="button primary" href="/route">
              경로 다시 찾기
            </Link>
          }
        >
          새 탭에서 열면 경로가 이어지지 않아요.
        </Notice>
      </main>
    );
  }

  const { route, destination } = trip;
  return (
    <main className="navigate">
      <TopBar title={`${destination.name}까지`}>
        <Mascot pose="hold-phone" height={44} />
      </TopBar>
      <p className="navigate-meta">
        {route.label} · 도보 {route.walk_min}분 · {distance(route.distance_m)} <LoadTag level={route.load_level} />
      </p>
      <RouteMap line={route.geometry} label={`${destination.name}까지 ${route.label} 경로`} />
      <div className="bottom-action">
        <button type="button" className="button primary" onClick={() => setArrived(true)}>
          도착했어요
        </button>
      </div>
      {arrived && <FeedbackSheet destination={destination} onClose={() => setArrived(false)} />}
    </main>
  );
}
