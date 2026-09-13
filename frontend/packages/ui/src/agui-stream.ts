import type { EffectiveTeacherPolicy } from "./courseweave-types";

export interface LessonScopeMetadata {
  id: string;
  module_id: string;
  phase_id: string;
  surface_id: string;
  label: string;
  digest: string;
  truncated: boolean;
  omitted_sections: boolean;
  extractor_version: "lesson-visible-v1";
  reset_action: "reset_lesson";
}
export interface TurnContextMetadata {
  version: "turn-context-v1";
  module_id: string | null;
  phase_id: string | null;
  surface_id: string | null;
  source_id: string;
  manifest_etag: string | null;
  state_revision: number;
  consent: boolean;
  teacher_mode: string;
  policy: EffectiveTeacherPolicy | null;
  lesson_scope_id: string | null;
  privacy_epoch: number;
  run_id: string;
  evidence_dependency: string;
  evidence_references: string[];
  assistant_name: "Course assistant";
  lesson: LessonScopeMetadata | Record<string, never>;
  workspace_share: null | {
    scope: "current_run";
    kind: "selection" | "cell" | "output" | "text";
    label: string | null;
  };
}
export interface ProviderOutcomeMetadata {
  version: "provider-evidence-v1";
  status: "ok";
  profile: string;
  capability_version: "capabilities-v1";
  prompt_version: "course-assistant-v1";
  config_fingerprint: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}
export const guideErrorMessages = {
  authentication: "The provider could not authenticate the request.",
  rate_limited: "The provider is rate limited. Try again later.",
  timeout: "The provider request timed out. Try again.",
  malformed_response: "The provider returned an invalid response. Try again.",
  unsupported: "The provider does not support this request.",
  refusal: "The provider declined this request.",
  truncated: "The provider response was incomplete. Try a smaller request.",
  request: "The provider request failed. Try again.",
  input_limit:
    "This request and its required teaching context exceed the input limit.",
  course_identity_changed:
    "The draft identity changed; reopen the course to load its current state.",
} as const;
export type GuideErrorCode = keyof typeof guideErrorMessages;
function safeErrorCode(value: unknown): GuideErrorCode | undefined {
  return typeof value === "string" && Object.hasOwn(guideErrorMessages, value)
    ? (value as GuideErrorCode)
    : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const stringOrNull = (value: unknown) =>
  value === null || typeof value === "string";
const nonnegative = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
function teacherPolicy(value: unknown): boolean {
  if (value === null) return true;
  if (
    !record(value) ||
    !record(value.guidance) ||
    !record(value.guidance.style)
  )
    return false;
  return (
    ["available", "disabled", "observer_only"].includes(String(value.mode)) &&
    typeof value.provider_callable === "boolean" &&
    strings(value.unmet_requirement_ids) &&
    ["builtin", "custom"].includes(String(value.guidance.style.type)) &&
    typeof value.guidance.style.id === "string" &&
    ["none", "gentle", "graduated", "full"].includes(
      String(value.guidance.hint_level),
    ) &&
    strings(value.allowed_share_kinds) &&
    value.allowed_share_kinds.every((item) =>
      ["selection", "cell", "output"].includes(item),
    ) &&
    strings(value.allowed_proposal_types) &&
    value.allowed_proposal_types.every((item) =>
      ["profile", "course", "workspace"].includes(item),
    ) &&
    Number.isSafeInteger(value.max_shared_chars) &&
    Number(value.max_shared_chars) > 0 &&
    Number(value.max_shared_chars) <= 131072
  );
}
export function isTurnContextMetadata(
  value: unknown,
): value is TurnContextMetadata {
  if (!record(value)) return false;
  const share = value.workspace_share,
    lesson = value.lesson;
  return (
    value.version === "turn-context-v1" &&
    [
      "module_id",
      "phase_id",
      "surface_id",
      "manifest_etag",
      "lesson_scope_id",
    ].every((key) => stringOrNull(value[key])) &&
    typeof value.source_id === "string" &&
    nonnegative(value.state_revision) &&
    typeof value.consent === "boolean" &&
    typeof value.teacher_mode === "string" &&
    teacherPolicy(value.policy) &&
    nonnegative(value.privacy_epoch) &&
    typeof value.run_id === "string" &&
    typeof value.evidence_dependency === "string" &&
    strings(value.evidence_references) &&
    value.assistant_name === "Course assistant" &&
    record(lesson) &&
    (Object.keys(lesson).length === 0 ||
      (["id", "module_id", "phase_id", "surface_id", "label", "digest"].every(
        (key) => typeof lesson[key] === "string",
      ) &&
        typeof lesson.truncated === "boolean" &&
        typeof lesson.omitted_sections === "boolean" &&
        lesson.extractor_version === "lesson-visible-v1" &&
        lesson.reset_action === "reset_lesson" &&
        !("excerpt" in lesson))) &&
    (share === null ||
      (record(share) &&
        share.scope === "current_run" &&
        ["selection", "cell", "output", "text"].includes(String(share.kind)) &&
        stringOrNull(share.label)))
  );
}
export function isProviderOutcomeMetadata(
  value: unknown,
): value is ProviderOutcomeMetadata {
  return (
    record(value) &&
    value.version === "provider-evidence-v1" &&
    value.status === "ok" &&
    typeof value.profile === "string" &&
    value.capability_version === "capabilities-v1" &&
    value.prompt_version === "course-assistant-v1" &&
    typeof value.config_fingerprint === "string" &&
    ["duration_ms", "input_tokens", "output_tokens", "requests"].every((key) =>
      nonnegative(value[key]),
    )
  );
}

export type AguiEvent = {
  type:
    | "RUN_STARTED"
    | "TEXT_MESSAGE_START"
    | "TEXT_MESSAGE_CONTENT"
    | "TEXT_MESSAGE_END"
    | "CUSTOM"
    | "RUN_FINISHED"
    | "RUN_ERROR";
  threadId?: string;
  runId?: string;
  messageId?: string;
  delta?: string;
  name?: string;
  value?: unknown;
  message?: string;
  code?: string;
};

export interface StreamOutcome {
  status: "finished" | "error" | "interrupted";
  text: string;
  candidates: string[];
  message?: string;
  code?: GuideErrorCode;
}

function invalid(): never {
  throw new Error("Invalid teacher stream.");
}

function isJsonValue(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

function candidateId(
  event: AguiEvent,
  types: readonly string[],
): string | null {
  if (
    event.name !== "courseweave.proposal_candidate" ||
    typeof event.value !== "object" ||
    event.value === null ||
    Array.isArray(event.value) ||
    Object.keys(event.value).sort().join(",") !== "candidate"
  )
    return null;
  const candidate = (event.value as { candidate?: unknown }).candidate;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    return null;
  if (
    Object.keys(candidate).sort().join(",") !==
    "id,origin,payload,summary,target,target_hash,type"
  )
    return null;
  const value = candidate as Record<string, unknown>;
  return typeof value.id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) &&
    value.id.length <= 80 &&
    typeof value.type === "string" &&
    types.includes(value.type) &&
    value.origin === "teacher_suggested" &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0 &&
    Array.from(value.summary).length <= 240 &&
    isJsonValue(value.target) &&
    typeof value.payload === "object" &&
    value.payload !== null &&
    !Array.isArray(value.payload) &&
    isJsonValue(value.payload) &&
    (value.target_hash === null || typeof value.target_hash === "string")
    ? value.id
    : null;
}

function recordData(record: string): string | null {
  const data = record
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  return data.length > 0 ? data : null;
}

/** Consume one strict AG-UI response body; durable work remains REST-only. */
export async function consumeAguiStream(
  body: ReadableStream<Uint8Array>,
  expected: {
    threadId: string;
    runId: string;
    candidateTypes?: readonly ("profile_patch" | "manifest_replace")[];
  },
  onEvent: (event: AguiEvent) => void,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stage: "start" | "message" | "ended" | "terminal" = "start";
  let messageId: string | null = null;
  let contextSeen = false;
  let providerSeen = false;
  let text = "";
  const candidates: string[] = [];
  let outcome: StreamOutcome | null = null;

  const consume = (record: string) => {
    const data = recordData(record);
    if (data === null) return;
    let event: AguiEvent;
    try {
      event = JSON.parse(data) as AguiEvent;
    } catch {
      return invalid();
    }
    if (!event || typeof event.type !== "string") return invalid();
    if (
      (event.runId !== undefined && event.runId !== expected.runId) ||
      (event.threadId !== undefined && event.threadId !== expected.threadId) ||
      stage === "terminal"
    )
      return invalid();
    if (stage === "start") {
      if (
        event.type !== "RUN_STARTED" ||
        event.runId !== expected.runId ||
        event.threadId !== expected.threadId
      )
        return invalid();
      stage = "message";
    } else if (event.type === "RUN_ERROR") {
      if (
        typeof event.message !== "string" ||
        event.message.trim().length === 0
      )
        return invalid();
      stage = "terminal";
      outcome = {
        status: "error",
        text,
        candidates: [],
        ...(safeErrorCode(event.code)
          ? { code: safeErrorCode(event.code) }
          : {}),
        message: safeErrorCode(event.code)
          ? guideErrorMessages[safeErrorCode(event.code)!]
          : "The teacher run failed. Try again with a new request.",
      };
    } else if (stage === "message") {
      if (
        event.type === "CUSTOM" &&
        event.name === "courseweave.turn_context" &&
        messageId === null &&
        !contextSeen &&
        isTurnContextMetadata(event.value) &&
        event.value.run_id === expected.runId
      )
        contextSeen = true;
      else if (
        event.type === "CUSTOM" &&
        event.name === "courseweave.provider_outcome" &&
        messageId !== null &&
        !providerSeen &&
        isProviderOutcomeMetadata(event.value)
      )
        providerSeen = true;
      else if (
        event.type === "TEXT_MESSAGE_START" &&
        messageId === null &&
        typeof event.messageId === "string" &&
        event.messageId.length > 0
      )
        messageId = event.messageId;
      else if (
        event.type === "TEXT_MESSAGE_CONTENT" &&
        !providerSeen &&
        messageId !== null &&
        event.messageId === messageId &&
        typeof event.delta === "string"
      )
        text += event.delta;
      else if (
        event.type === "TEXT_MESSAGE_END" &&
        messageId !== null &&
        event.messageId === messageId
      )
        stage = "ended";
      else return invalid();
    } else if (stage === "ended") {
      if (event.type === "CUSTOM") {
        const id = candidateId(
          event,
          expected.candidateTypes ?? ["manifest_replace"],
        );
        if (id === null || candidates.includes(id)) return invalid();
        candidates.push(id);
      } else if (
        event.type === "RUN_FINISHED" &&
        event.runId === expected.runId &&
        event.threadId === expected.threadId
      ) {
        stage = "terminal";
        outcome = { status: "finished", text, candidates };
      } else return invalid();
    } else return invalid();
    onEvent(event);
  };
  const drain = () => {
    const boundary = /\r?\n\r?\n/.exec(buffer);
    if (boundary === null || boundary.index === undefined) return false;
    consume(buffer.slice(0, boundary.index));
    buffer = buffer.slice(boundary.index + boundary[0].length);
    return true;
  };
  const cancelReader = () => void reader.cancel();
  signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal?.aborted) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      while (drain()) {
        // Consume all complete records, including forbidden trailing events.
      }
    }
    if (signal?.aborted) return { status: "interrupted", text, candidates: [] };
    buffer += decoder.decode();
    while (drain()) {
      // A decoder flush can complete a final event.
    }
    if (buffer.trim().length > 0) invalid();
  } catch (error) {
    if (signal?.aborted) return { status: "interrupted", text, candidates: [] };
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  return outcome ?? { status: "interrupted", text, candidates: [] };
}
