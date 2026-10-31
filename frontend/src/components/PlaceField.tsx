"use client";

import {
  useCallback,
  useDeferredValue,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { searchPlaces } from "@/lib/api";
import type { NamedPlace } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

// A combobox: ↑/↓ move through the results, Enter picks the highlighted one (or the first),
// Esc closes the list and then restores `value`. Leaving without a pick restores it too.
// `value` is the committed text; give the field a `key` that changes with it.
export function PlaceField({
  label,
  hint,
  error,
  value = "",
  placeholder = "예: 안암역",
  inline,
  trailing,
  ref,
  onPick,
}: {
  label: string;
  hint?: string;
  error?: string;
  value?: string;
  placeholder?: string;
  // Label to the left of the box instead of above it.
  inline?: boolean;
  // A button inside the right end of the box.
  trailing?: ReactNode;
  ref?: Ref<HTMLInputElement>;
  onPick: (place: NamedPlace) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState(value);
  const [active, setActive] = useState(-1);
  const [closed, setClosed] = useState(false);
  const focusedByPointer = useRef(false);
  const dirty = query !== value;
  const deferred = useDeferredValue(query);
  const term = dirty ? deferred.trim() : "";
  const load = useCallback(() => (term ? searchPlaces(term) : Promise.resolve([])), [term]);
  const { data } = useAsync(load);
  // Results still belong to an older query while typing, so Enter waits for these.
  const fresh = query === deferred && data !== undefined;
  const results = term && data ? data : [];
  const open = !closed && results.length > 0;
  const activeId = open && active >= 0 ? `${id}-option-${active}` : undefined;

  function change(next: string) {
    setQuery(next);
    setActive(-1);
    setClosed(false);
  }

  function pick(place: NamedPlace) {
    setQuery(place.name);
    setClosed(true);
    onPick(place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (results.length === 0) return;
        event.preventDefault();
        setClosed(false);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const start = open ? active : -1;
        // From nothing, ↓ lands on the first row and ↑ on the last; both wrap around.
        setActive(
          start < 0 && step < 0 ? results.length - 1 : (start + step + results.length) % results.length,
        );
        return;
      }
      case "Enter":
        // An untouched field lets Enter submit the form.
        if (!dirty) return;
        event.preventDefault();
        if (fresh && results.length > 0) pick(results[Math.max(active, 0)]);
        return;
      case "Escape":
        if (open) {
          event.preventDefault();
          setClosed(true);
        } else if (dirty) {
          event.preventDefault();
          change(value);
        }
        return;
    }
  }

  return (
    <div className={inline ? "field inline" : "field"}>
      <label htmlFor={id}>{label}</label>
      {hint && <p className="hint">{hint}</p>}
      <div className="input-wrap">
        <input
          ref={ref}
          id={id}
          type="search"
          role="combobox"
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          // Select everything on entry, so typing replaces the current place.
          onPointerDown={(event) => {
            focusedByPointer.current = document.activeElement !== event.currentTarget;
          }}
          onFocus={(event) => event.currentTarget.select()}
          onMouseUp={(event) => {
            if (focusedByPointer.current) event.preventDefault();
            focusedByPointer.current = false;
          }}
          onBlur={() => {
            setQuery(value);
            setActive(-1);
            setClosed(false);
          }}
        />
        {trailing}
        {open && (
          <ul id={`${id}-list`} className="results" role="listbox" aria-label={`${label} 추천`}>
            {results.map((place, i) => (
              <li
                key={place.name}
                id={`${id}-option-${i}`}
                role="option"
                aria-selected={i === active}
                // Keep focus in the input so the keyboard keeps working after a click.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(place)}
              >
                {place.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="error" role="alert">
          {error}
        </p>
      )}
      {term && data && data.length === 0 && (
        <p className="hint" role="status">
          &lsquo;{term}&rsquo; 검색 결과가 없어요. 역이나 장소 이름으로 찾아 보세요.
        </p>
      )}
    </div>
  );
}
