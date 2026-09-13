import type { ChangeEvent } from "react";
import { pointerToControlId } from "./validation";
function text(event: ChangeEvent<HTMLInputElement>) {
  return event.currentTarget.value;
}
export function ArrayFields({
  label,
  itemLabel,
  values,
  onChange,
  pointer,
  validValues,
}: {
  label: string;
  itemLabel: string;
  values: string[];
  onChange(values: string[]): void;
  pointer?: string;
  validValues?: readonly string[];
}) {
  const items = values.length > 0 ? values : [""];
  return (
    <fieldset>
      <legend>{label}</legend>
      {validValues ? (
        <datalist id={`${pointerToControlId(pointer ?? label)}-choices`}>
          {validValues.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      ) : null}
      {items.map((value, index) => (
        <span key={index}>
          <label>
            {itemLabel} {index + 1}
            <input
              id={
                pointer === undefined
                  ? undefined
                  : pointerToControlId(
                      values.length === 0 ? pointer : `${pointer}/${index}`,
                    )
              }
              aria-label={`${itemLabel} ${index + 1}`}
              list={
                validValues
                  ? `${pointerToControlId(pointer ?? label)}-choices`
                  : undefined
              }
              aria-invalid={
                validValues &&
                values.length > 0 &&
                (!validValues.includes(value) ||
                  values.indexOf(value) !== index)
                  ? true
                  : undefined
              }
              aria-describedby={
                validValues &&
                values.length > 0 &&
                (!validValues.includes(value) ||
                  values.indexOf(value) !== index)
                  ? `${pointerToControlId(`${pointer}/${index}`)}-reference`
                  : undefined
              }
              value={value}
              onChange={(event) => {
                const next = values.length === 0 ? [""] : [...values];
                next[index] = text(event);
                onChange(next);
              }}
            />
          </label>
          {validValues &&
          values.length > 0 &&
          (!validValues.includes(value) || values.indexOf(value) !== index) ? (
            <p id={`${pointerToControlId(`${pointer}/${index}`)}-reference`}>
              {!validValues.includes(value)
                ? `Choose an existing ${itemLabel.toLowerCase()}.`
                : `Use each ${itemLabel.toLowerCase()} only once.`}
            </p>
          ) : null}
          {values.length > 0 ? (
            <button
              type="button"
              onClick={() =>
                onChange(values.filter((_, valueIndex) => valueIndex !== index))
              }
            >
              Remove {itemLabel.toLowerCase()} {index + 1}
            </button>
          ) : null}
        </span>
      ))}
      <button type="button" onClick={() => onChange([...values, ""])}>
        Add {itemLabel.toLowerCase()}
      </button>
    </fieldset>
  );
}

export function TextField({
  label,
  value,
  pointer,
  onChange,
  multiline = false,
  type = "text",
}: {
  label: string;
  value: string | number | null | undefined;
  pointer: string;
  onChange(value: string): void;
  multiline?: boolean;
  type?: string;
}) {
  return (
    <label>
      {label}
      {multiline ? (
        <textarea
          id={pointerToControlId(pointer)}
          value={value ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <input
          type={type}
          id={pointerToControlId(pointer)}
          value={value ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </label>
  );
}
export function SelectField<T extends string>({
  label,
  value,
  options,
  pointer,
  onChange,
  invalid,
  describedBy,
}: {
  invalid?: boolean;
  describedBy?: string;
  label: string;
  value: T;
  options: readonly T[];
  pointer: string;
  onChange(value: T): void;
}) {
  return (
    <label>
      {label}
      <select
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        id={pointerToControlId(pointer)}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
export function Choices<T extends string>({
  label,
  values,
  options,
  pointer,
  onChange,
}: {
  label: string;
  values: T[];
  options: readonly T[];
  pointer: string;
  onChange(value: T[]): void;
}) {
  return (
    <fieldset id={pointerToControlId(pointer)} tabIndex={-1}>
      <legend>{label}</legend>
      {options.map((option) => (
        <label key={option}>
          {label} {option}
          {option === "workspace" ? " (inactive in this runtime)" : ""}
          <input
            type="checkbox"
            checked={values.includes(option)}
            onChange={(event) =>
              onChange(
                event.currentTarget.checked
                  ? [...values, option]
                  : values.filter((value) => value !== option),
              )
            }
          />
        </label>
      ))}
    </fieldset>
  );
}
