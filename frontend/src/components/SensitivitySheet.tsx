"use client";

import { useSensitivity } from "@/lib/storage";
import { SensitivityField } from "./SensitivityField";
import { Sheet } from "./Sheet";
import { Mascot } from "./ui";

export function SensitivitySheet({ onClose }: { onClose: () => void }) {
  const { sens, save } = useSensitivity();
  return (
    <Sheet title="내 감각 설정" full onClose={onClose}>
      <div className="section-title">
        <Mascot pose="settings-gear" height={64} />
        <p>바꾼 내용은 바로 지도와 경로에 반영돼요.</p>
      </div>
      <SensitivityField
        name="edit-sound"
        legend="큰 소리"
        value={sens.sens_sound}
        onChange={(sens_sound) => save({ ...sens, sens_sound })}
      />
      <SensitivityField
        name="edit-light"
        legend="밝은 빛"
        value={sens.sens_light}
        onChange={(sens_light) => save({ ...sens, sens_light })}
      />
      <SensitivityField
        name="edit-crowd"
        legend="많은 사람"
        value={sens.sens_crowd}
        onChange={(sens_crowd) => save({ ...sens, sens_crowd })}
      />
      <button type="button" className="button primary" onClick={onClose}>
        완료
      </button>
    </Sheet>
  );
}
