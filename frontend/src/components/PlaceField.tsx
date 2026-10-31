"use client";

import { LocateFixed, MapPin } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { searchPlaces } from "@/lib/api";
import type { NamedPlace } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

type Option = { kind: "leading"; label: string } | { kind: "place"; place: NamedPlace };

// A combobox: ↑/↓ move through the options, Enter picks the highlighted one (or the first),
// Esc closes the list and then restores `value`. Leaving without a pick restores it too.
// `value` is the committed text; give the field a `key` that changes with it.
export function PlaceField({
  label,
  hint,
  value = "",
  accent,
  placeholder = "장소 입력",
  hideLabel,
  clearOnFocus,
  leading,
  invalid,
  describedBy,
  ref,
  onPick,
}: {
  label: string;
  hint?: string;
  value?: string;
  // Show the committed value in the accent colour, e.g. "현재 위치".
  accent?: boolean;
  placeholder?: string;
  hideLabel?: boolean;
  // Empty the box on entry instead of selecting its text, so `leading` shows at once.
  clearOnFocus?: boolean;
  // An option offered above the results while the box is empty, e.g. 현재 위치.
  leading?: { label: string; onPick: () => void };
  invalid?: boolean;
  describedBy?: string;
  ref?: Ref<HTMLInputElement>;
  onPick: (place: NamedPlace) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState(value);
  const [focused, setFocused] = useState(false);
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
  const showLeading = Boolean(leading) && focused && !query.trim();
  const options: Option[] = showLeading
    ? [{ kind: "leading", label: leading!.label }]
    : results.map((place) => ({ kind: "place", place }));
  const open = focused && !closed && options.length > 0;
  const empty = focused && !closed && Boolean(term) && data?.length === 0;
  const activeId = open && active >= 0 ? `${id}-option-${active}` : undefined;

  function change(next: string) {
    setQuery(next);
    setActive(-1);
    setClosed(false);
  }

  function pick(option: Option) {
    setClosed(true);
    if (option.kind === "leading") {
      leading?.onPick();
      return;
    }
    setQuery(option.place.name);
    onPick(option.place);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (options.length === 0) return;
        event.preventDefault();
        setClosed(false);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const start = open ? active : -1;
        // From nothing, ↓ lands on the first row and ↑ on the last; both wrap around.
        setActive(
          start < 0 && step < 0 ? options.length - 1 : (start + step + options.length) % options.length,
        );
        return;
      }
      case "Enter":
        if (showLeading) {
          event.preventDefault();
          pick(options[Math.max(active, 0)]);
          return;
        }
        // An untouched field lets Enter submit the form.
        if (!dirty) return;
        event.preventDefault();
        if (fresh && options.length > 0) pick(options[Math.max(active, 0)]);
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
    <div className={hideLabel ? "field bare" : "field"}>
      <label htmlFor={id} className={hideLabel ? "visually-hidden" : undefined}>
        {label}
      </label>
      {hint && <p className="hint">{hint}</p>}
      <div className="input-wrap">
        <input
          ref={ref}
          id={id}
          type="search"
          role="combobox"
          className={accent && !dirty ? "accent" : undefined}
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
          // Otherwise select everything on entry, so typing replaces the current place.
          onPointerDown={(event) => {
            focusedByPointer.current = document.activeElement !== event.currentTarget;
          }}
          onFocus={(event) => {
            setFocused(true);
            if (clearOnFocus) change("");
            else event.currentTarget.select();
          }}
          onMouseUp={(event) => {
            if (focusedByPointer.current && !clearOnFocus) event.preventDefault();
            focusedByPointer.current = false;
          }}
          onBlur={() => {
            setFocused(false);
            change(value);
          }}
        />
        {open && (
          <ul id={`${id}-list`} className="results" role="listbox" aria-label={`${label} 추천`}>
            {options.map((option, i) => (
              <li
                key={option.kind === "leading" ? "leading" : `${option.place.name}-${i}`}
                id={`${id}-option-${i}`}
                role="option"
                className={option.kind === "leading" ? "leading" : undefined}
                aria-selected={i === active}
                // Keep focus in the input so the keyboard keeps working after a click.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(option)}
              >
                {option.kind === "leading" ? (
                  <>
                    <LocateFixed aria-hidden />
                    {option.label}
                  </>
                ) : (
                  <>
                    <MapPin aria-hidden />
                    <span className="option-text">
                      {option.place.name}
                      {option.place.address && (
                        <span className="option-sub">{option.place.address}</span>
                      )}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {empty && (
          <p className="results results-empty" role="status">
            &lsquo;{term}&rsquo; 검색 결과가 없어요. 역이나 장소 이름으로 찾아 보세요.
          </p>
        )}
      </div>
    </div>
  );
}
