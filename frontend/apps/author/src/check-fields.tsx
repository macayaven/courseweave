import type { AuthorCheck } from "@courseweave/ui";
import { TextField, ArrayFields, SelectField } from "./field-inputs";
import { pointerToControlId } from "./validation";
import { uniqueSlug } from "./draft";
const nextId = (stem: string, items: { id: string }[]) =>
  uniqueSlug(stem, new Set(items.map((item) => item.id)));
export function CheckFields({
  checks,
  objectiveIds,
  pointer,
  change,
}: {
  checks: AuthorCheck[];
  objectiveIds: string[];
  pointer: string;
  change(checks: AuthorCheck[]): void;
}) {
  const p = (field: string) => `${pointer}/${field}`;
  const update = (patch: { checks: AuthorCheck[] }) => change(patch.checks);
  const checkChange = (index: number, value: AuthorCheck) =>
    change(checks.map((check, i) => (i === index ? value : check)));
  return (
    <fieldset id={pointerToControlId(pointer)} tabIndex={-1}>
      <legend>Self-checks</legend>
      <p>
        Checks provide feedback. They never grant completion or certification.
      </p>
      {checks.map((check, index) => (
        <fieldset
          key={index}
          id={pointerToControlId(p(`${index}`))}
          tabIndex={-1}
        >
          <legend>Check {index + 1}</legend>
          <TextField
            label={`Check ${index + 1} ID`}
            pointer={p(`${index}/id`)}
            value={check.id}
            onChange={(id) => checkChange(index, { ...check, id })}
          />
          <TextField
            label={`Check ${index + 1} prompt`}
            pointer={p(`${index}/prompt`)}
            value={check.prompt}
            multiline
            onChange={(prompt) => checkChange(index, { ...check, prompt })}
          />
          <ArrayFields
            label={`Check ${index + 1} objectives`}
            itemLabel={`Check ${index + 1} objective ID`}
            pointer={p(`${index}/objective_ids`)}
            validValues={objectiveIds}
            values={check.objective_ids ?? []}
            onChange={(objective_ids) =>
              checkChange(index, { ...check, objective_ids })
            }
          />
          <fieldset
            id={pointerToControlId(p(`${index}/options`))}
            tabIndex={-1}
          >
            <legend>Answer options</legend>
            {check.options.map((option, oi) => (
              <fieldset key={oi}>
                <legend>Option {oi + 1}</legend>
                {(["id", "text", "feedback"] as const).map((field) => (
                  <TextField
                    key={field}
                    label={`Check ${index + 1} option ${oi + 1} ${field}`}
                    pointer={p(`${index}/options/${oi}/${field}`)}
                    value={option[field]}
                    multiline={field !== "id"}
                    onChange={(value) =>
                      checkChange(index, {
                        ...check,
                        options: check.options.map((o, i) =>
                          i === oi ? { ...o, [field]: value } : o,
                        ),
                        correct_option_id:
                          field === "id" &&
                          check.correct_option_id === option.id
                            ? value
                            : check.correct_option_id,
                      })
                    }
                  />
                ))}
                <button
                  type="button"
                  disabled={check.options.length <= 2}
                  onClick={() => {
                    const options = check.options.filter((_, i) => i !== oi);
                    checkChange(index, {
                      ...check,
                      options,
                      correct_option_id: check.correct_option_id,
                    });
                  }}
                >
                  Remove check {index + 1} option {oi + 1}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={check.options.length >= 8}
              onClick={() =>
                checkChange(index, {
                  ...check,
                  options: [
                    ...check.options,
                    {
                      id: nextId("option", check.options),
                      text: "Answer",
                      feedback: "Consider the explanation.",
                    },
                  ],
                })
              }
            >
              Add check {index + 1} option
            </button>
          </fieldset>
          {!check.options.some(
            (option) => option.id === check.correct_option_id,
          ) ? (
            <p
              id={pointerToControlId(
                p(`${index}/correct_option_id`),
                "missing",
              )}
            >
              Choose an existing correct option before saving.
            </p>
          ) : null}
          <SelectField
            invalid={
              !check.options.some(
                (option) => option.id === check.correct_option_id,
              )
            }
            describedBy={
              !check.options.some(
                (option) => option.id === check.correct_option_id,
              )
                ? pointerToControlId(p(`${index}/correct_option_id`), "missing")
                : undefined
            }
            label={`Check ${index + 1} correct option`}
            pointer={p(`${index}/correct_option_id`)}
            value={check.correct_option_id}
            options={[
              ...new Set([
                ...check.options.map((o) => o.id),
                check.correct_option_id,
              ]),
            ]}
            onChange={(correct_option_id) =>
              checkChange(index, { ...check, correct_option_id })
            }
          />
          <button
            type="button"
            onClick={() =>
              update({ checks: checks.filter((_, i) => i !== index) })
            }
          >
            Remove check {index + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() =>
          update({
            checks: [
              ...checks,
              {
                id: nextId("check", checks),
                type: "single_choice",
                prompt: "Choose the best answer.",
                objective_ids: [],
                options: [
                  {
                    id: "a",
                    text: "First answer",
                    feedback: "Review the concept.",
                  },
                  {
                    id: "b",
                    text: "Second answer",
                    feedback: "Review the concept.",
                  },
                ],
                correct_option_id: "a",
              },
            ],
          })
        }
      >
        Add check
      </button>
    </fieldset>
  );
}
