import type { AuthorLearning, AuthorObjective } from "@courseweave/ui";
import { TextField, ArrayFields } from "./field-inputs";
import { CheckFields } from "./check-fields";
import { uniqueSlug } from "./draft";
import { pointerToControlId } from "./validation";
const nextId = (stem: string, items: { id: string }[]) =>
  uniqueSlug(stem, new Set(items.map((item) => item.id)));
export function LearningFields({
  learning,
  pointer,
  change,
}: {
  learning: AuthorLearning | null | undefined;
  pointer: string;
  change(learning: AuthorLearning | undefined): void;
}) {
  const p = (field: string) => `${pointer}/${field}`;
  if (learning == null)
    return (
      <fieldset>
        <legend>Learning metadata</legend>
        <button
          type="button"
          id={pointerToControlId(pointer)}
          onClick={() =>
            change({ objectives: [], hints: [], sources: [], checks: [] })
          }
        >
          Add learning metadata
        </button>
      </fieldset>
    );
  const objectives = learning.objectives ?? [],
    hints = learning.hints ?? [],
    sources = learning.sources ?? [],
    checks = learning.checks ?? [];
  const update = (patch: Partial<AuthorLearning>) =>
    change({ ...learning, ...patch });
  const objectiveChange = (index: number, value: AuthorObjective | null) => {
    const old = objectives[index]!.id;
    const repair = (ids: string[] | undefined) =>
      ids?.flatMap((id) => (id !== old ? [id] : value ? [value.id] : []));
    update({
      objectives: objectives.flatMap((item, i) =>
        i !== index ? [item] : value ? [value] : [],
      ),
      hints: hints.map((h) => ({
        ...h,
        ...(h.objective_ids === undefined
          ? {}
          : { objective_ids: repair(h.objective_ids) }),
      })),
      checks: checks.map((c) => ({
        ...c,
        ...(c.objective_ids === undefined
          ? {}
          : { objective_ids: repair(c.objective_ids) }),
      })),
    });
  };
  return (
    <fieldset id={pointerToControlId(pointer)} tabIndex={-1}>
      <legend>Learning metadata</legend>
      <TextField
        label="Learning overview"
        pointer={p("overview")}
        value={learning.overview}
        multiline
        onChange={(overview) => update({ overview: overview || undefined })}
      />
      {learning.duration ? (
        <fieldset id={pointerToControlId(p("duration"))} tabIndex={-1}>
          <legend>Duration</legend>
          <p>Minimum minutes must not exceed maximum minutes.</p>
          <TextField
            label="Minimum minutes"
            pointer={p("duration/min_minutes")}
            value={learning.duration.min_minutes}
            type="number"
            onChange={(value) =>
              update({
                duration: { ...learning.duration!, min_minutes: Number(value) },
              })
            }
          />
          <TextField
            label="Maximum minutes"
            pointer={p("duration/max_minutes")}
            value={learning.duration.max_minutes}
            type="number"
            onChange={(value) =>
              update({
                duration: { ...learning.duration!, max_minutes: Number(value) },
              })
            }
          />
          <button type="button" onClick={() => update({ duration: undefined })}>
            Remove duration
          </button>
        </fieldset>
      ) : (
        <button
          type="button"
          id={pointerToControlId(p("duration"))}
          onClick={() =>
            update({ duration: { min_minutes: 5, max_minutes: 10 } })
          }
        >
          Add duration
        </button>
      )}
      <fieldset id={pointerToControlId(p("objectives"))} tabIndex={-1}>
        <legend>Objectives</legend>
        {objectives.map((objective, index) => (
          <fieldset key={index}>
            <legend>Objective {index + 1}</legend>
            <TextField
              label={`Objective ${index + 1} ID`}
              pointer={p(`objectives/${index}/id`)}
              value={objective.id}
              onChange={(id) => objectiveChange(index, { ...objective, id })}
            />
            <TextField
              label={`Objective ${index + 1} text`}
              pointer={p(`objectives/${index}/text`)}
              value={objective.text}
              multiline
              onChange={(text) =>
                objectiveChange(index, { ...objective, text })
              }
            />
            <button type="button" onClick={() => objectiveChange(index, null)}>
              Remove objective {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            update({
              objectives: [
                ...objectives,
                {
                  id: nextId("objective", objectives),
                  text: "Explain the concept.",
                },
              ],
            })
          }
        >
          Add objective
        </button>
      </fieldset>
      <fieldset id={pointerToControlId(p("hints"))} tabIndex={-1}>
        <legend>Ordered hints</legend>
        {hints.map((hint, index) => {
          const edit = (patch: Partial<typeof hint>) =>
            update({
              hints: hints.map((h, i) =>
                i === index ? { ...h, ...patch } : h,
              ),
            });
          return (
            <fieldset key={index}>
              <legend>Hint {index + 1}</legend>
              <TextField
                label={`Hint ${index + 1} ID`}
                pointer={p(`hints/${index}/id`)}
                value={hint.id}
                onChange={(id) => edit({ id })}
              />
              <TextField
                label={`Hint ${index + 1} text`}
                pointer={p(`hints/${index}/text`)}
                value={hint.text}
                multiline
                onChange={(text) => edit({ text })}
              />
              <ArrayFields
                label={`Hint ${index + 1} objectives`}
                itemLabel={`Hint ${index + 1} objective ID`}
                pointer={p(`hints/${index}/objective_ids`)}
                validValues={objectives.map((o) => o.id)}
                values={hint.objective_ids ?? []}
                onChange={(objective_ids) => edit({ objective_ids })}
              />
              <button
                type="button"
                disabled={index === 0}
                onClick={() => {
                  const moved = [...hints];
                  [moved[index - 1], moved[index]] = [
                    moved[index]!,
                    moved[index - 1]!,
                  ];
                  update({ hints: moved });
                }}
              >
                Move hint {index + 1} up
              </button>
              <button
                type="button"
                disabled={index === hints.length - 1}
                onClick={() => {
                  const moved = [...hints];
                  [moved[index], moved[index + 1]] = [
                    moved[index + 1]!,
                    moved[index]!,
                  ];
                  update({ hints: moved });
                }}
              >
                Move hint {index + 1} down
              </button>
              <button
                type="button"
                onClick={() =>
                  update({ hints: hints.filter((_, i) => i !== index) })
                }
              >
                Remove hint {index + 1}
              </button>
            </fieldset>
          );
        })}
        <button
          type="button"
          onClick={() =>
            update({
              hints: [
                ...hints,
                {
                  id: nextId("hint", hints),
                  text: "Consider the first step.",
                  objective_ids: [],
                },
              ],
            })
          }
        >
          Add hint
        </button>
      </fieldset>
      <fieldset id={pointerToControlId(p("sources"))} tabIndex={-1}>
        <legend>Source references</legend>
        {sources.map((source, index) => (
          <fieldset key={index}>
            <legend>Source {index + 1}</legend>
            {(["id", "label", "url", "reviewed_date"] as const).map((field) => (
              <TextField
                key={field}
                label={`Source ${index + 1} ${field === "reviewed_date" ? "reviewed date" : field}`}
                pointer={p(`sources/${index}/${field}`)}
                value={source[field]}
                type={field === "reviewed_date" ? "date" : "text"}
                onChange={(value) =>
                  update({
                    sources: sources.map((s, i) =>
                      i === index
                        ? {
                            ...s,
                            [field]:
                              field === "reviewed_date"
                                ? value || undefined
                                : value,
                          }
                        : s,
                    ),
                  })
                }
              />
            ))}
            <button
              type="button"
              onClick={() =>
                update({ sources: sources.filter((_, i) => i !== index) })
              }
            >
              Remove source {index + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            update({
              sources: [
                ...sources,
                {
                  id: nextId("source", sources),
                  label: "Reference",
                  url: "https://example.test/",
                },
              ],
            })
          }
        >
          Add source
        </button>
      </fieldset>
      <CheckFields
        checks={checks}
        objectiveIds={objectives.map((objective) => objective.id)}
        pointer={p("checks")}
        change={(checks) => update({ checks })}
      />
      <button type="button" onClick={() => change(undefined)}>
        Remove learning metadata
      </button>
    </fieldset>
  );
}
