"use client";

import { Square, Volume2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { placeDetail, quietRoutes } from "@/lib/api";
import { distance, koreaTime, LOW_CONFIDENCE, NOISE_LABEL } from "@/lib/format";
import { getPosition } from "@/lib/location";
import { saveTrip, useSensitivity } from "@/lib/storage";
import type { NamedPlace } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";
import { usePreview } from "@/hooks/usePreview";
import { BestTimes } from "./BestTimes";
import { Sheet } from "./Sheet";
import { LoadFailed, Mascot, SkeletonRows } from "./ui";

export type SheetTarget = NamedPlace &
  ({ placeId: string } | { placeId?: undefined; crowd: { label: string; observedAt: string } });

function EstimatedTag({ confidence }: { confidence: number }) {
  return confidence < LOW_CONFIDENCE ? <span className="tag">추정값</span> : null;
}

function Evidence({ placeId, expanded }: { placeId: string; expanded: boolean }) {
  const load = useCallback(() => placeDetail(placeId), [placeId]);
  const { data, error, loading, refresh } = useAsync(load);
  const preview = usePreview();

  if (error) return <LoadFailed what="장소 정보를" onRetry={refresh} />;
  if (loading || !data) return <SkeletonRows count={3} label="장소 정보 불러오는 중" />;

  const { noise, light, crowd } = data.evidence;
  const hours = data.place.open_info;
  return (
    <>
      <dl className="facts">
        <div>
          <dt>소리</dt>
          <dd>
            {NOISE_LABEL[noise.grade - 1]} · {noise.db}dB <EstimatedTag confidence={noise.confidence} />
          </dd>
        </div>
        <div>
          <dt>빛</dt>
          <dd>
            {light.lux} lux <EstimatedTag confidence={light.confidence} />
          </dd>
        </div>
        <div>
          <dt>혼잡</dt>
          <dd>{crowd.label}</dd>
        </div>
        {hours && (
          <div>
            <dt>운영</dt>
            <dd>
              {hours.open}~{hours.close} · {hours.closed}
            </dd>
          </div>
        )}
      </dl>
      <button
        type="button"
        className="button"
        aria-pressed={preview.playing}
        onClick={() => (preview.playing ? preview.stop() : preview.start(noise.grade))}
      >
        {preview.playing ? <Square aria-hidden /> : <Volume2 aria-hidden />}
        {preview.playing ? "미리듣기 멈추기" : "소리 미리듣기"}
      </button>
      {expanded && (
        <p className="hint">
          소리·빛은 {distance(noise.distance_m)} 떨어진 {noise.source} 센서, {koreaTime(noise.observed_at)}{" "}
          측정. 혼잡은 {crowd.area_nm}, {koreaTime(crowd.observed_at)} 기준.
        </p>
      )}
    </>
  );
}

export function PlaceSheet({ target, onClose }: { target: SheetTarget; onClose: () => void }) {
  const router = useRouter();
  const { sens } = useSensitivity();
  const [expanded, setExpanded] = useState(false);
  const [going, setGoing] = useState(false);
  const [failed, setFailed] = useState(false);

  async function goHere() {
    setGoing(true);
    setFailed(false);
    const destination = { name: target.name, lat: target.lat, lng: target.lng };
    const from = await getPosition().catch(() => null);
    if (!from) {
      // Without a start point, let the user type one in route planning.
      const query = new URLSearchParams({
        toName: destination.name,
        toLat: String(destination.lat),
        toLng: String(destination.lng),
      });
      router.push(`/route?${query}`);
      return;
    }
    try {
      const { routes } = await quietRoutes(from, destination, sens);
      const route = routes[routes.length - 1];
      if (!route) throw new Error("no route");
      saveTrip({ route, destination });
      router.push(`/navigate/${route.kind}`);
    } catch {
      setGoing(false);
      setFailed(true);
    }
  }

  return (
    <Sheet title={target.name} full={expanded} onClose={onClose}>
      {target.placeId !== undefined ? (
        <Evidence placeId={target.placeId} expanded={expanded} />
      ) : (
        <dl className="facts">
          <div>
            <dt>혼잡</dt>
            <dd>
              {target.crowd.label} · {koreaTime(target.crowd.observedAt)} 기준
            </dd>
          </div>
        </dl>
      )}

      {expanded ? (
        <section className="stack">
          <div className="section-title">
            <Mascot pose="hold-tablet" height={48} />
            <h3>시간대별 예상</h3>
          </div>
          <BestTimes lat={target.lat} lng={target.lng} />
        </section>
      ) : (
        <button type="button" className="text-button" onClick={() => setExpanded(true)}>
          시간대별 예상 보기
        </button>
      )}

      {failed && (
        <p className="error" role="alert">
          경로를 찾지 못했어요. 다시 시도해 주세요.
        </p>
      )}
      <button
        type="button"
        className="button primary"
        aria-busy={going}
        disabled={going}
        onClick={goHere}
      >
        {going ? "경로 찾는 중…" : "여기로 가기"}
      </button>
    </Sheet>
  );
}
