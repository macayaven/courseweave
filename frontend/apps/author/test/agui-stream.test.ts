import { describe, expect, it } from "vitest";

import { consumeAguiStream } from "@courseweave/ui";

function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts)
        controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

const started =
  'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\n';
const message =
  'data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"hello"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n';
const finished =
  'data: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}\n\n';

describe("Author AG-UI stream", () => {
  it("accepts only the ordered POST response events and exact manifest candidate", async () => {
    const candidate = {
      id: "candidate-a",
      type: "manifest_replace",
      origin: "teacher_suggested",
      summary: "Tighten the course",
      target: "courseweave.json",
      payload: { manifest: { schema_version: 2 } },
      target_hash: "a".repeat(64),
    };
    const wire = `${started}${message}data: ${JSON.stringify({ type: "CUSTOM", name: "courseweave.proposal_candidate", value: { candidate } })}\n\n${finished}`;

    await expect(
      consumeAguiStream(
        stream([wire.slice(0, 31), wire.slice(31)]),
        { threadId: "thread-a", runId: "run-a" },
        () => undefined,
      ),
    ).resolves.toEqual({
      status: "finished",
      text: "hello",
      candidates: ["candidate-a"],
    });
  });

  it("rejects malformed, wrong-ID, trailing, and invalid candidate events", async () => {
    const expected = { threadId: "thread-a", runId: "run-a" };
    for (const wire of [
      "data: not-json\n\n",
      'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"other"}\n\n',
      `${started}${message}${finished}data: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}\n\n`,
      `${started}${message}data: {"type":"CUSTOM","name":"untrusted","value":{}}\n\n${finished}`,
    ]) {
      await expect(
        consumeAguiStream(stream([wire]), expected, () => undefined),
      ).rejects.toThrow("Invalid teacher stream.");
    }
  });

  it("reports RUN_ERROR, interrupted EOF, and abort without resuming", async () => {
    await expect(
      consumeAguiStream(
        stream([
          `${started}data: {"type":"RUN_ERROR","message":"provider failed"}\n\n`,
        ]),
        { threadId: "thread-a", runId: "run-a" },
        () => undefined,
      ),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      consumeAguiStream(
        stream([started]),
        { threadId: "thread-a", runId: "run-a" },
        () => undefined,
      ),
    ).resolves.toEqual({ status: "interrupted", text: "", candidates: [] });

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const consuming = consumeAguiStream(
      body,
      { threadId: "thread-a", runId: "run-a" },
      () => undefined,
      controller.signal,
    );
    controller.abort();
    await expect(consuming).resolves.toEqual({
      status: "interrupted",
      text: "",
      candidates: [],
    });
    expect(cancelled).toBe(true);
  });
});

const custom = (name: string, value: unknown) =>
  `data: ${JSON.stringify({ type: "CUSTOM", name, value })}\n\n`;
const turnContext = {
  version: "turn-context-v1",
  module_id: "module",
  phase_id: "phase",
  surface_id: null,
  source_id: "author",
  manifest_etag: '"hash"',
  state_revision: 2,
  consent: false,
  teacher_mode: "curriculum_designer",
  policy: null,
  lesson_scope_id: null,
  privacy_epoch: 0,
  run_id: "run-a",
  evidence_dependency: "a".repeat(64),
  evidence_references: [],
  assistant_name: "Course assistant",
  lesson: {},
  workspace_share: null,
};
const providerOutcome = {
  version: "provider-evidence-v1",
  status: "ok",
  profile: "text-only-v1",
  capability_version: "capabilities-v1",
  prompt_version: "course-assistant-v1",
  config_fingerprint: "b".repeat(64),
  duration_ms: 1,
  input_tokens: 2,
  output_tokens: 3,
  requests: 1,
};
const turn = custom("courseweave.turn_context", turnContext);
const evidence = custom("courseweave.provider_outcome", providerOutcome);
const textStart =
  'data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\n';
const textEnd = 'data: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n';
const candidate = custom("courseweave.proposal_candidate", {
  candidate: {
    id: "candidate-a",
    type: "manifest_replace",
    origin: "teacher_suggested",
    summary: "Update Learning",
    target: "courseweave.json",
    payload: { manifest: { schema_version: 2 } },
    target_hash: null,
  },
});
it("accepts captured turn metadata before text and provider evidence before text end", async () => {
  const events: unknown[] = [];
  const result = await consumeAguiStream(
    stream([
      started + turn + textStart + evidence + textEnd + candidate + finished,
    ]),
    { threadId: "thread-a", runId: "run-a" },
    (event) => events.push(event),
  );
  expect(result).toEqual({
    status: "finished",
    text: "",
    candidates: ["candidate-a"],
  });
  expect(events).toContainEqual({
    type: "CUSTOM",
    name: "courseweave.turn_context",
    value: turnContext,
  });
});
it("rejects reordered, repeated, wrong-run, and malformed metadata", async () => {
  for (const wire of [
    started + textStart + turn + textEnd + finished,
    started + turn + turn + message + finished,
    started + evidence + message + finished,
    started + turn + textStart + evidence + evidence + textEnd + finished,
    started + turn + message + evidence + finished,
    started +
      custom("courseweave.turn_context", { ...turnContext, run_id: "wrong" }) +
      message +
      finished,
    started +
      custom("courseweave.turn_context", {
        ...turnContext,
        state_revision: "bad",
      }) +
      message +
      finished,
    started +
      turn +
      textStart +
      custom("courseweave.provider_outcome", {
        ...providerOutcome,
        status: "failed",
      }) +
      textEnd +
      finished,
  ]) {
    await expect(
      consumeAguiStream(
        stream([wire]),
        { threadId: "thread-a", runId: "run-a" },
        () => undefined,
      ),
    ).rejects.toThrow("Invalid teacher stream.");
  }
});
it("never releases provisional candidates after an error or interrupted terminal and safely classifies input limits", async () => {
  for (const end of [
    "",
    'data: {"type":"RUN_ERROR","code":"input_limit","message":"secret upstream body"}\n\n',
  ]) {
    const result = await consumeAguiStream(
      stream([
        started + turn + textStart + evidence + textEnd + candidate + end,
      ]),
      { threadId: "thread-a", runId: "run-a" },
      () => undefined,
    );
    expect(result.candidates).toEqual([]);
    if (end) {
      expect(result.code).toBe("input_limit");
      expect(result.message).toContain("input limit");
      expect(result.message).not.toContain("secret");
    }
  }
});
