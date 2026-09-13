import type { ChangeEvent, Dispatch } from "react";
import type { AuthorSurface } from "@courseweave/ui";
import type { AuthorDocumentState, DraftAction } from "./draft";
import { ArrayFields, Choices, SelectField } from "./field-inputs";
import { PhaseFields } from "./phase-fields";
import { SurfaceFields } from "./surface-fields";
import { pointerToControlId } from "./validation";

type InspectorProps = {
  state: AuthorDocumentState;
  dispatch: Dispatch<DraftAction>;
};
function text(
  event: ChangeEvent<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >,
): string {
  return event.currentTarget.value;
}
function CourseInspector({ state, dispatch }: InspectorProps) {
  const course = state.draft;
  return (
    <fieldset>
      <legend>Course</legend>
      <label>
        Course ID
        <input
          id={pointerToControlId("/id")}
          value={course.id}
          onChange={(event) =>
            dispatch({ type: "course.update", patch: { id: text(event) } })
          }
        />
      </label>
      <label>
        Course title
        <input
          id={pointerToControlId("/title")}
          value={course.title}
          onChange={(event) =>
            dispatch({ type: "course.update", patch: { title: text(event) } })
          }
        />
      </label>
      <label>
        Course description
        <textarea
          id={pointerToControlId("/description")}
          value={course.description}
          onChange={(event) =>
            dispatch({
              type: "course.update",
              patch: { description: text(event) },
            })
          }
        />
      </label>
      <label>
        Entry module
        <select
          id={pointerToControlId("/entry_module_id")}
          value={course.entryModuleKey ?? ""}
          onChange={(event) =>
            dispatch({ type: "entry.select", moduleKey: text(event) || null })
          }
        >
          <option value="">None</option>
          {course.modules.map((module) => (
            <option key={module.clientKey} value={module.clientKey}>
              {module.title || module.id || "Unnamed module"}
            </option>
          ))}
        </select>
      </label>
      <SelectField
        label="Notebook runtime"
        pointer="/runtime"
        value={course.runtime ? "jupyter" : "none"}
        options={["none", "jupyter"]}
        onChange={(value) =>
          dispatch({
            type: "course.update",
            patch: {
              runtime:
                value === "none"
                  ? null
                  : { type: "jupyter", kernel: { type: "python_uv_project" } },
            },
          })
        }
      />
      <fieldset>
        <legend>Policies</legend>
        <Choices
          label="Allowed sharing"
          pointer="/policies/allowed_share_kinds"
          values={course.policies.allowed_share_kinds}
          options={["selection", "cell", "output"]}
          onChange={(allowed_share_kinds) =>
            dispatch({ type: "policy.update", patch: { allowed_share_kinds } })
          }
        />
        <Choices
          label="Allowed proposals"
          pointer="/policies/allowed_proposal_types"
          values={course.policies.allowed_proposal_types}
          options={["profile", "course", "workspace"]}
          onChange={(allowed_proposal_types) =>
            dispatch({
              type: "policy.update",
              patch: { allowed_proposal_types },
            })
          }
        />
        <label>
          Content sharing
          <select
            id={pointerToControlId("/policies/content_sharing")}
            value={course.policies.content_sharing}
            onChange={(event) =>
              dispatch({
                type: "policy.update",
                patch: { content_sharing: text(event) as "explicit_only" },
              })
            }
          >
            <option value="explicit_only">explicit_only</option>
          </select>
        </label>
        <label>
          Durable mutation
          <select
            id={pointerToControlId("/policies/durable_mutation")}
            value={course.policies.durable_mutation}
            onChange={(event) =>
              dispatch({
                type: "policy.update",
                patch: {
                  durable_mutation: text(
                    event,
                  ) as "proposal_or_direct_student_action",
                },
              })
            }
          >
            <option value="proposal_or_direct_student_action">
              proposal_or_direct_student_action
            </option>
          </select>
        </label>
        <label>
          Terminal execution
          <select
            id={pointerToControlId("/policies/terminal_execution")}
            value={course.policies.terminal_execution}
            onChange={(event) =>
              dispatch({
                type: "policy.update",
                patch: { terminal_execution: text(event) as "student_only" },
              })
            }
          >
            <option value="student_only">student_only</option>
          </select>
        </label>
        <label>
          Conversation memory
          <select
            id={pointerToControlId("/policies/conversation_memory")}
            value={course.policies.conversation_memory}
            onChange={(event) =>
              dispatch({
                type: "policy.update",
                patch: { conversation_memory: text(event) as "session_only" },
              })
            }
          >
            <option value="session_only">session_only</option>
          </select>
        </label>
        <label>
          Max shared characters
          <input
            id={pointerToControlId("/policies/max_shared_chars")}
            type="number"
            value={course.policies.max_shared_chars}
            onChange={(event) =>
              dispatch({
                type: "policy.update",
                patch: { max_shared_chars: Number(text(event)) },
              })
            }
          />
        </label>
        <ArrayFields
          label="Workspace write globs"
          itemLabel="Workspace write glob"
          values={course.policies.workspace_write_globs}
          pointer="/policies/workspace_write_globs"
          onChange={(workspace_write_globs) =>
            dispatch({
              type: "policy.update",
              patch: { workspace_write_globs },
            })
          }
        />
      </fieldset>
    </fieldset>
  );
}
function ModuleInspector({
  state,
  dispatch,
  moduleKey,
}: InspectorProps & { moduleKey: string }) {
  const module = state.draft.modules.find(
    (candidate) => candidate.clientKey === moduleKey,
  );
  if (module === undefined) return null;
  const moduleIndex = state.draft.modules.findIndex(
    (candidate) => candidate.clientKey === moduleKey,
  );
  const id = (field: string) =>
    pointerToControlId(`/modules/${moduleIndex}/${field}`);
  return (
    <fieldset>
      <legend>Module</legend>
      <label>
        Module ID
        <input
          id={id("id")}
          value={module.id}
          onChange={(event) =>
            dispatch({
              type: "module.update",
              moduleKey,
              patch: { id: text(event) },
            })
          }
        />
      </label>
      <label>
        Module title
        <input
          id={id("title")}
          value={module.title}
          onChange={(event) =>
            dispatch({
              type: "module.update",
              moduleKey,
              patch: { title: text(event) },
            })
          }
        />
      </label>
      <label>
        Module description
        <textarea
          id={id("description")}
          value={module.description}
          onChange={(event) =>
            dispatch({
              type: "module.update",
              moduleKey,
              patch: { description: text(event) },
            })
          }
        />
      </label>
    </fieldset>
  );
}
function PhaseInspector({
  state,
  dispatch,
  moduleKey,
  phaseKey,
}: InspectorProps & { moduleKey: string; phaseKey: string }) {
  const mi = state.draft.modules.findIndex((m) => m.clientKey === moduleKey);
  const pi =
    state.draft.modules[mi]?.phases.findIndex(
      (p) => p.clientKey === phaseKey,
    ) ?? -1;
  const phase = state.draft.modules[mi]?.phases[pi];
  if (!phase) return null;
  return (
    <PhaseFields
      phase={phase}
      pointer={`/modules/${mi}/phases/${pi}`}
      update={(patch) =>
        dispatch({ type: "phase.update", moduleKey, phaseKey, patch })
      }
    />
  );
}
function SurfaceInspector({
  state,
  dispatch,
  moduleKey,
  phaseKey,
  surfaceKey,
}: InspectorProps & {
  moduleKey: string;
  phaseKey: string;
  surfaceKey: string;
}) {
  const surface = state.draft.modules
    .find((module) => module.clientKey === moduleKey)
    ?.phases.find((phase) => phase.clientKey === phaseKey)
    ?.surfaces.find((candidate) => candidate.clientKey === surfaceKey);
  if (surface === undefined) return null;
  const update = (patch: Record<string, unknown>) =>
    dispatch({
      type: "surface.update",
      moduleKey,
      phaseKey,
      surfaceKey,
      patch,
    });
  const replace = (next: AuthorSurface) =>
    dispatch({
      type: "surface.replace",
      moduleKey,
      phaseKey,
      surfaceKey,
      surface: next,
    });
  const moduleIndex = state.draft.modules.findIndex(
    (module) => module.clientKey === moduleKey,
  );
  const phaseIndex =
    state.draft.modules[moduleIndex]?.phases.findIndex(
      (phase) => phase.clientKey === phaseKey,
    ) ?? -1;
  const surfaceIndex =
    state.draft.modules[moduleIndex]?.phases[phaseIndex]?.surfaces.findIndex(
      (candidate) => candidate.clientKey === surfaceKey,
    ) ?? -1;
  return (
    <fieldset
      id={pointerToControlId(
        `/modules/${moduleIndex}/phases/${phaseIndex}/surfaces/${surfaceIndex}`,
      )}
      tabIndex={-1}
    >
      <legend>Surface</legend>
      <SurfaceFields
        surface={surface}
        update={update}
        replace={replace}
        pointer={`/modules/${moduleIndex}/phases/${phaseIndex}/surfaces/${surfaceIndex}`}
      />
    </fieldset>
  );
}
export function Inspector({ state, dispatch }: InspectorProps) {
  return (
    <section aria-label="Inspector">
      <h2>Inspector</h2>
      {state.selection.type === "course" ? (
        <CourseInspector state={state} dispatch={dispatch} />
      ) : null}
      {state.selection.type === "module" ? (
        <ModuleInspector
          state={state}
          dispatch={dispatch}
          moduleKey={state.selection.moduleKey}
        />
      ) : null}
      {state.selection.type === "phase" ? (
        <PhaseInspector
          state={state}
          dispatch={dispatch}
          moduleKey={state.selection.moduleKey}
          phaseKey={state.selection.phaseKey}
        />
      ) : null}
      {state.selection.type === "surface" ? (
        <SurfaceInspector
          state={state}
          dispatch={dispatch}
          moduleKey={state.selection.moduleKey}
          phaseKey={state.selection.phaseKey}
          surfaceKey={state.selection.surfaceKey}
        />
      ) : null}
    </section>
  );
}
