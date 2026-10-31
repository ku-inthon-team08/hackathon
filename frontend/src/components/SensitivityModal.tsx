"use client";

import { useState } from "react";
import type { Sensitivity } from "@/lib/api/types";
import { SensitivityField } from "./SensitivityField";
import { Sheet } from "./Sheet";

const QUESTIONS = [
  { key: "sens_light", legend: "빛" },
  { key: "sens_sound", legend: "소음" },
  { key: "sens_crowd", legend: "인파" },
] as const;

// onClose gets the answers on 확인, and nothing when the popup is dismissed.
// With no initial answers every row starts empty, and 확인 waits until all are picked.
export function SensitivityModal({
  initial,
  onClose,
}: {
  initial?: Sensitivity;
  onClose: (answers?: Sensitivity) => void;
}) {
  const [answers, setAnswers] = useState<Partial<Sensitivity>>(initial ?? {});
  const complete = QUESTIONS.every((question) => answers[question.key] !== undefined);
  return (
    <Sheet title="민감도 설문" modal onClose={() => onClose()}>
      <p className="hint">1은 괜찮아요, 5는 많이 힘들어요.</p>
      <div className="stack-large">
        {QUESTIONS.map((question, i) => (
          <SensitivityField
            key={question.key}
            name={question.key}
            legend={`${i + 1}. ${question.legend}`}
            value={answers[question.key]}
            onChange={(value) => setAnswers({ ...answers, [question.key]: value })}
          />
        ))}
      </div>
      <div className="modal-actions">
        {!complete && <p className="hint">모든 항목을 골라 주세요.</p>}
        <button
          type="button"
          className="button primary"
          aria-disabled={!complete}
          onClick={() => complete && onClose(answers as Sensitivity)}
        >
          확인
        </button>
      </div>
    </Sheet>
  );
}
