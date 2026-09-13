import { Button } from "@courseweave/ui";
import {
  sameRecordCoordinate,
  type LearnerState,
  type Requirement,
  type RecordValue,
} from "@courseweave/ui/courseweave-types";
import { useState } from "react";
import { useStateAction, type StateActionProps } from "./use-state-action";

export function RecordedValue({ value }: { value: RecordValue }) {
  if ("text" in value) return <p className="cw-recorded-text">{value.text}</p>;
  if ("attested" in value)
    return <p>{value.attested ? "Attested by you" : "Not yet attested"}</p>;
  return (
    <>
      <ul>
        {value.references.map((reference, index) => (
          <li key={index}>
            {reference.label}:{" "}
            {"path" in reference ? reference.path : reference.url}
          </li>
        ))}
      </ul>
      {value.note ? <p>{value.note}</p> : null}
    </>
  );
}
export function RequirementCard({
  requirement,
  moduleId,
  phaseId,
  state,
  ...actions
}: StateActionProps & {
  requirement: Requirement;
  moduleId: string;
  phaseId: string;
  state: LearnerState;
}) {
  const coordinate = {
    module_id: moduleId,
    phase_id: phaseId,
    requirement_id: requirement.id,
  };
  const record = state.records.find((item) =>
    sameRecordCoordinate(item.coordinate, coordinate),
  );
  const status = state.progress.records.find((item) =>
    sameRecordCoordinate(item.coordinate, coordinate),
  )?.status;
  const result = state.progress.phases
    .find((item) => item.module_id === moduleId && item.phase_id === phaseId)
    ?.requirements.find((item) => item.requirement_id === requirement.id);
  const [text, setText] = useState(
    record && "text" in record.value ? record.value.text : "",
  );
  const [attested, setAttested] = useState(
    record && "attested" in record.value ? record.value.attested : false,
  );
  const [references, setReferences] = useState<
    Array<{ label: string; location: string }>
  >(
    record && "references" in record.value
      ? record.value.references.map((item) => ({
          label: item.label,
          location: "path" in item ? item.path : item.url,
        }))
      : [{ label: "", location: "" }],
  );
  const [note, setNote] = useState(
    record && "references" in record.value ? (record.value.note ?? "") : "",
  );
  const action = useStateAction(actions);
  if (requirement.type === "artifact_exists")
    return (
      <section className="cw-requirement">
        <h3>{requirement.prompt}</h3>
        <p>
          {result?.satisfied ? "File present" : "File not present"}:{" "}
          <code>{requirement.path}</code>
        </p>
        <p className="cw-detail">
          Presence is checked when state refreshes; it does not verify the
          file’s contents.
        </p>
        {actions.onRefresh ? (
          <Button
            type="button"
            disabled={actions.recovery}
            onClick={() =>
              void actions.onRefresh?.().catch(() => actions.onRecovery?.())
            }
          >
            Check file again
          </Button>
        ) : null}
      </section>
    );
  const value: RecordValue =
    requirement.record_kind === "text"
      ? { text }
      : requirement.record_kind === "attestation"
        ? { attested }
        : {
            references: references.map((item) =>
              /^https:\/\//.test(item.location)
                ? { label: item.label, url: item.location }
                : { label: item.label, path: item.location },
            ),
            ...(note.trim() ? { note } : {}),
          };
  const invalid =
    requirement.record_kind === "text"
      ? !text.trim()
      : requirement.record_kind === "evidence"
        ? references.some((item) => !item.label.trim() || !item.location.trim())
        : false;
  return (
    <section className="cw-requirement">
      {record ? (
        <div className="cw-saved-response">
          <strong>
            {status === "valid"
              ? "Saved response"
              : status === "stale"
                ? "Stale response — the requirement changed"
                : status === "orphan"
                  ? "Orphan response — this requirement was removed"
                  : "Unverified response"}
          </strong>
          <RecordedValue value={record.value} />
          {status !== "valid" ? (
            <p>This response does not count toward current progress.</p>
          ) : null}
        </div>
      ) : null}
      {requirement.record_kind === "text" ? (
        <label>
          {requirement.prompt}
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={16384}
          />
        </label>
      ) : requirement.record_kind === "attestation" ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
            />
            {requirement.prompt}
          </label>
          <p className="cw-detail">
            Your attestation records that you did this; it is not a correctness
            check.
          </p>
        </>
      ) : (
        <fieldset>
          <legend>{requirement.prompt}</legend>
          {references.map((reference, index) => (
            <div key={index}>
              <label>
                Reference label {index + 1}
                <input
                  value={reference.label}
                  onChange={(event) =>
                    setReferences((items) =>
                      items.map((item, i) =>
                        i === index
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </label>
              <label>
                Path or HTTPS URL {index + 1}
                <input
                  value={reference.location}
                  onChange={(event) =>
                    setReferences((items) =>
                      items.map((item, i) =>
                        i === index
                          ? { ...item, location: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              </label>
              {references.length > 1 ? (
                <Button
                  type="button"
                  onClick={() =>
                    setReferences((items) =>
                      items.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove reference {index + 1}
                </Button>
              ) : null}
            </div>
          ))}
          <Button
            type="button"
            disabled={references.length >= 16}
            onClick={() =>
              setReferences((items) => [...items, { label: "", location: "" }])
            }
          >
            Add reference
          </Button>
          <label>
            Optional note
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        </fieldset>
      )}
      <Button
        type="button"
        disabled={action.disabled || invalid}
        onClick={() =>
          void action.submit({
            type: "put_record",
            coordinate,
            curriculum_digest: state.curriculum_digest,
            value,
          })
        }
      >
        {action.pending ? "Saving response" : "Save response"}
      </Button>
      {record ? (
        <Button
          type="button"
          disabled={action.disabled}
          onClick={() =>
            void action.submit(
              {
                type: "clear_record",
                coordinate,
                curriculum_digest: state.curriculum_digest,
              },
              "Response removed.",
            )
          }
        >
          Delete response
        </Button>
      ) : null}
      {action.notice ? <p role="status">{action.notice}</p> : null}
    </section>
  );
}
