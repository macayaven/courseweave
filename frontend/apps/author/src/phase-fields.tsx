import type {
  AuthorPhase,
  AuthorRequirement,
  AuthorExperience,
  AuthorTeacherStyle,
} from "@courseweave/ui";
import { TextField, SelectField, ArrayFields, Choices } from "./field-inputs";
import { LearningFields } from "./learning-fields";
import { pointerToControlId } from "./validation";
import { uniqueSlug } from "./draft";
import { progressModes, accessModes, hintLevels, shareKinds, proposalTypes,
  experienceTypes, experiences, styleTypes, styles, requirementTypes, recordKinds } from "./schema-options";
export function PhaseFields({
  phase,
  pointer,
  update,
}: {
  phase: AuthorPhase;
  pointer: string;
  update(patch: Partial<Omit<AuthorPhase, "surfaces">>): void;
}) {
  const p = (field: string) => `${pointer}/${field}`;
  const teacher = phase.teacher;
  const requirements = phase.completion?.requirements ?? [];
  const requirementChange = (index: number, value: AuthorRequirement) => {
    const old = requirements[index]!;
    update({
      completion: {
        requirements: requirements.map((r, i) => (i === index ? value : r)),
      },
      teacher: {
        ...teacher,
        access: {
          ...teacher.access,
          requires: teacher.access.requires.flatMap((id) =>
            id !== old.id
              ? [id]
              : value.type === "learner_record"
                ? [value.id]
                : [],
          ),
        },
      },
    });
  };
  return (
    <fieldset id={pointerToControlId(pointer)} tabIndex={-1}>
      <legend>Phase</legend>
      <TextField
        label="Phase ID"
        pointer={p("id")}
        value={phase.id}
        onChange={(id) => update({ id })}
      />
      <TextField
        label="Phase title"
        pointer={p("title")}
        value={phase.title}
        onChange={(title) => update({ title })}
      />
      <SelectField
        label="Progress"
        pointer={p("progress")}
        value={phase.progress}
        options={progressModes}
        onChange={(progress) =>
          update({
            progress,
            completion:
              progress === "excluded"
                ? undefined
                : (phase.completion ?? { requirements: [] }),
            ...(progress === "excluded"
              ? {
                  teacher: {
                    ...teacher,
                    access: { ...teacher.access, requires: [] },
                  },
                }
              : {}),
          })
        }
      />
      <SelectField
        label="Experience type"
        pointer={p("experience/type")}
        value={phase.experience.type}
        options={experienceTypes}
        onChange={(type) =>
          update({
            experience:
              type === "builtin"
                ? { type, id: "generic" }
                : { type, id: "example.org/experience" },
          })
        }
      />
      {phase.experience.type === "builtin" ? (
        <SelectField
          label="Experience"
          pointer={p("experience/id")}
          value={phase.experience.id}
          options={experiences}
          onChange={(id) =>
            update({ experience: { type: "builtin", id } as AuthorExperience })
          }
        />
      ) : (
        <TextField
          label="Custom experience"
          pointer={p("experience/id")}
          value={phase.experience.id}
          onChange={(id) => update({ experience: { type: "custom", id } })}
        />
      )}
      {phase.progress !== "excluded" ? (
        <fieldset
          id={pointerToControlId(p("completion/requirements"))}
          tabIndex={-1}
        >
          <legend>Completion requirements</legend>
          <p>
            All requirements must be satisfied. Self-check answers do not
            complete an activity.
          </p>
          {requirements.map((r, index) => {
            const q = p(`completion/requirements/${index}`),
              label = `Requirement ${index + 1}`;
            return (
              <fieldset key={index} id={pointerToControlId(q)} tabIndex={-1}>
                <legend>{label}</legend>
                <TextField
                  label={`${label} ID`}
                  pointer={`${q}/id`}
                  value={r.id}
                  onChange={(id) => requirementChange(index, { ...r, id })}
                />
                <SelectField
                  label={`${label} type`}
                  pointer={`${q}/type`}
                  value={r.type}
                  options={requirementTypes}
                  onChange={(type) =>
                    requirementChange(
                      index,
                      type === "learner_record"
                        ? {
                            id: r.id,
                            prompt: r.prompt,
                            type,
                            record_kind: "text",
                          }
                        : {
                            id: r.id,
                            prompt: r.prompt,
                            type,
                            path: "artifact.txt",
                          },
                    )
                  }
                />
                <TextField
                  label={`${label} prompt`}
                  pointer={`${q}/prompt`}
                  value={r.prompt}
                  multiline
                  onChange={(prompt) =>
                    requirementChange(index, { ...r, prompt })
                  }
                />
                {r.type === "learner_record" ? (
                  <SelectField
                    label={`${label} record kind`}
                    pointer={`${q}/record_kind`}
                    value={r.record_kind}
                    options={recordKinds}
                    onChange={(record_kind) =>
                      requirementChange(index, { ...r, record_kind })
                    }
                  />
                ) : (
                  <TextField
                    label={`${label} artifact path`}
                    pointer={`${q}/path`}
                    value={r.path}
                    onChange={(path) =>
                      requirementChange(index, { ...r, path })
                    }
                  />
                )}
                <button
                  type="button"
                  onClick={() =>
                    update({
                      completion: {
                        requirements: requirements.filter(
                          (_, i) => i !== index,
                        ),
                      },
                      teacher: {
                        ...teacher,
                        access: {
                          ...teacher.access,
                          requires: teacher.access.requires.filter(
                            (id) => id !== r.id,
                          ),
                        },
                      },
                    })
                  }
                >
                  Remove requirement {index + 1}
                </button>
              </fieldset>
            );
          })}
          <button
            type="button"
            onClick={() =>
              update({
                completion: {
                  requirements: [
                    ...requirements,
                    {
                      id: uniqueSlug(
                        "requirement",
                        new Set(requirements.map((r) => r.id)),
                      ),
                      type: "learner_record",
                      record_kind: "text",
                      prompt: "Describe your response.",
                    },
                  ],
                },
              })
            }
          >
            Add requirement
          </button>
        </fieldset>
      ) : null}
      <fieldset id={pointerToControlId(p("teacher"))} tabIndex={-1}>
        <legend>Course assistant policy</legend>
        <SelectField
          label="Teacher access"
          pointer={p("teacher/access/mode")}
          value={teacher.access.mode}
          options={accessModes}
          onChange={(mode) =>
            update({
              teacher: {
                ...teacher,
                access: {
                  mode,
                  requires: mode === "available" ? teacher.access.requires : [],
                },
                sharing: {
                  allow: mode === "available" ? teacher.sharing.allow : [],
                },
                proposals: {
                  allow: mode === "available" ? teacher.proposals.allow : [],
                },
              },
            })
          }
        />
        <p>
          Disabled and observer-only access clear gates, sharing, and proposal
          permissions.
        </p>
        <fieldset disabled={teacher.access.mode !== "available"}>
          <ArrayFields
            label="Learner record gates"
            itemLabel="Gate requirement ID"
            pointer={p("teacher/access/requires")}
            validValues={requirements
              .filter((r) => r.type === "learner_record")
              .map((r) => r.id)}
            values={teacher.access.requires}
            onChange={(requires) =>
              update({
                teacher: {
                  ...teacher,
                  access: { ...teacher.access, requires },
                },
              })
            }
          />
          <Choices
            label="Share"
            pointer={p("teacher/sharing/allow")}
            values={teacher.sharing.allow}
            options={shareKinds}
            onChange={(allow) =>
              update({ teacher: { ...teacher, sharing: { allow } } })
            }
          />
          <Choices
            label="Propose"
            pointer={p("teacher/proposals/allow")}
            values={teacher.proposals.allow}
            options={proposalTypes}
            onChange={(allow) =>
              update({ teacher: { ...teacher, proposals: { allow } } })
            }
          />
        </fieldset>
        <SelectField
          label="Guidance style type"
          pointer={p("teacher/guidance/style/type")}
          value={teacher.guidance.style.type}
          options={styleTypes}
          onChange={(type) =>
            update({
              teacher: {
                ...teacher,
                guidance: {
                  ...teacher.guidance,
                  style:
                    type === "builtin"
                      ? { type, id: "explanatory" }
                      : { type, id: "example.org/style" },
                },
              },
            })
          }
        />
        {teacher.guidance.style.type === "builtin" ? (
          <SelectField
            label="Guidance style"
            pointer={p("teacher/guidance/style/id")}
            value={teacher.guidance.style.id}
            options={styles}
            onChange={(id) =>
              update({
                teacher: {
                  ...teacher,
                  guidance: {
                    ...teacher.guidance,
                    style: { type: "builtin", id } as AuthorTeacherStyle,
                  },
                },
              })
            }
          />
        ) : (
          <TextField
            label="Custom guidance style"
            pointer={p("teacher/guidance/style/id")}
            value={teacher.guidance.style.id}
            onChange={(id) =>
              update({
                teacher: {
                  ...teacher,
                  guidance: {
                    ...teacher.guidance,
                    style: { type: "custom", id },
                  },
                },
              })
            }
          />
        )}
        <SelectField
          label="Hint level"
          pointer={p("teacher/guidance/hint_level")}
          value={teacher.guidance.hint_level}
          options={hintLevels}
          onChange={(hint_level) =>
            update({
              teacher: {
                ...teacher,
                guidance: { ...teacher.guidance, hint_level },
              },
            })
          }
        />
        <TextField
          label="Teaching guidance"
          pointer={p("teacher/guidance/text")}
          value={teacher.guidance.text}
          multiline
          onChange={(text) =>
            update({
              teacher: {
                ...teacher,
                guidance: { ...teacher.guidance, text: text || undefined },
              },
            })
          }
        />
      </fieldset>
      <LearningFields
        learning={phase.learning}
        pointer={p("learning")}
        change={(learning) => update({ learning })}
      />
    </fieldset>
  );
}
