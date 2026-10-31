"use client";

import { useCallback, useDeferredValue, useId, useState } from "react";
import { searchPlaces } from "@/lib/api";
import type { NamedPlace } from "@/lib/api/types";
import { useAsync } from "@/hooks/useAsync";

export function PlaceField({
  label,
  hint,
  error,
  onPick,
}: {
  label: string;
  hint?: string;
  error?: string;
  onPick: (place: NamedPlace) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const load = useCallback(() => searchPlaces(deferred), [deferred]);
  const { data } = useAsync(load);
  const searched = deferred.trim().length > 0;

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <p className="hint">{hint}</p>}
      <input
        id={id}
        type="search"
        value={query}
        placeholder="예: 안암역"
        autoComplete="off"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && (
        <p id={`${id}-error`} className="error" role="alert">
          {error}
        </p>
      )}
      {searched && data && data.length === 0 && (
        <p className="hint" role="status">
          &lsquo;{deferred}&rsquo; 검색 결과가 없어요. 역이나 장소 이름으로 찾아 보세요.
        </p>
      )}
      {searched && data && data.length > 0 && (
        <ul className="results">
          {data.map((place) => (
            <li key={place.name}>
              <button type="button" onClick={() => onPick(place)}>
                {place.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
