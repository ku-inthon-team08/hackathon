import { SENSITIVITY_MAX } from "@/lib/storage";

const LEVELS = Array.from({ length: SENSITIVITY_MAX }, (_, i) => i + 1);

// Filled dots up to the answer, like a rating. Each dot is a radio, so arrow keys work.
// value is undefined until the user picks one, so every dot starts empty.
export function SensitivityField({
  name,
  legend,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  value?: number;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="dots-field">
      <legend>{legend}</legend>
      <div className="dots">
        {LEVELS.map((level) => (
          <label key={level} className={value !== undefined && level <= value ? "dot on" : "dot"}>
            <input
              type="radio"
              name={name}
              checked={value === level}
              onChange={() => onChange(level)}
            />
            <span className="visually-hidden">
              {level} / {SENSITIVITY_MAX}
            </span>
          </label>
        ))}
      </div>
      <span className="dots-value" aria-hidden>
        {value ?? "-"} / {SENSITIVITY_MAX}
      </span>
    </fieldset>
  );
}
