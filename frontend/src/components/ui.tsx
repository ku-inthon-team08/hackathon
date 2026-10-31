import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { LOAD_LABEL } from "@/lib/format";
import type { LoadLevel } from "@/lib/api/types";

const POSES = {
  "hold-lightbulb": [734, 640],
  "hold-phone": [1140, 1315],
  "hold-tablet": [612, 645],
  "lie-down": [727, 432],
  "lie-down-side": [896, 495],
  peek: [901, 1859],
  "point-present": [752, 698],
  search: [652, 672],
  "settings-gear": [678, 774],
  sit: [850, 806],
  "sit-wave": [920, 929],
  stand: [692, 685],
  "thumbs-up": [580, 794],
  wave: [838, 855],
  wink: [626, 665],
} as const;

export function Mascot({ pose, height }: { pose: keyof typeof POSES; height: number }) {
  const [w, h] = POSES[pose];
  return (
    <Image
      className="mascot"
      src={`/mascot/horangi-3d-${pose}.webp`}
      width={Math.round((w / h) * height)}
      height={height}
      loading="eager"
      alt=""
    />
  );
}

export function TopBar({
  title,
  href,
  onBack,
  children,
}: {
  title: string;
  href?: string;
  onBack?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="top-bar">
      {onBack ? (
        <button type="button" className="icon-button" onClick={onBack} aria-label="뒤로">
          <ArrowLeft aria-hidden />
        </button>
      ) : (
        <Link className="icon-button" href={href ?? "/"} aria-label="뒤로">
          <ArrowLeft aria-hidden />
        </Link>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function LoadTag({ level }: { level: LoadLevel }) {
  return <span className={`tag load-${level}`}>부하 {LOAD_LABEL[level]}</span>;
}

export function Notice({
  pose,
  title,
  children,
  action,
}: {
  pose?: keyof typeof POSES;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="notice" role="status">
      {pose && <Mascot pose={pose} height={96} />}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Notice
      pose="lie-down-side"
      title={`${what} 불러오지 못했어요`}
      action={
        <button type="button" className="button" onClick={onRetry}>
          다시 시도
        </button>
      }
    >
      연결을 확인하고 다시 시도해 주세요.
    </Notice>
  );
}

export function SkeletonRows({ count, label }: { count: number; label: string }) {
  return (
    <div role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}
