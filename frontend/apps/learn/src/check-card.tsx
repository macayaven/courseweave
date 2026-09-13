import { Button } from "@courseweave/ui";
import type { LearnerState } from "@courseweave/ui/courseweave-types";
import type { AuthorCheck } from "@courseweave/ui";
import { useState } from "react";
import { useStateAction, type StateActionProps } from "./use-state-action";
export function CheckCard({
  check,
  moduleId,
  phaseId,
  state,
  onDiscuss,
  ...actions
}: StateActionProps & {
  check: AuthorCheck;
  moduleId: string;
  phaseId: string;
  state: LearnerState;
  onDiscuss?(prompt: string): void;
}) {
  const [option, setOption] = useState("");
  const action = useStateAction(actions);
  const statuses = state.attempt_statuses.filter(
    (item) =>
      item.module_id === moduleId &&
      item.phase_id === phaseId &&
      item.check_id === check.id,
  );
  const latest = statuses.at(-1);
  const attempt = latest ? state.attempts[latest.index] : undefined;
  const valid = latest?.status === "valid" && attempt !== undefined;
  const correct = check.options.find(
    (item) => item.id === check.correct_option_id,
  );
  return (
    <section className="cw-check">
      <fieldset>
        <legend>{check.prompt}</legend>
        {check.options.map((item) => (
          <label key={item.id}>
            <input
              type="radio"
              name={`check-${moduleId}-${phaseId}-${check.id}`}
              value={item.id}
              checked={option === item.id}
              onChange={() => setOption(item.id)}
            />
            {item.text}
          </label>
        ))}
      </fieldset>
      <Button
        type="button"
        disabled={action.disabled || !option}
        onClick={() =>
          void action.submit(
            {
              type: "check_attempt",
              module_id: moduleId,
              phase_id: phaseId,
              check_id: check.id,
              option_id: option,
              curriculum_digest: state.curriculum_digest,
            },
            "Answer recorded.",
          )
        }
      >
        {action.pending
          ? "Checking answer"
          : valid
            ? "Try another answer"
            : "Check answer"}
      </Button>
      {valid ? (
        <div>
          <p role="status">
            {attempt.correct ? "Correct." : "Try again."} {attempt.feedback}
          </p>
          <details>
            <summary>Reference answer</summary>
            <p>{correct?.text}</p>
            <p>{correct?.feedback}</p>
          </details>
        </div>
      ) : latest ? (
        <p>Earlier answer is {latest.status}; try this version of the check.</p>
      ) : null}
      {onDiscuss ? (
        <Button
          type="button"
          onClick={() =>
            onDiscuss(`Help me understand this check: ${check.prompt}`)
          }
        >
          Discuss this check
        </Button>
      ) : null}
      <p className="cw-detail">
        Practice feedback does not mark an activity complete.
      </p>
      {action.notice ? <p role="status">{action.notice}</p> : null}
    </section>
  );
}
