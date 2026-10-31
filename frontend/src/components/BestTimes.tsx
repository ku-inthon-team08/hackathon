"use client";

import { Check } from "lucide-react";
import { useCallback } from "react";
import { bestTimes } from "@/lib/api";
import { koreaHour, NOISE_LABEL } from "@/lib/format";
import type { LatLng } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";
import { LoadFailed, SkeletonRows } from "./ui";

export function BestTimes({ lat, lng }: LatLng) {
  const load = useCallback(() => bestTimes({ lat, lng }), [lat, lng]);
  const { data, error, loading, refresh } = useAsync(load);

  if (error) return <LoadFailed what="예상 혼잡도를" onRetry={refresh} />;
  if (loading || !data) return <SkeletonRows count={3} label="예상 혼잡도 불러오는 중" />;
  if (data.slots.length === 0) {
    return <p className="hint">지금은 이 정보를 볼 수 없어요.</p>;
  }

  return (
    <>
      <p className="hint">{data.area.area_nm} 기준 예상이에요.</p>
      <table className="times">
        <thead>
          <tr>
            <th scope="col">시간</th>
            <th scope="col">혼잡</th>
            <th scope="col">소음</th>
          </tr>
        </thead>
        <tbody>
          {data.slots.map((slot) => (
            <tr key={slot.at} className={slot.recommended ? "recommended" : undefined}>
              <th scope="row">
                {koreaHour(slot.at)}
                {slot.recommended && (
                  <span className="tag">
                    <Check aria-hidden />
                    추천
                  </span>
                )}
              </th>
              <td>{slot.crowd_label}</td>
              <td>{NOISE_LABEL[slot.noise_grade - 1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
