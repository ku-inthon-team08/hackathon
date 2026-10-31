import { useCallback, useEffect, useState } from "react";

interface Settled<T> {
  load: () => Promise<T>;
  tick: number;
  data?: T;
  error?: unknown;
}

// Pass a stable `load` (useCallback). A new `load` starts over; `refresh` keeps the
// current data on screen while it updates.
export function useAsync<T>(load: () => Promise<T>) {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>();

  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setSettled({ load, tick, data }),
      (error) => live && setSettled({ load, tick, error }),
    );
    return () => {
      live = false;
    };
  }, [load, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const sameLoad = settled?.load === load;
  const current = sameLoad && settled?.tick === tick;
  return {
    loading: !current,
    data: sameLoad ? settled?.data : undefined,
    error: current ? settled?.error : undefined,
    refresh,
  };
}
