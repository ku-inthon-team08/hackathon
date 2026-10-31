"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SensitivityField } from "@/components/SensitivityField";
import { Mascot } from "@/components/ui";
import { getPosition } from "@/lib/location";
import { DEFAULT_SENSITIVITY, useSensitivity } from "@/lib/storage";
import type { Sensitivity } from "@/lib/api/types";

const QUESTIONS = [
  { key: "sens_sound", title: "큰 소리가 얼마나 힘든가요?", legend: "큰 소리", pose: "stand" },
  { key: "sens_light", title: "밝은 빛이 얼마나 힘든가요?", legend: "밝은 빛", pose: "hold-lightbulb" },
  { key: "sens_crowd", title: "많은 사람이 얼마나 힘든가요?", legend: "많은 사람", pose: "peek" },
] as const;

export default function WelcomePage() {
  const router = useRouter();
  const { save } = useSensitivity();
  // 0 is the intro, 1-3 the questions, 4 the finish screen.
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Sensitivity>(DEFAULT_SENSITIVITY);
  const question = QUESTIONS[step - 1];

  function finish(askLocation: boolean) {
    save(answers);
    if (askLocation) getPosition().catch(() => {});
    router.replace("/");
  }

  if (step === 0) {
    return (
      <main className="page welcome">
        <div className="welcome-body">
          <Mascot pose="wave" height={200} />
          <h1>조용한 길을 함께 찾아요</h1>
          <p>소리, 빛, 사람이 얼마나 힘든지 알려주시면 나에게 맞는 지도를 보여드려요.</p>
        </div>
        <button type="button" className="button primary" onClick={() => setStep(1)}>
          시작하기
        </button>
      </main>
    );
  }

  if (!question) {
    return (
      <main className="page welcome">
        <div className="welcome-body">
          <Mascot pose="sit-wave" height={200} />
          <h1>준비됐어요</h1>
          <p>
            내 주변 쉼터를 바로 찾으려면 위치 정보가 필요해요. 언제든 장소 이름으로 검색할 수도
            있어요.
          </p>
        </div>
        <div className="stack">
          <button type="button" className="button primary" onClick={() => finish(true)}>
            위치 사용하고 시작하기
          </button>
          <button type="button" className="button" onClick={() => finish(false)}>
            위치 없이 시작하기
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page welcome">
      <p className="progress">{step} / 3</p>
      <div className="question">
        <Mascot pose={question.pose} height={120} />
        <h1>{question.title}</h1>
      </div>
      <SensitivityField
        name={question.key}
        legend={question.legend}
        value={answers[question.key]}
        onChange={(value) => setAnswers({ ...answers, [question.key]: value })}
      />
      <div className="welcome-actions">
        <button type="button" className="button" onClick={() => setStep(step - 1)}>
          이전
        </button>
        <button type="button" className="button primary" onClick={() => setStep(step + 1)}>
          다음
        </button>
      </div>
    </main>
  );
}
