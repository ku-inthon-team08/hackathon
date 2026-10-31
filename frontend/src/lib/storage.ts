import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Sensitivity } from "./api/types";

// The key changed when the scale moved from 0-3 to the BE's 1-5, so old answers are dropped.
const SENSITIVITY_KEY = "sensitivity-1to5";
const RATED_KEY = "rated";

export const SENSITIVITY_MAX = 5;
export const DEFAULT_SENSITIVITY: Sensitivity = {
  sens_sound: 3,
  sens_light: 3,
  sens_crowd: 3,
};

function read(storage: () => Storage, key: string) {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value);
  } catch {
    // Storage can be blocked. The in-memory copy below keeps the session working.
  }
}

const local = () => window.localStorage;

let memorySensitivity: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const sensitivitySnapshot = () => memorySensitivity ?? read(local, SENSITIVITY_KEY);

// undefined means we are still on the server and localStorage is unknown.
export function useSensitivity() {
  const raw = useSyncExternalStore<string | null | undefined>(
    subscribe,
    sensitivitySnapshot,
    () => undefined,
  );
  const sens = useMemo<Sensitivity>(
    () => (raw ? JSON.parse(raw) : DEFAULT_SENSITIVITY),
    [raw],
  );
  const save = useCallback((next: Sensitivity) => {
    memorySensitivity = JSON.stringify(next);
    write(local, SENSITIVITY_KEY, memorySensitivity);
    listeners.forEach((listener) => listener());
  }, []);
  return { ready: raw !== undefined, saved: Boolean(raw), sens, save };
}

// No feedback RPC exists yet, so ratings stay on this device.
export function hasRated(key: string) {
  const rated: string[] = JSON.parse(read(local, RATED_KEY) ?? "[]");
  return rated.includes(key);
}

export function saveRating(key: string) {
  const rated: string[] = JSON.parse(read(local, RATED_KEY) ?? "[]");
  write(local, RATED_KEY, JSON.stringify([...rated, key]));
}
