import { describe, expect, it } from "vitest";

import { consumeAguiStream } from "@courseweave/ui";

function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
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
      payload: { manifest: { schema_version: 1 } },
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
      'data: not-json\n\n',
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
        stream([`${started}data: {"type":"RUN_ERROR","message":"provider failed"}\n\n`]),
        { threadId: "thread-a", runId: "run-a" },
        () => undefined,
      ),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      consumeAguiStream(stream([started]), { threadId: "thread-a", runId: "run-a" }, () => undefined),
    ).resolves.toEqual({ status: "interrupted", text: "", candidates: [] });

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    const controller = new AbortController();
    const consuming = consumeAguiStream(body, { threadId: "thread-a", runId: "run-a" }, () => undefined, controller.signal);
    controller.abort();
    await expect(consuming).resolves.toEqual({ status: "interrupted", text: "", candidates: [] });
    expect(cancelled).toBe(true);
  });
});
