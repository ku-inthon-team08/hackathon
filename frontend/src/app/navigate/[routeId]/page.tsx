import { Suspense } from "react";
import { NavigateView } from "./NavigateView";

export function generateStaticParams() {
  return [{ routeId: "shortest" }, { routeId: "balanced" }, { routeId: "quietest" }];
}

export default function NavigatePage() {
  return (
    <Suspense fallback={<main className="page" aria-busy />}>
      <NavigateView />
    </Suspense>
  );
}
