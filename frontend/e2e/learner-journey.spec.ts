import { expect, test } from "playwright/test";
import {
  course,
  learnerState,
  mountLearner,
  notifyContextChanged,
  type MockApi,
} from "./learn-helpers";
import { phase, digest } from "../apps/learn/test/fixtures";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const captured = JSON.parse(
  readFileSync(
    new URL("../apps/learn/test/fixtures/learner-events.json", import.meta.url),
    "utf8",
  ),
);



test("320px course assistant retains accepted context across navigation, records, checks, consent, hide/show and errors", async ({
  page,
}, testInfo) => {
  const screenshotRoot = testInfo.outputDir;
  mkdirSync(screenshotRoot, {recursive:true});
  const manifest = structuredClone(course);
  const reading = manifest.modules[0]!.phases[0]!;
  reading.completion = {
    requirements: [
      {
        id: "prediction",
        type: "learner_record",
        record_kind: "text",
        prompt: "Predict the message pair.",
      },
    ],
  };
  reading.learning = {
    overview:
      "Read the loop, predict a reply, then check the pairing invariant.",
    duration: { min_minutes: 5, max_minutes: 10 },
    checks: [
      {
        id: "pair",
        type: "single_choice",
        prompt: "Which reply belongs?",
        correct_option_id: "match",
        options: [
          {
            id: "match",
            text: "The matching call",
            feedback: "Match the call ID.",
          },
          {
            id: "any",
            text: "Any call",
            feedback: "Look at the call ID and try again.",
          },
        ],
      },
    ],
  };
  manifest.modules[0]!.phases.push(
    phase({ id: "check-b", title: "Check the invariant" }),
  );
  const snapshot = learnerState();
  snapshot.teacher_availability["module-b/read-b"]!.provider_callable = true;
  snapshot.teacher_availability["module-b/read-b"]!.mode = "available";
  snapshot.teacher_availability["module-b/check-b"] = {
    ...snapshot.teacher_availability["module-b/read-b"]!,
  };
  const api: MockApi = {
    active: true,
    state: snapshot,
    course: manifest,
    authenticatedRequests: 0,
  };
  const learn = await mountLearner(page, api);
  const requests: any[] = [];
  let release: (() => void) | undefined;
  let failNext = false;
  let lessonActive = false;
  const lessonScope = {
    ...captured.events[1].value.lesson,
    module_id: "module-b",
    phase_id: "read-b",
    surface_id: "html-lesson",
    label: "Second lesson",
  };
  await page.route("**/api/guide/lesson", async (route) => {
    const body = route.request().postDataJSON();
    lessonActive = body.action === "use_lesson";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: lessonActive ? "active" : "reset",
        scope: lessonActive ? lessonScope : null,
      }),
    });
  });
  await page.route("**/api/guide", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (failNext) {
      failNext = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "not_configured",
          message: "Unavailable",
          details: {},
        }),
      });
      return;
    }
    const acceptedPhase = api.phaseId ?? "read-b";
    if (requests.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    const events = captured.events.map((event) => {
      if (event.type === "RUN_STARTED" || event.type === "RUN_FINISHED")
        return { ...event, threadId: body.threadId, runId: body.runId };
      if (event.type === "CUSTOM" && event.name === "courseweave.turn_context")
        return {
          ...event,
          value: {
            ...event.value,
            run_id: body.runId,
            source_id: "browser-source",
            module_id: "module-b",
            phase_id: acceptedPhase,
            surface_id: "html-lesson",
            lesson_scope_id: lessonActive ? lessonScope.id : null,
            lesson: lessonActive ? lessonScope : {},
          },
        };
      return event;
    });
    await route.fulfill({
      contentType: "text/event-stream",
      body: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });
  const operations: any[] = [];
  await page.route("**/api/state", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.expected_revision).toBe(snapshot.revision);
    operations.push(body.operation);
    const op = body.operation;
    snapshot.revision++;
    if (op.type === "put_record") {
      snapshot.records = [
        {
          coordinate: op.coordinate,
          value: op.value,
          kind: "text",
          origin: "direct_learner",
          requirement_digest: digest,
        },
      ];
      snapshot.progress.records = [
        { coordinate: op.coordinate, status: "valid" },
      ];
    } else if (op.type === "check_attempt") {
      snapshot.attempts.push({
        module_id: op.module_id,
        phase_id: op.phase_id,
        check_id: op.check_id,
        option_id: op.option_id,
        correct: false,
        feedback: "Look at the call ID and try again.",
        check_digest: digest,
      } as any);
      snapshot.attempt_statuses = [
        {
          index: 0,
          module_id: op.module_id,
          phase_id: op.phase_id,
          check_id: op.check_id,
          status: "valid",
        },
      ];
    } else if (op.type === "set_preferences")
      snapshot.preferences = op.preferences;
    else if (op.type === "delete_state") {
      snapshot.records = [];
      snapshot.attempts = [];
      snapshot.attempt_statuses = [];
      snapshot.progress.records = [];
      snapshot.preferences.enabled = false;
    } else throw new Error("Unexpected state operation");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(snapshot),
    });
  });
  await expect(learn.getByLabel("Ask a question")).toBeVisible();
  await learn.getByText("Lesson & sharing scope", { exact: true }).click();
  await learn.getByRole("button", { name: "Use this lesson" }).click();
  await expect(
    learn.getByText("Using: Second lesson · solutions omitted", {
      exact: true,
    }),
  ).toBeVisible();
  await learn.getByText("Lesson & sharing scope", { exact: true }).click();
  await learn
    .getByLabel("Ask a question")
    .fill("Explain the pairing invariant.");
  await learn.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  api.phaseId = "check-b";
  await notifyContextChanged(page);
  await expect(learn.getByLabel("Current location")).toContainText(
    "Check the invariant",
  );
  release!();
  const turn = learn.locator(".cw-transcript article").first();
  await expect(turn).toContainText("Second module · Second reading");
  await expect(turn).toContainText("Pair the call ID.");
  await expect(learn.getByText("Ready", { exact: true })).toBeVisible();
  expect(
    await turn.locator(".cw-assistant span").evaluate((element) => ({
      text: element.textContent,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
  ).toEqual({
    text: "Pair the call ID.\n\n    messages.append(result)\n\nThen continue.",
    whiteSpace: "pre-wrap",
  });
  api.phaseId = "read-b";
  await notifyContextChanged(page);
  await learn
    .getByLabel("Predict the message pair.")
    .fill("A matching call and result.");
  await learn.getByRole("button", { name: "Save response" }).click();
  await expect(
    learn.getByText("Saved response", { exact: true }),
  ).toBeVisible();
  await learn.getByText("Self-checks (1)", { exact: true }).click();
  await learn.getByLabel("Any call", { exact: true }).check();
  await learn.getByRole("button", { name: "Check answer" }).click();
  await expect(
    learn.getByText("Try again. Look at the call ID and try again.", {
      exact: true,
    }),
  ).toBeVisible();
  await learn.getByText("Reference answer", { exact: true }).click();
  await expect(
    learn.getByText("Match the call ID.", { exact: true }),
  ).toBeVisible();
  await learn.getByRole("button", { name: "Discuss this check" }).click();
  await expect(learn.getByLabel("Ask a question")).toHaveValue(
    "Help me understand this check: Which reply belongs?",
  );
  await expect(turn).toContainText("Explain the pairing invariant.");
  await learn
    .getByText("Learning memory & preferences", { exact: true })
    .click();
  await learn
    .getByLabel("Use my saved learning evidence for adaptation")
    .click();
  await expect.poll(() => snapshot.preferences.enabled).toBe(true);
  await learn
    .getByText("Learning memory & preferences", { exact: true })
    .click();
  await learn.getByText("Self-checks (1)", { exact: true }).click();
  // Hiding the host panel preserves the same live iframe and transcript.
  const identity = await page.locator("#learn-frame").evaluate((frame) => {
    (frame as any).sessionMarker = "same-frame";
    return (frame as HTMLIFrameElement).contentWindow !== null;
  });
  expect(identity).toBe(true);
  await page.locator("#learn-frame").evaluate((frame) => {
    (frame as HTMLElement).hidden = true;
  });
  await page.locator("#learn-frame").evaluate((frame) => {
    (frame as HTMLElement).hidden = false;
  });
  expect(
    await page
      .locator("#learn-frame")
      .evaluate((frame) => (frame as any).sessionMarker),
  ).toBe("same-frame");
  await expect(turn).toContainText("Explain the pairing invariant.");
  await learn.getByText("Lesson & sharing scope", { exact: true }).click();
  await learn.getByRole("button", { name: "Clear lesson scope" }).click();
  await expect(
    learn.getByText("No lesson text selected.", { exact: true }),
  ).toBeVisible();
  await learn.getByText("Lesson & sharing scope", { exact: true }).click();
  failNext = true;
  await learn.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    learn.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(learn.locator(".cw-transcript article").last()).toHaveAttribute(
    "data-state",
    "failed",
  );
  await learn.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(learn.locator(".cw-transcript article")).toHaveCount(2);
  await expect(learn.locator(".cw-transcript article").last()).toHaveAttribute(
    "data-state",
    "finished",
  );
  expect(new Set(requests.map((request) => request.threadId)).size).toBe(1);
  expect(requests[1].messages[0].id).toBe(requests[2].messages[0].id);
  await learn.locator(".cw-course-panel").evaluate((element) => {
    element.scrollTop = 0;
  });
  const layout = await learn
    .locator('[data-testid="learn-rail"]')
    .evaluate((rail) => {
      const textarea = rail.querySelector("textarea")!;
      const composer = rail.querySelector(".cw-composer")!;
      return {
        width: rail.clientWidth,
        noOverflow: rail.scrollWidth <= rail.clientWidth,
        composerBottom: composer.getBoundingClientRect().bottom,
        transcriptHeight: rail.querySelector(".cw-transcript")!.clientHeight,
        composerTop: composer.getBoundingClientRect().top,
        questionTop: rail
          .querySelector(".cw-composer label")!
          .getBoundingClientRect().top,
        height: window.innerHeight,
        textarea: textarea !== null,
      };
    });
  writeFileSync(
    `${screenshotRoot}/task-5-rail-layout.json`,
    JSON.stringify(layout, null, 2),
  );
  expect(layout.width).toBe(320);
  expect(layout.noOverflow).toBe(true);
  expect(layout.composerBottom).toBeLessThanOrEqual(layout.height);
  expect(layout.textarea).toBe(true);
  expect(layout.transcriptHeight).toBeGreaterThanOrEqual(144);
  expect(layout.questionTop).toBeGreaterThanOrEqual(layout.composerTop);
  await page
    .locator("#learn-frame")
    .screenshot({ path: `${screenshotRoot}/task-5-rail-320.png` });
  await learn
    .getByText("Learning memory & preferences", { exact: true })
    .click();
  await learn
    .getByRole("button", { name: "Delete saved learning data" })
    .click();
  expect(snapshot.records).toHaveLength(1);
  await learn.getByRole("button", { name: "Confirm removal" }).click();
  await expect.poll(() => snapshot.records.length).toBe(0);
  await expect(turn).toContainText("Explain the pairing invariant.");
  expect(operations.map((operation) => operation.type)).toEqual([
    "put_record",
    "check_attempt",
    "set_preferences",
    "delete_state",
  ]);
  expect(api.unhandledRequests ?? 0).toBe(0);
});
