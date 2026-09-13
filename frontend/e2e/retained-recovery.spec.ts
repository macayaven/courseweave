import { expect, test } from "playwright/test";
import { build } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { course, learnerState } from "./learn-helpers";

const ports = fileURLToPath(
  new URL("./retained-recovery-ports.ts", import.meta.url),
);
const captured = JSON.parse(
  await readFile(
    new URL("../apps/learn/test/fixtures/learner-events.json", import.meta.url),
    "utf8",
  ),
);
test("real retained guide recovers through its command and Reconnect while preserving thread and draft until current context confirms", async ({
  page,
}, testInfo) => {
  const output = testInfo.outputPath("harness");
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: [
        "application",
        "apputils",
        "coreutils",
        "docmanager",
        "fileeditor",
        "notebook",
        "settingregistry",
        "terminal",
        "services",
      ].map((name) => ({
        find: `@jupyterlab/${name}`,
        replacement: ports,
      })),
    },
    build: {
      target: "esnext",
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: fileURLToPath(
          new URL("./retained-recovery-harness.ts", import.meta.url),
        ),
        formats: ["es"],
        fileName: () => "harness.js",
      },
    },
  });
  const bundle = await readFile(`${output}/harness.js`, "utf8");
  const state = learnerState();
  state.teacher_availability["module-b/read-b"]!.provider_callable = true;
  state.teacher_availability["module-b/read-b"]!.mode = "available";
  state.teacher_availability["module-a/read-a"] = {
    ...state.teacher_availability["module-b/read-b"]!,
  };
  let accepted = {
    module_id: "module-b",
    phase_id: "read-b",
    surface_id: "html-lesson",
    reason: "active_path",
  };
  let sourceId = "";
  let failContext = false;
  let holdContext = false;
  let release: (() => void) | undefined;
  let failGuide = false;
  const contexts: any[] = [];
  const requests: any[] = [];
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/recovery-harness")
      return route.fulfill({
        contentType: "text/html",
        body: '<style>body{margin:0}.cw-Guide{width:320px;height:660px}.cw-Guide-iframe{width:320px;height:600px;border:0}.lm-mod-hidden{display:none!important}</style><script type="module" src="/recovery-harness.js"></script>',
      });
    if (path === "/recovery-harness.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: bundle,
      });
    if (path === "/learn/" || path.startsWith("/learn/assets/"))
      return route.continue();
    if (path === "/courseweave/course") return json(course);
    if (path === "/courseweave/runtime")
      return json({
        serviceOrigin: "http://127.0.0.1:4173",
        capabilityToken: "browser-test-capability",
      });
    if (path === "/courseweave/context") {
      const body = route.request().postDataJSON();
      contexts.push(body);
      sourceId = body.source_id;
      if (failContext) {
        failContext = false;
        return json({ code: "backend_unavailable" }, 503);
      }
      if (holdContext)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      accepted =
        body.active_path === "latest.py"
          ? {
              module_id: "module-a",
              phase_id: "read-a",
              surface_id: null as any,
              reason: "active_path",
            }
          : {
              module_id: "module-b",
              phase_id: "read-b",
              surface_id: "html-lesson",
              reason: "active_path",
            };
      return json(accepted);
    }
    if (path === "/api/bootstrap") return json({ ...state, manifest: course });
    if (path === "/api/proposals") return json([]);
    if (path === "/api/context")
      return json({ context: { source_id: sourceId }, resolved: accepted });
    if (path === "/api/guide") {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (failGuide) {
        failGuide = false;
        return json(
          { code: "unauthorized", message: "Reconnect", details: {} },
          401,
        );
      }
      const events = captured.events.map((event: any) =>
        event.type === "RUN_STARTED" || event.type === "RUN_FINISHED"
          ? { ...event, threadId: body.threadId, runId: body.runId }
          : event.name === "courseweave.turn_context"
            ? {
                ...event,
                value: {
                  ...event.value,
                  run_id: body.runId,
                  source_id: sourceId,
                  ...accepted,
                  lesson_scope_id: null,
                  lesson: {},
                },
              }
            : event,
      );
      return route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((event: any) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  await page.goto("/recovery-harness");
  const learn = page.frameLocator('iframe[title="CourseWeave guide"]');
  const send = learn.getByRole("button", { name: "Send", exact: true });
  await learn.getByLabel("Ask a question").fill("Keep this conversation.");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(learn.locator(".cw-transcript article")).toHaveAttribute(
    "data-state",
    "finished",
  );
  await learn.getByLabel("Ask a question").fill("Preserve the unsent draft.");
  failContext = true;
  await page.evaluate(() =>
    (window as any).recoveryHarness.navigate("failed.py"),
  );
  await expect(page.locator("[data-courseweave-recovery]")).toBeVisible();
  await expect(send).toBeDisabled();
  await page.evaluate(() => {
    const h = (window as any).recoveryHarness;
    h.navigate("latest.py");
    h.close();
  });
  holdContext = true;
  await page.evaluate(() => (window as any).recoveryHarness.reopen());
  await expect.poll(() => contexts.length).toBe(3);
  expect(contexts[2].active_path).toBe("latest.py");
  await expect(page.locator("[data-courseweave-recovery]")).toBeVisible();
  await expect(send).toBeDisabled();
  holdContext = false;
  release!();
  await expect(page.locator("[data-courseweave-recovery]")).toHaveCount(0);
  await expect(learn.getByLabel("Current location")).toContainText(
    "First reading",
  );
  await expect(send).toBeEnabled();
  await expect(learn.getByLabel("Ask a question")).toHaveValue(
    "Preserve the unsent draft.",
  );
  expect(
    await page.evaluate(() => (window as any).recoveryHarness.sameWindow()),
  ).toBe(true);
  failGuide = true;
  await send.click();
  await expect(
    learn.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeVisible();
  await learn.getByLabel("Ask a question").fill("Draft across Reconnect.");
  failContext = true;
  await page.evaluate(() =>
    (window as any).recoveryHarness.navigate("failed-again.py"),
  );
  await expect(page.locator("[data-courseweave-recovery]")).toBeVisible();
  await page.evaluate(() =>
    (window as any).recoveryHarness.navigate("first.py"),
  );
  holdContext = true;
  await learn.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => contexts.length).toBe(5);
  expect(contexts[4].active_path).toBe("first.py");
  await expect(
    learn.getByRole("heading", { name: "Browser Course" }),
  ).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(page.locator("[data-courseweave-recovery]")).toBeVisible();
  holdContext = false;
  release!();
  await expect(learn.getByLabel("Current location")).toContainText(
    "Second reading",
  );
  await expect(page.locator("[data-courseweave-recovery]")).toHaveCount(0);
  await expect(send).toBeEnabled();
  await expect(learn.getByLabel("Ask a question")).toHaveValue(
    "Draft across Reconnect.",
  );
  await expect(learn.locator(".cw-transcript article").first()).toContainText(
    "Keep this conversation.",
  );
  await send.click();
  await expect(learn.locator(".cw-transcript article").last()).toHaveAttribute(
    "data-state",
    "finished",
  );
  expect(new Set(requests.map((request) => request.threadId)).size).toBe(1);
  expect(
    await page.evaluate(() => (window as any).recoveryHarness.sameWindow()),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("retained-recovery.png") });
});
