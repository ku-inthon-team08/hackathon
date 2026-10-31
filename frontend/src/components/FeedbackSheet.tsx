"use client";

import { Mic } from "lucide-react";
import { useState } from "react";
import { hasRated, saveRating } from "@/lib/storage";
import type { NamedPlace } from "@/lib/api/types";
import { Sheet } from "./Sheet";
import { Mascot, Notice } from "./ui";

const RATINGS = ["조용했어요", "보통이었어요", "시끄러웠어요"];

export function FeedbackSheet({
  destination,
  onClose,
  onDone,
}: {
  destination: NamedPlace;
  onClose: () => void;
  // Ends the trip once the rating is in.
  onDone: () => void;
}) {
  const key = `${destination.lat},${destination.lng}`;
  const [status, setStatus] = useState<"asking" | "done" | "already">(() =>
    hasRated(key) ? "already" : "asking",
  );
  const home = (
    <button type="button" className="button primary" onClick={onDone}>
      지도로 돌아가기
    </button>
  );

  return (
    <Sheet title={`${destination.name} 도착`} onClose={onClose}>
      {status === "asking" && (
        <>
          <div className="section-title">
            <Mascot pose="stand" height={72} />
            <h3>지금 이곳은 어땠나요?</h3>
          </div>
          <div className="stack">
            {RATINGS.map((rating) => (
              <button
                key={rating}
                type="button"
                className="button"
                onClick={() => {
                  saveRating(key);
                  setStatus("done");
                }}
              >
                {rating}
              </button>
            ))}
          </div>
          <button type="button" className="button" aria-disabled aria-describedby="mic-note">
            <Mic aria-hidden />
            소리 측정하기 (선택)
          </button>
          <p id="mic-note" className="hint">
            소리 측정은 아직 준비 중이에요.
          </p>
        </>
      )}
      {status === "done" && (
        <Notice pose="wink" title="고마워요!" action={home}>
          남겨 주신 평가는 지금은 이 기기에만 저장돼요.
        </Notice>
      )}
      {status === "already" && (
        <Notice pose="thumbs-up" title="이미 평가했어요" action={home}>
          이곳에 남겨 주신 평가가 있어요.
        </Notice>
      )}
    </Sheet>
  );
}
