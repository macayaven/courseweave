import { Button } from "@courseweave/ui";
import type {
  LearnerState,
  AdaptationPreferences,
} from "@courseweave/ui/courseweave-types";
import { useState } from "react";
import { RecordedValue } from "./requirement-card";
import { useStateAction, type StateActionProps } from "./use-state-action";
export function LearningMemory({
  state,
  ...actions
}: StateActionProps & { state: LearnerState }) {
  const [minutes, setMinutes] = useState(
    state.time_budget_minutes?.toString() ?? "",
  );
  const [confirmation, setConfirmation] = useState<
    "reset_state" | "delete_state" | null
  >(null);
  const action = useStateAction(actions);
  const preferences = state.preferences;
  const setPreference = (patch: Partial<AdaptationPreferences>) =>
    void action.submit(
      { type: "set_preferences", preferences: { ...preferences, ...patch } },
      "Learning preferences saved.",
    );
  return (
    <details className="cw-memory">
      <summary>Learning memory &amp; preferences</summary>
      <p>
        Your responses and check attempts are saved for this course. Optional
        adaptation lets the Course assistant use valid saved evidence and your
        preferences. These records are not certification.
      </p>
      <label>
        <input
          type="checkbox"
          checked={preferences.enabled}
          disabled={action.disabled}
          onChange={(event) => setPreference({ enabled: event.target.checked })}
        />
        Use my saved learning evidence for adaptation
      </label>
      <p className="cw-detail">
        With adaptation off, earlier saved evidence is not used for teaching. A
        response or check you submit in this session can still inform the
        immediate discussion. Turning adaptation off clears CourseWeave’s
        earlier server conversation replay; the visible session transcript keeps
        its original labels.
      </p>
      <label>
        Explanation length
        <select
          value={preferences.explanation}
          disabled={action.disabled || !preferences.enabled}
          onChange={(event) =>
            setPreference({
              explanation: event.target
                .value as AdaptationPreferences["explanation"],
            })
          }
        >
          <option value="concise">Concise</option>
          <option value="balanced">Balanced</option>
          <option value="detailed">Detailed</option>
        </select>
      </label>
      <label>
        Optional practice
        <select
          value={preferences.practice}
          disabled={action.disabled || !preferences.enabled}
          onChange={(event) =>
            setPreference({
              practice: event.target.value as AdaptationPreferences["practice"],
            })
          }
        >
          <option value="standard">Standard</option>
          <option value="extra">Extra</option>
        </select>
      </label>
      <label>
        Time available in minutes
        <input
          type="number"
          min={1}
          max={1440}
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
        />
      </label>
      <Button
        type="button"
        disabled={
          action.disabled ||
          (minutes !== "" &&
            (!Number.isInteger(Number(minutes)) ||
              Number(minutes) < 1 ||
              Number(minutes) > 1440))
        }
        onClick={() =>
          void action.submit(
            {
              type: "set_time_budget",
              minutes: minutes === "" ? null : Number(minutes),
            },
            "Time budget saved.",
          )
        }
      >
        Save time budget
      </Button>
      <p className="cw-detail">
        Time budget shapes optional help when adaptation is on. Core
        requirements stay the same.
      </p>
      <details>
        <summary>
          Inspect saved evidence ({state.records.length} responses,{" "}
          {state.attempts.length} checks)
        </summary>
        {state.records.map((record, index) => (
          <section key={index}>
            <h3>
              {record.coordinate.module_id} · {record.coordinate.phase_id} ·{" "}
              {record.coordinate.requirement_id}
            </h3>
            <p>{state.progress.records[index]?.status ?? "unverified"}</p>
            <RecordedValue value={record.value} />
          </section>
        ))}
        {state.attempts.map((attempt, index) => (
          <section key={index}>
            <h3>
              {attempt.module_id} · {attempt.phase_id} · {attempt.check_id}
            </h3>
            <p>
              {state.attempt_statuses.find((item) => item.index === index)
                ?.status ?? "unverified"}{" "}
              · {attempt.correct ? "Correct" : "Incorrect"}
            </p>
            <p>{attempt.feedback}</p>
          </section>
        ))}
        {state.imports.length ? (
          <p>
            {state.imports.length} imported records remain unbound or orphaned
            and do not count toward progress.
          </p>
        ) : null}
        <p>
          Stale responses belong to an earlier requirement. Orphans belong to a
          removed requirement. Neither counts toward current progress.
        </p>
      </details>
      <Button
        type="button"
        disabled={action.disabled}
        onClick={() => setConfirmation("reset_state")}
      >
        Reset learning memory
      </Button>
      <Button
        type="button"
        disabled={action.disabled}
        onClick={() => setConfirmation("delete_state")}
      >
        Delete saved learning data
      </Button>
      {confirmation ? (
        <div role="group" aria-label="Confirm data removal">
          <p>
            This removes this course’s responses, attempts, preferences and
            proposal history, and clears CourseWeave’s server conversation
            replay. The visible session chat remains until you close the course
            session. Provider retention is governed separately.
          </p>
          <Button
            type="button"
            disabled={action.disabled}
            onClick={() =>
              void action
                .submit({ type: confirmation }, "Saved learning data cleared.")
                .then((saved) => {
                  if (saved) setConfirmation(null);
                })
            }
          >
            Confirm removal
          </Button>
          <Button type="button" onClick={() => setConfirmation(null)}>
            Cancel removal
          </Button>
        </div>
      ) : null}
      {action.notice ? <p role="status">{action.notice}</p> : null}
    </details>
  );
}
