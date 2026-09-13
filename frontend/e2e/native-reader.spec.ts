import { expect, test } from "playwright/test";
import { build } from "vite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("production native surface factory intercepts approved lesson links and preserves the actual Lumino session iframe", async ({
  page,
}, testInfo) => {
  const output = testInfo.outputPath("harness");
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: output,
      emptyOutDir: true,
      lib: {
        entry: fileURLToPath(
          new URL("./native-reader-harness.ts", import.meta.url),
        ),
        formats: ["es"],
        fileName: () => "harness.js",
      },
    },
  });
  const bundle = await readFile(`${output}/harness.js`, "utf8");
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/native-harness")
      return route.fulfill({
        contentType: "text/html",
        body: '<title>Native reader proof</title><pre id="events"></pre><script type="module" src="/native-harness.js"></script>',
      });
    if (path === "/native-harness.js")
      return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (path === "/native-session")
      return route.fulfill({
        contentType: "text/html",
        body: '<textarea aria-label="Session draft"></textarea>',
      });
    if (path === "/courseweave/reader/lessons/one.html")
      return route.fulfill({
        contentType: "text/html",
        body: '<h1>Loop lesson</h1><script>window.unsafeScriptRan=true</script><a href="#self-check">Go to self-check</a> <a href="../notebooks/lab.ipynb">Open notebook practice</a> <a href="next.html">Read next lesson</a> <a href="../shared.md">Shared document</a> <a href="../private.txt">Unlisted path</a> <a href="https://source.example.test/paper">Source citation</a><svg aria-label="Loop diagram" width="300" height="100"><rect width="80" height="50" fill="#cde"/><text x="5" y="30">Model</text><path d="M80 25H150" stroke="#123"/><text x="155" y="30">Tool result</text></svg><h2 id="self-check">Self-check section</h2>',
      });
    if (path === "/courseweave/reader/lessons/next.html")
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>The next lesson</h1>",
      });
    throw new Error(`Unexpected navigation: ${route.request().url()}`);
  });
  await page.goto("/native-harness");
  const reader = page.frameLocator('iframe[title="CourseWeave reader"]');
  await expect(
    reader.getByRole("heading", { name: "Loop lesson" }),
  ).toBeVisible();
  expect(
    await reader
      .locator("body")
      .evaluate(() => (window as any).unsafeScriptRan),
  ).toBeUndefined();
  await expect(reader.getByLabel("Loop diagram")).toBeVisible();
  await expect(page.locator("#courseweave-reader")).toBeFocused();
  await reader.getByRole("link", { name: "Go to self-check" }).click();
  await expect
    .poll(() => page.locator("#events").textContent())
    .toContain('"phaseId":"check"');
  await expect(
    page.locator('iframe[title="CourseWeave reader"]'),
  ).toHaveAttribute("src", /one.html#self-check$/);
  await reader.getByRole("link", { name: "Open notebook practice" }).click();
  await expect(
    page.getByText("Native Notebook: notebooks/lab.ipynb", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.locator("#events").textContent())
    .toContain('"explicitPhaseId":"practice"');
  await page.evaluate(() => (window as any).nativeHarness.openRead());
  await reader.getByRole("link", { name: "Unlisted path" }).click();
  await expect(page.getByRole("status")).toContainText("not listed");
  await reader.getByRole("link", { name: "Shared document" }).click();
  await expect(
    page.getByRole("button", { name: "First use of shared document" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Second use of shared document" }),
  ).toBeVisible();
  await reader.getByRole("link", { name: "Source citation" }).click();
  await expect
    .poll(() => page.locator("#events").textContent())
    .toContain("https://source.example.test/paper");
  await reader.getByRole("link", { name: "Read next lesson" }).click();
  await expect(
    reader.getByRole("heading", { name: "The next lesson" }),
  ).toBeVisible();
  await expect
    .poll(() => page.locator("#events").textContent())
    .toContain('"explicitPhaseId":"next"');
  const session = page.frameLocator('iframe[title="Retained guide"]');
  await session.getByLabel("Session draft").fill("Keep this draft and session");
  expect(
    await page.evaluate(() => {
      const harness = (window as any).nativeHarness;
      harness.originalWindow = harness.frame.contentWindow;
      harness.guide.close();
      return (
        harness.guide.isHidden &&
        !harness.guide.isDisposed &&
        harness.frame.isConnected
      );
    }),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).nativeHarness.guide.show();
  });
  await expect(session.getByLabel("Session draft")).toHaveValue(
    "Keep this draft and session",
  );
  expect(
    await page.evaluate(() => {
      const h = (window as any).nativeHarness;
      return h.originalWindow === h.frame.contentWindow;
    }),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("native-reader.png") });
  await page.evaluate(() => {
    (window as any).nativeHarness.guide.dispose();
  });
  await expect(page.locator('iframe[title="Retained guide"]')).toHaveCount(0);
});
