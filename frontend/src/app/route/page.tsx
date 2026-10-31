import { Suspense } from "react";
import { RoutePlanner } from "./RoutePlanner";

export default function RoutePage() {
  return (
    <Suspense fallback={<main className="page" aria-busy />}>
      <RoutePlanner />
    </Suspense>
  );
}
