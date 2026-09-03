import { expect, test, type Locator, type Page } from "playwright/test";
import { readFile } from "node:fs/promises";

import {
  type AuthorApiFixture,
  createAuthorApi,
  emptyManifest,
  expectGuideRequest,
  expectNoBoundaryViolations,
  expectValidationCompletion,
  expectValidationRequest,
  loadExample,
  minimalManifest,
  mountAuthor,
  proposalFixture,
  reloadAuthor,
  seedProposal,
} from "./author-helpers";

function queueStructuralValidations(
  api: AuthorApiFixture,
  ...manifests: Array<Record<string, unknown>>
): void {
  for (const manifest of manifests) expectValidationRequest(api, "structural", manifest);
}

function structuralValidationRequests(...manifests: Array<Record<string, unknown>>) {
  return manifests.map((manifest) => ({ manifest, mode: "structural" as const }));
}

function newBrowserModule(phaseTitle = "New phase"): Record<string, unknown> {
  return {
    id: "browser-added",
    title: "Browser added",
    description: "",
    phases: [{
      id: "phase",
      title: phaseTitle,
      kind: "read",
      teacher_mode: "reading_companion",
      surfaces: [{ id: "surface", type: "markdown", role: "primary", path: "content.md" }],
      completion: { type: "manual" },
      capabilities: {
        chat: false,
        hint_level: "none",
        share_selection: false,
        share_cell: false,
        share_output: false,
        create_profile_proposal: false,
        create_course_proposal: false,
        create_workspace_proposal: false,
      },
    }],
  };
}

function expectedWorkflowManifest(source: Record<string, unknown>, editedPhaseTitle: string): Record<string, unknown> {
  const copiedModule = structuredClone((source.modules as Array<Record<string, unknown>>)[0]!);
  copiedModule.id = `${copiedModule.id as string}-copy`;
  const phases = copiedModule.phases as Array<Record<string, unknown>>;
  for (const phase of phases) {
    phase.id = `${phase.id as string}-copy`;
    for (const surface of phase.surfaces as Array<Record<string, unknown>>) {
      surface.id = `${surface.id as string}-copy`;
    }
  }
  phases[0]!.title = editedPhaseTitle;
  return {
    ...structuredClone(source),
    entry_module_id: "browser-added",
    modules: [copiedModule, newBrowserModule()],
  };
}

function expectedFirstManifest(phaseTitle: string): Record<string, unknown> {
  const manifest = emptyManifest();
  const module = newBrowserModule(phaseTitle);
  module.id = "first-module";
  module.title = "First module";
  return { ...manifest, entry_module_id: "first-module", modules: [module] };
}

async function tabTo(page: Page, target: Locator, direction: "forward" | "reverse" = "forward", limit = 120): Promise<number> {
  for (let step = 1; step <= limit; step += 1) {
    await page.keyboard.press(direction === "forward" ? "Tab" : "Shift+Tab");
    if (await target.evaluate((element) => element.ownerDocument.activeElement === element)) return step;
  }
  throw new Error(`Sequential keyboard focus did not reach the requested control within ${limit} steps.`);
}

test.beforeEach(({ baseURL }) => {
  test.skip(baseURL !== "http://127.0.0.1:4174", "requires the dedicated Author preview");
});

for (const example of ["minimal-course", "cli-course"] as const) {
  test(`runs the complete deterministic Author workflow for ${example}`, async ({ page }) => {
    const source = loadExample(example);
    const api = createAuthorApi(source);
    const author = await mountAuthor(page, api);
    const sourceModules = source.modules as Array<Record<string, unknown>>;
    const sourceModule = sourceModules[0]!;
    const sourcePhases = sourceModule.phases as Array<Record<string, unknown>>;
    const firstPhase = sourcePhases[0]!;
    const moduleTitle = sourceModule.title as string;
    const phaseTitle = firstPhase.title as string;

    await expect(author.getByLabel("Course title")).toHaveValue(source.title as string);
    await author.getByRole("button", { name: `Select phase ${phaseTitle}` }).click();
    await author.getByLabel("Phase title").fill(`${phaseTitle} edited in browser`);
    await expect(author.getByText(`${phaseTitle} edited in browser`, { exact: true })).toBeVisible();
    await expect(author.getByText("Preview only — learner actions are disabled.")).toBeVisible();

    await author.getByRole("button", { name: `Select module ${moduleTitle}`, exact: true }).click();
    await author.getByRole("button", { name: `Duplicate module ${moduleTitle}`, exact: true }).press("Enter");
    await expect(author.getByRole("button", { name: `Select module ${moduleTitle}`, exact: true })).toHaveCount(2);
    const moveCopyUp = author.getByRole("button", { name: `Move module ${moduleTitle} up`, exact: true });
    await moveCopyUp.press("Enter");
    await expect(moveCopyUp).toBeFocused();

    await author.getByRole("button", { name: "Add module" }).press("Enter");
    await expect(author.getByRole("dialog", { name: "New module" })).toBeVisible();
    await author.getByLabel("New module ID").fill("browser-added");
    await author.getByLabel("New module title").fill("Browser added");
    await author.getByRole("button", { name: "Create module" }).press("Enter");
    await expect(author.getByRole("button", { name: "Select module Browser added" })).toBeFocused();

    const duplicateTitles = author.getByRole("button", { name: `Select module ${moduleTitle}`, exact: true });
    await duplicateTitles.nth(1).click();
    await author.getByRole("button", { name: `Delete module ${moduleTitle}`, exact: true }).press("Enter");
    await expect(author.getByRole("button", { name: "Select module Browser added" })).toBeFocused();
    await expect(author.getByRole("button", { name: `Select module ${moduleTitle}`, exact: true })).toHaveCount(1);

    const expectedManifest = expectedWorkflowManifest(source, `${phaseTitle} edited in browser`);
    expectValidationRequest(api, "structural", expectedManifest);
    expectValidationRequest(api, "runnable", expectedManifest);
    expectValidationRequest(api, "structural", expectedManifest);
    await author.getByRole("button", { name: "Validate structure" }).press("Enter");
    await expect(author.getByText("Structural validation passed.", { exact: true })).toBeVisible();
    await author.getByRole("button", { name: "Check runnable diagnostics" }).press("Enter");
    await expect(author.getByText("Runnable diagnostics passed.", { exact: true })).toBeVisible();

    const downloadEvent = page.waitForEvent("download");
    await author.getByRole("button", { name: "Export courseweave.json" }).press("Enter");
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("courseweave.json");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const exported = await readFile(downloadPath!, "utf8");

    await author.getByRole("button", { name: "Save course" }).press("Enter");
    await expect(author.getByText("Saved exact canonical course bytes.", { exact: true })).toBeVisible();
    expect(exported).toBe(api.raw);
    expect(api.counts.puts).toBe(1);
    expect(api.mutations).toHaveLength(1);

    const savedModules = api.manifest.modules as Array<Record<string, unknown>>;
    expect(api.manifest.entry_module_id).toBe("browser-added");
    expect(api.manifest).toEqual(expectedManifest);
    if (example === "minimal-course") {
      expect(savedModules.map((module) => module.id)).toEqual(["start-copy", "browser-added"]);
      const copiedPhases = savedModules[0]!.phases as Array<Record<string, unknown>>;
      expect(copiedPhases.map((phase) => phase.id)).toEqual(["read-copy"]);
      expect(copiedPhases[0]!.title).toBe("Read the lesson edited in browser");
      expect((copiedPhases[0]!.surfaces as Array<Record<string, unknown>>)).toEqual([
        { id: "lesson-copy", type: "markdown", role: "primary", path: "lesson.md" },
      ]);
    } else {
      expect(savedModules.map((module) => module.id)).toEqual(["cli-copy", "browser-added"]);
      const copiedPhases = savedModules[0]!.phases as Array<Record<string, unknown>>;
      expect(copiedPhases.map((phase) => phase.id)).toEqual(["read-copy", "run-copy"]);
      expect(copiedPhases[0]!.title).toBe("Read the CLI lesson edited in browser");
      expect(copiedPhases[1]!.completion).toEqual({ type: "artifact_exists", record_id: "cli-note", path: "notes/cli-result.md" });
      expect((copiedPhases[1]!.surfaces as Array<Record<string, unknown>>)).toEqual([
        { id: "show-help-copy", type: "terminal", role: "exercise", label: "Show CourseWeave help", argv: ["courseweave", "--help"], cwd: "." },
      ]);
    }
    expect(savedModules[1]).toMatchObject({
      id: "browser-added",
      title: "Browser added",
      phases: [{ id: "phase", title: "New phase", surfaces: [{ id: "surface", type: "markdown", path: "content.md" }] }],
    });

    await reloadAuthor(page, author, api);
    await expect(author.getByLabel("Entry module")).toHaveValue(/.+/);
    await expect(author.getByLabel("Entry module").locator("option:checked")).toHaveText("Browser added");
    await expect(author.getByRole("button", { name: "Select module Browser added" })).toBeVisible();
    expect(api.counts).toMatchObject({
      courseGets: 2,
      proposalGets: 2,
      structuralValidations: 2,
      runnableValidations: 1,
      puts: 1,
      guides: 0,
      candidates: 0,
      edits: 0,
      accepts: 0,
      rejects: 0,
    });
    expect(api.validationRequests).toEqual([
      { manifest: expectedManifest, mode: "structural" },
      { manifest: expectedManifest, mode: "runnable" },
      { manifest: expectedManifest, mode: "structural" },
    ]);
    await expectNoBoundaryViolations(page, api);
  });
}

test("saves one exact manifest after keyboard-returning from an entity edit to Course fields", async ({ page }) => {
  const source = loadExample("minimal-course");
  const expected = structuredClone(source);
  expected.title = "Integrated browser course";
  (expected.policies as Record<string, unknown>).max_shared_chars = 4096;
  const expectedPhase = ((expected.modules as Array<Record<string, unknown>>)[0]!.phases as Array<Record<string, unknown>>)[0]!;
  expectedPhase.title = "Integrated entity edit";
  const api = createAuthorApi(source);
  const author = await mountAuthor(page, api);

  await author.getByRole("button", { name: "Select phase Read the lesson" }).press("Enter");
  const phaseTitle = author.getByLabel("Phase title");
  await phaseTitle.fill("Integrated entity edit");
  const courseSelection = author.getByRole("button", { name: "Select course Minimal Course" });
  expect(await tabTo(page, courseSelection, "reverse")).toBeGreaterThan(0);
  await expect(courseSelection).toBeFocused();
  await expect(courseSelection).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expect(courseSelection).toHaveAttribute("aria-pressed", "true");

  await author.getByLabel("Course title").fill("Integrated browser course");
  await author.getByLabel("Max shared characters").fill("4096");
  expectValidationRequest(api, "structural", expected);
  await author.getByRole("button", { name: "Save course" }).press("Enter");
  await expect(author.getByText("Saved exact canonical course bytes.", { exact: true })).toBeVisible();

  expect(api.counts.puts).toBe(1);
  expect(api.putRequests).toEqual([expected]);
  expect(api.manifest).toEqual(expected);
  expect(api.mutations).toHaveLength(1);
  expect(api.mutations[0]).toMatch(/^put:/);
  expect(api.validationRequests).toEqual([{ manifest: expected, mode: "structural" }]);

  await reloadAuthor(page, author, api);
  await expect(author.getByLabel("Course title")).toHaveValue("Integrated browser course");
  await expect(author.getByLabel("Max shared characters")).toHaveValue("4096");
  await expect(author.getByRole("button", { name: "Select course Integrated browser course" })).toHaveAttribute("aria-pressed", "true");
  await author.getByRole("button", { name: "Select phase Integrated entity edit" }).press("Enter");
  await expect(author.getByLabel("Phase title")).toHaveValue("Integrated entity edit");
  expect(api.counts).toMatchObject({ courseGets: 2, proposalGets: 2, structuralValidations: 1, puts: 1 });
  await expectNoBoundaryViolations(page, api);
});

test("denies an asset-shaped request that is absent from the production index", async ({ page }) => {
  const api = createAuthorApi(minimalManifest());
  await mountAuthor(page, api);

  const outcome = await page.evaluate(async () => {
    try {
      await fetch("/author/assets/unexpected-artifact.js");
      return "resolved";
    } catch {
      return "rejected";
    }
  });

  expect(outcome).toBe("rejected");
  expect(api.violations).toEqual([
    "unhandled-network:GET:http://127.0.0.1:4174/author/assets/unexpected-artifact.js",
  ]);
});

test("denies an extra exact runtime request without sending the capability reply", async ({ page }) => {
  const api = createAuthorApi(minimalManifest());
  const author = await mountAuthor(page, api);
  await author.locator("body").evaluate(() => {
    document.documentElement.dataset.probeRuntimeReplies = "0";
    window.addEventListener("message", (event) => {
      if (event.data?.type === "courseweave.runtime.v1") {
        document.documentElement.dataset.probeRuntimeReplies = String(
          Number(document.documentElement.dataset.probeRuntimeReplies ?? "0") + 1,
        );
      }
    });
    window.parent.postMessage({ type: "courseweave.runtime.request.v1" }, window.location.origin);
  });

  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.runtimeRequests)).toBe("1");
  await expect.poll(() => author.locator("html").getAttribute("data-probe-runtime-replies")).toBe("0");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.unexpectedAuthorMessages)).toBe("1");
});

test("records the exact live draft and mode for each validation request", async ({ page }) => {
  const original = minimalManifest();
  const expected = structuredClone(original);
  expected.title = "Live browser draft";
  const api = createAuthorApi(original);
  expectValidationRequest(api, "structural", expected);
  expectValidationRequest(api, "runnable", expected);
  const author = await mountAuthor(page, api);

  await author.getByLabel("Course title").fill("Live browser draft");
  await author.getByRole("button", { name: "Validate structure" }).press("Enter");
  await author.getByRole("button", { name: "Check runnable diagnostics" }).press("Enter");

  expect(api.validationRequests).toEqual([
    { manifest: expected, mode: "structural" },
    { manifest: expected, mode: "runnable" },
  ]);
  await expectNoBoundaryViolations(page, api);
});

test("records the exact one-message guide body and stable request identity", async ({ page }) => {
  const api = createAuthorApi(minimalManifest());
  expectGuideRequest(api, "Inspect this exact composer text");
  const author = await mountAuthor(page, api);

  await author.getByLabel("Ask the curriculum teacher").fill("Inspect this exact composer text");
  await author.getByRole("button", { name: "Ask teacher" }).press("Enter");
  await expect(author.getByText("Local fixture advice", { exact: true })).toBeVisible();

  const requests = api.guideRequests;
  expect(requests).toHaveLength(1);
  expect(requests?.[0]).toEqual({
    threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    messages: [{
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      role: "user",
      content: "Inspect this exact composer text",
    }],
    tools: [],
    context: [],
    forwardedProps: { source_id: "browser-author-source" },
  });
  await expectNoBoundaryViolations(page, api);
});

test("denies a duplicate proposal validation after its one expectation is consumed", async ({ page }) => {
  const manifest = minimalManifest();
  const api = proposalFixture(manifest);
  expectValidationRequest(api, "structural", manifest);
  await mountAuthor(page, api);
  await expectValidationCompletion(api);
  expect(api.validationRequests).toEqual([{ manifest, mode: "structural" }]);

  const outcome = await page.evaluate(async (body) => {
    try {
      await fetch("/api/author/validate", {
        method: "POST",
        headers: {
          Authorization: "Bearer browser-test-capability",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return "resolved";
    } catch {
      return "rejected";
    }
  }, { manifest, mode: "structural" });

  expect(outcome).toBe("rejected");
  expect(api.validationRequests).toEqual([{ manifest, mode: "structural" }]);
  expect(api.violations).toEqual([
    `validate-contract:${JSON.stringify({ manifest, mode: "structural" })}`,
  ]);
});

test("traverses the Author regions and decides a proposal using only sequential keyboard input", async ({ page }) => {
  const manifest = minimalManifest();
  const api = proposalFixture(manifest);
  queueStructuralValidations(api, manifest);
  const author = await mountAuthor(page, api);
  const addModule = author.getByRole("button", { name: "Add module" });
  const selectModule = author.getByRole("button", { name: "Select module Start" });
  const moduleId = author.getByLabel("Module ID");
  const teacherComposer = author.getByLabel("Ask the curriculum teacher");
  const proposalEditor = author.getByLabel("Edit full manifest");
  const accept = author.getByRole("button", { name: "Accept" });
  const reject = author.getByRole("button", { name: "Reject" });

  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  expect(await tabTo(page, addModule)).toBeGreaterThan(0);
  expect(await tabTo(page, selectModule)).toBe(1);
  queueStructuralValidations(api, manifest);
  await page.keyboard.press("Space");
  await expect(selectModule).toHaveAttribute("aria-pressed", "true");

  expect(await tabTo(page, moduleId)).toBeGreaterThan(0);
  expect(await tabTo(page, teacherComposer)).toBeGreaterThan(0);
  expect(await tabTo(page, proposalEditor)).toBeGreaterThan(0);
  expect(await tabTo(page, accept)).toBe(1);
  expect(await tabTo(page, reject)).toBe(1);

  const logicalRegions = await author.locator("body").evaluate(() => {
    const names = ["Outline", "Inspector", "Preview", "Curriculum teacher", "Proposal review"];
    const elements = names.map((name) => document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!);
    return {
      names,
      inOrder: elements.every((element, index) => index === elements.length - 1 ||
        Boolean(element.compareDocumentPosition(elements[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING)),
      previewTabStops: elements[2]!.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])").length,
    };
  });
  expect(logicalRegions).toEqual({
    names: ["Outline", "Inspector", "Preview", "Curriculum teacher", "Proposal review"],
    inOrder: true,
    previewTabStops: 0,
  });

  queueStructuralValidations(api, manifest, manifest);
  await page.keyboard.press("Enter");
  const reviewedHeading = author.getByRole("heading", { name: "Review the browser proposal" });
  await expect(reviewedHeading).toBeFocused();
  await expect(author.getByText("Status: rejected")).toBeVisible();
  expect(api.counts.rejects).toBe(1);

  expect(await tabTo(page, teacherComposer, "reverse")).toBeGreaterThan(0);
  await expect(teacherComposer).toBeFocused();
  expect(api.validationRequests).toEqual(structuralValidationRequests(
    manifest,
    manifest,
    manifest,
    manifest,
  ));
  await expectNoBoundaryViolations(page, api);
});

test("creates the first manifest only after repairing an incomplete missing-root draft", async ({ page }) => {
  const api = createAuthorApi(emptyManifest(), { exists: false });
  const author = await mountAuthor(page, api);
  expect(api.etag).toBe('""');
  expect(api.counts.puts).toBe(0);

  await author.getByRole("button", { name: "Add module" }).press("Enter");
  await author.getByLabel("New module ID").fill("first-module");
  await author.getByLabel("New module title").fill("First module");
  await author.getByRole("button", { name: "Create module" }).press("Enter");
  await expect(author.getByRole("button", { name: "Select module First module" })).toBeFocused();
  await author.getByRole("button", { name: "Select phase New phase" }).press("Enter");
  const phaseTitle = author.getByLabel("Phase title");
  await phaseTitle.fill("");
  expectValidationRequest(api, "structural", expectedFirstManifest(""));
  await author.getByRole("button", { name: "Validate structure" }).press("Enter");
  await expect(author.getByText("Structural validation found issues.", { exact: true })).toBeVisible();
  await expect(phaseTitle).toHaveValue("");
  await author.getByRole("button", { name: "Focus first issue" }).press("Enter");
  await expect(phaseTitle).toBeFocused();
  await expect(phaseTitle).toHaveAttribute("aria-describedby", /author-issue-/);
  expect(api.counts.puts).toBe(0);

  await phaseTitle.fill("Recovered phase");
  expectValidationRequest(api, "structural", expectedFirstManifest("Recovered phase"));
  await author.getByRole("button", { name: "Save course" }).press("Enter");
  await expect(author.getByText("Saved exact canonical course bytes.", { exact: true })).toBeVisible();
  expect(api.counts.structuralValidations).toBe(2);
  expect(api.counts.puts).toBe(1);
  expect(api.mutations).toHaveLength(1);
  expect(api.etag).toMatch(/^"[a-f0-9]{64}"$/);
  expect(api.manifest.entry_module_id).toBe("first-module");
  expect(((api.manifest.modules as Array<Record<string, unknown>>)[0]!.phases as Array<Record<string, unknown>>)[0]!.title).toBe("Recovered phase");
  expect(api.validationRequests).toEqual([
    { manifest: expectedFirstManifest(""), mode: "structural" },
    { manifest: expectedFirstManifest("Recovered phase"), mode: "structural" },
  ]);
  await expectNoBoundaryViolations(page, api);
});

test("retains the draft after failed import and keeps CRUD usable without a provider", async ({ page }) => {
  const api = createAuthorApi(minimalManifest(), { providerNotConfigured: true });
  expectGuideRequest(api, "Review the saved course");
  const author = await mountAuthor(page, api);
  const file = author.getByLabel("Import course file");
  await file.focus();
  await file.setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not valid json", "utf8"),
  });

  await expect(author.getByText("Import file is not valid JSON.", { exact: true })).toBeVisible();
  await expect(author.getByLabel("Course title")).toHaveValue("Minimal Course");
  await expect(file).toBeFocused();
  expect(api.counts.structuralValidations).toBe(0);
  expect(api.counts.puts).toBe(0);

  await author.getByLabel("Ask the curriculum teacher").fill("Review the saved course");
  await author.getByRole("button", { name: "Ask teacher" }).press("Enter");
  await expect(author.getByText("Teacher unavailable", { exact: true })).toBeVisible();
  expect(api.counts.guides).toBe(1);

  await author.getByRole("button", { name: "Add module" }).press("Enter");
  await author.getByLabel("New module ID").fill("offline-module");
  await author.getByLabel("New module title").fill("Offline module");
  await author.getByRole("button", { name: "Create module" }).press("Enter");
  await expect(author.getByRole("button", { name: "Select module Offline module" })).toBeFocused();
  await expect(author.getByText("Teacher provider unavailable. Editing and preview remain available.", { exact: true })).toBeVisible();
  expect(api.counts.puts).toBe(0);
  await expectNoBoundaryViolations(page, api);
});

test("rejects byte-identical fake-model output and accepts one edited revision exactly once", async ({ page }) => {
  const original = minimalManifest();
  const suggested = structuredClone(original);
  suggested.title = "Unedited fake-model title";
  const api = createAuthorApi(original);
  expectGuideRequest(api, "Suggest no change", original);
  expectGuideRequest(api, "Suggest a real change", suggested);
  const originalRaw = api.raw;
  const author = await mountAuthor(page, api);

  await author.getByLabel("Ask the curriculum teacher").fill("Suggest no change");
  await author.getByRole("button", { name: "Ask teacher" }).press("Enter");
  await expect(author.getByText("Local fixture advice", { exact: true })).toBeVisible();
  queueStructuralValidations(api, original, original);
  await author.getByRole("button", { name: "Save suggested change" }).press("Enter");
  const first = author.getByRole("article").filter({ hasText: "Status: pending" });
  await expect(first).toHaveCount(1);
  const reject = first.getByRole("button", { name: "Reject" });
  await reject.focus();
  queueStructuralValidations(api, original, original);
  await reject.press("Enter");
  await expect(author.getByRole("article").filter({ hasText: "Status: rejected" })).toHaveCount(1);
  expect(api.raw).toBe(originalRaw);
  expect(api.counts.rejects).toBe(1);

  await author.getByLabel("Ask the curriculum teacher").fill("Suggest a real change");
  await author.getByRole("button", { name: "Ask teacher" }).press("Enter");
  queueStructuralValidations(api, original, suggested, original, suggested);
  await author.getByRole("button", { name: "Save suggested change" }).press("Enter");
  let pending = author.getByRole("article").filter({ hasText: "Status: pending" });
  await expect(pending).toHaveCount(1);
  const edited = structuredClone(suggested);
  edited.title = "Accepted edited browser title";
  await pending.getByLabel("Edit full manifest").fill(JSON.stringify(edited, null, 2));
  queueStructuralValidations(api, edited, original, edited, original, edited);
  await pending.getByRole("button", { name: "Save proposal edit" }).press("Enter");

  pending = author.getByRole("article").filter({ hasText: "Status: pending" });
  await expect(pending.getByText("Pending revision: 2", { exact: true })).toBeVisible();
  await expect(pending.getByLabel("Edit full manifest")).toHaveValue(JSON.stringify(edited, null, 2));
  queueStructuralValidations(api, original, edited, original, edited, original, edited);
  await pending.getByRole("button", { name: "Accept" }).press("Enter");

  await expect(author.getByRole("article").filter({ hasText: "Status: accepted" })).toHaveCount(1);
  expect(api.manifest.title).toBe("Accepted edited browser title");
  expect(api.counts).toMatchObject({ guides: 2, candidates: 2, edits: 1, accepts: 1, rejects: 1, puts: 0 });
  expect(api.mutations.map((mutation) => mutation.split(":")[0])).toEqual([
    "candidate", "reject", "candidate", "edit", "accept",
  ]);
  expect(api.guideRequests.map((request) => ({
    threadId: request.threadId,
    content: request.messages[0].content,
    role: request.messages[0].role,
    tools: request.tools,
    context: request.context,
    source: request.forwardedProps.source_id,
  }))).toEqual([
    { threadId: api.guideThreadId, content: "Suggest no change", role: "user", tools: [], context: [], source: "browser-author-source" },
    { threadId: api.guideThreadId, content: "Suggest a real change", role: "user", tools: [], context: [], source: "browser-author-source" },
  ]);
  expect(new Set(api.guideRequests.map((request) => request.runId)).size).toBe(2);
  expect(new Set(api.guideRequests.map((request) => request.messages[0].id)).size).toBe(2);
  await expectValidationCompletion(api);
  expect(api.validationRequests).toEqual(structuralValidationRequests(
    original, original,
    original, original,
    original, suggested, original, suggested,
    edited, original, edited, original, edited,
    original, edited, original, edited, original, edited,
  ));
  await expectNoBoundaryViolations(page, api);
});

test("renders hostile imported fields as inert text without fetch, navigation, messages, or execution", async ({ page }) => {
  const api = createAuthorApi(minimalManifest(), { validationIssue: () => [] });
  const author = await mountAuthor(page, api);
  const hostile = structuredClone(minimalManifest());
  hostile.title = '<img src="https://outside.example/x" onerror="window.__courseweaveScript=true">';
  const module = (hostile.modules as Array<Record<string, unknown>>)[0]!;
  module.title = "<script>window.__courseweaveScript=true</script>";
  const phase = (module.phases as Array<Record<string, unknown>>)[0]!;
  phase.title = "<svg onload=window.__courseweaveScript=true>Imported phase</svg>";
  phase.surfaces = [
    { id: "http-path", type: "markdown", role: "primary", path: "http://outside.example/artifact" },
    { id: "data-video", type: "video", role: "reference", url: "data:text/html,<script>window.__courseweaveScript=true</script>" },
    { id: "javascript-link", type: "external", role: "reference", url: "javascript:window.__courseweaveScript=true" },
    { id: "file-video", type: "video", role: "reference", path: "file:///tmp/private-video" },
    { id: "terminal", type: "terminal", role: "exercise", label: "Never execute", argv: ["sh", "-c", "window.__terminalExecuted=true"], cwd: "." },
  ];

  expectValidationRequest(api, "structural", hostile);
  const file = author.getByLabel("Import course file");
  await file.setInputFiles({ name: "hostile.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(hostile), "utf8") });
  await expect(author.getByText("Imported into the local draft. Save explicitly to write it.", { exact: true })).toBeVisible();
  await expect(author.getByLabel("Course title")).toHaveValue(hostile.title as string);
  await author.getByRole("button", { name: `Select phase ${phase.title as string}` }).press("Enter");
  await expect(author.getByText(phase.title as string, { exact: true })).toBeVisible();
  for (const value of [
    "http://outside.example/artifact",
    "data:text/html,<script>window.__courseweaveScript=true</script>",
    "javascript:window.__courseweaveScript=true",
    "file:///tmp/private-video",
  ]) {
    await expect(author.getByText(value, { exact: true })).toBeVisible();
  }
  await author.getByRole("button", { name: "Select surface terminal" }).press("Enter");
  await expect(author.getByLabel("Argument 3")).toHaveValue("window.__terminalExecuted=true");
  expect(await author.locator("body").evaluate(() => ({
    script: (window as typeof window & { __courseweaveScript?: boolean }).__courseweaveScript,
    terminal: (window as typeof window & { __terminalExecuted?: boolean }).__terminalExecuted,
    location: window.location.href,
    scripts: document.querySelectorAll("script").length,
  }))).toEqual({ script: undefined, terminal: undefined, location: "http://127.0.0.1:4174/author/", scripts: 1 });
  expect(api.counts.puts).toBe(0);
  expect(api.mutations).toEqual([]);
  expect(api.runtimeHandshakeCount).toBe(1);
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.dataset.runtimeRequests))).toBe(1);
  await expectNoBoundaryViolations(page, api);
});

test("keeps the four-region experience accessible and contained at 320 CSS pixels", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const manifest = loadExample("cli-course");
  const module = (manifest.modules as Array<Record<string, unknown>>)[0]!;
  const phases = module.phases as Array<Record<string, unknown>>;
  const terminal = (phases[1]!.surfaces as Array<Record<string, unknown>>)[0]!;
  terminal.argv = ["courseweave", "--argument", "x".repeat(600)];
  terminal.cwd = `nested/${"long-path/".repeat(80)}end`;
  const proposed = structuredClone(manifest);
  proposed.description = "Long proposal ".repeat(120);
  const api = createAuthorApi(manifest);
  seedProposal(api, proposed, "narrow-proposal", "Narrow proposal");
  queueStructuralValidations(api, proposed);
  const author = await mountAuthor(page, api, { width: 320 });
  queueStructuralValidations(api, proposed);
  await author.getByRole("button", { name: "Select surface show-help" }).press("Enter");

  const layout = await author.locator("body").evaluate(() => {
    const named = ["Outline", "Inspector", "Preview", "Curriculum teacher"];
    const regions = named.map((name) => {
      const element = document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
      const rect = element.getBoundingClientRect();
      return { name, left: rect.left, top: rect.top, right: rect.right, width: rect.width };
    });
    const pre = document.querySelector("pre")!;
    const preStyle = getComputedStyle(pre);
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      regions,
      preOverflowX: preStyle.overflowX,
      preWidth: pre.getBoundingClientRect().width,
      preParentWidth: pre.parentElement!.getBoundingClientRect().width,
      moving: Array.from(document.querySelectorAll<HTMLElement>("*")).filter((element) => {
        const style = getComputedStyle(element);
        return style.animationDuration !== "0s" || style.transitionDuration !== "0s";
      }).length,
    };
  });
  expect(layout.clientWidth).toBe(320);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.regions.map((region) => region.name)).toEqual(["Outline", "Inspector", "Preview", "Curriculum teacher"]);
  for (const region of layout.regions) {
    expect(region.left).toBeGreaterThanOrEqual(0);
    expect(region.right).toBeLessThanOrEqual(320);
  }
  expect(layout.regions[0]!.top).toBeLessThan(layout.regions[1]!.top);
  expect(layout.regions[1]!.top).toBeLessThan(layout.regions[2]!.top);
  expect(layout.regions[2]!.top).toBeLessThan(layout.regions[3]!.top);
  expect(layout.preOverflowX).toBe("auto");
  expect(layout.preWidth).toBeLessThanOrEqual(layout.preParentWidth);
  expect(layout.moving).toBe(0);

  const move = author.getByRole("button", { name: "Move surface show-help up" });
  await move.focus();
  const focusIndicator = await move.evaluate((element) => {
    const style = getComputedStyle(element);
    const rgb = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (value: number[]) => value.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    const foreground = luminance(rgb(style.outlineColor));
    const background = luminance(rgb(style.backgroundColor));
    return {
      contrast: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focusIndicator.contrast).toBeGreaterThanOrEqual(3);
  expect(focusIndicator.outlineStyle).toBe("solid");
  expect(focusIndicator.outlineWidth).toBeGreaterThanOrEqual(2);
  queueStructuralValidations(api, proposed);
  await move.press("Enter");
  await expect(author.getByRole("button", { name: "Select surface show-help" })).toBeFocused();
  await expect(author.getByRole("status").filter({ hasText: "Moved surface show-help up." })).toBeVisible();

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const selectedSurface = author.getByRole("button", { name: "Select surface show-help" });
  const forced = await selectedSurface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
  expect(forced.outlineStyle).toBe("solid");
  expect(forced.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(api.validationRequests).toEqual(structuralValidationRequests(proposed, proposed, proposed));
  await expectNoBoundaryViolations(page, api);
});

test("restores keyboard focus inside proposal review after a decision", async ({ page }) => {
  const manifest = minimalManifest();
  const api = proposalFixture(manifest);
  queueStructuralValidations(api, manifest);
  const author = await mountAuthor(page, api);
  const reject = author.getByRole("button", { name: "Reject" });

  await reject.focus();
  await expect(reject).toBeFocused();
  queueStructuralValidations(api, manifest, manifest);
  await reject.press("Enter");

  await expect(author.getByText("Status: rejected")).toBeVisible();
  await expect.poll(() => api.counts.rejects).toBe(1);
  const focus = await author.locator("body").evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? null,
      inProposalReview:
        element?.closest('[aria-label="Proposal review"]') !== null,
    };
  });
  expect(focus, "focus must be restored to a stable target in Proposal review").toMatchObject({
    inProposalReview: true,
  });
  expect(api.validationRequests).toEqual(structuralValidationRequests(manifest, manifest, manifest));
  expect(api.violations).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.dataset.unexpectedAuthorMessages,
      ),
    )
    .toBe("0");
});

test("restores focus to the separate Save after keeping a stale local draft", async ({ page }) => {
  const initial = minimalManifest();
  const api = createAuthorApi(initial);
  const remote = structuredClone(initial);
  remote.title = "Remote course title";
  api.staleRemote = remote;
  const local = structuredClone(initial);
  local.title = "Local unsaved title";
  expectValidationRequest(api, "structural", local);
  const author = await mountAuthor(page, api);

  await author.getByLabel("Course title").fill("Local unsaved title");
  await author.getByRole("button", { name: "Save course" }).press("Enter");

  await expect(author.getByRole("alert", { name: "Remote conflict" })).toBeVisible();
  await expect(author.getByLabel("Course title")).toHaveValue("Local unsaved title");
  expect(api.counts.puts).toBe(1);
  const keep = author.getByRole("button", { name: "Keep my draft after review" });
  await keep.focus();
  await keep.press("Enter");

  await expect(author.getByRole("alert", { name: "Remote conflict" })).toHaveCount(0);
  await expect(author.getByLabel("Course title")).toHaveValue("Local unsaved title");
  await expect(
    author.getByRole("button", { name: "Save course" }),
    "manual conflict review must restore focus to the required separate Save",
  ).toBeFocused();
  expect(api.counts.puts).toBe(1);
  expect(api.validationRequests).toEqual([{ manifest: local, mode: "structural" }]);
  await expectNoBoundaryViolations(page, api);
});
