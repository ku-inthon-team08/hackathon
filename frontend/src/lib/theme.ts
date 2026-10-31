import { useSyncExternalStore } from "react";

// The theme lives on <html data-theme>. layout.tsx sets it before first paint from the
// saved choice, or the system setting, so this only reads and changes it.
export type Theme = "light" | "dark";

export const THEME_KEY = "theme";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): Theme =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => "light" as const);
  return [theme, setTheme] as const;
}

function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked. The choice still holds until the page reloads.
  }
  listeners.forEach((listener) => listener());
}
