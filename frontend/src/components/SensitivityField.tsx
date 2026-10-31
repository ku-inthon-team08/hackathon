import { Check } from "lucide-react";

const OPTIONS = [
  { value: 0, label: "상관없어요" },
  { value: 1, label: "조금 신경 쓰여요" },
  { value: 2, label: "꽤 힘들어요" },
  { value: 3, label: "많이 힘들어요" },
];

export function SensitivityField({
  name,
  legend,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset className="choices">
      <legend>{legend}</legend>
      {OPTIONS.map((option) => (
        <label key={option.value} className="choice">
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
          {value === option.value && <Check aria-hidden />}
        </label>
      ))}
    </fieldset>
  );
}
