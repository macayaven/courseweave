import { expect, type FrameLocator, type Page } from "playwright/test";

import {
  course as makeCourse,
  phase,
  state as makeState,
} from "../apps/learn/test/fixtures";

export const course = makeCourse({
  title: "Browser Course",
  entry_module_id: "module-b",
  modules: [
    {
      id: "module-b",
      title: "Second module",
      description: "",
      phases: [
        phase({
          id: "read-b",
          title: "Second reading",
          surfaces: [
            {
              id: "html-lesson",
              type: "html",
              purpose: "primary",
              path: "lessons/second.html",
              label: "Second lesson",
            },
            {
              id: "video-lesson",
              type: "video",
              purpose: "reference",
              src: "https://video.example.test/second.mp4",
              label: "Second video",
            },
          ],
        }),
      ],
    },
    {
      id: "module-a",
      title: "First module",
      description: "",
      phases: [phase({ id: "read-a", title: "First reading", surfaces: [] })],
    },
  ],
});

export function learnerState() {
  return makeState({
    time_budget_minutes: 25,
    progress: {
      required_total: 2,
      required_complete: 0,
      phases: [],
      records: [],
    },
    teacher_availability: {
      "module-b/read-b": {
        mode: "disabled",
        provider_callable: false,
        unmet_requirement_ids: [],
        guidance: phase().teacher.guidance,
        allowed_share_kinds: [],
        allowed_proposal_types: [],
        max_shared_chars: 8192,
      },
    },
  });
}

export type MockApi = {
  active: boolean;
  state?: ReturnType<typeof makeState>;
  moduleId?: string;
  phaseId?: string;
  surfaceId?: string | null;
  course?: unknown;
  proposals?: unknown;
  authenticatedRequests: number;
  unhandledRequests?: number;
};
const serviceOrigin = "http://127.0.0.1:4173";
const expectedAuthorization = "Bearer browser-test-capability";

export async function mountLearner(
  page: Page,
  api: MockApi,
): Promise<FrameLocator> {
  await page.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === serviceOrigin &&
      (url.pathname === "/learn/" || url.pathname.startsWith("/learn/assets/"))
    )
      return route.continue();
    api.unhandledRequests = (api.unhandledRequests ?? 0) + 1;
    return route.abort();
  });
  await page.route("**/api/**", async (route) => {
    const authorization = route.request().headers().authorization;
    const url = new URL(route.request().url());
    if (url.origin !== serviceOrigin || authorization !== expectedAuthorization)
      throw new Error("Unexpected authenticated request.");
    api.authenticatedRequests += 1;
    const body =
      route.request().method() === "GET" &&
      url.pathname === "/api/bootstrap" &&
      url.search === ""
        ? { ...(api.state ?? learnerState()), manifest: api.course ?? course }
        : route.request().method() === "GET" &&
            url.pathname === "/api/course" &&
            url.search === ""
          ? (api.course ?? course)
          : route.request().method() === "GET" &&
              url.pathname === "/api/state" &&
              url.search === ""
            ? (api.state ?? learnerState())
            : route.request().method() === "GET" &&
                url.pathname === "/api/proposals" &&
                url.search === ""
              ? (api.proposals ?? [])
              : route.request().method() === "GET" &&
                  url.pathname === "/api/context" &&
                  url.search === "?source_id=browser-source"
                ? {
                    context: { source_id: "browser-source" },
                    resolved: api.active
                      ? {
                          module_id: api.moduleId ?? "module-b",
                          phase_id: api.phaseId ?? "read-b",
                          surface_id: api.surfaceId ?? "html-lesson",
                          reason: "test",
                        }
                      : {
                          module_id: null,
                          phase_id: null,
                          surface_id: null,
                          reason: "none",
                        },
                  }
                : null;
    if (body === null) throw new Error("Unexpected API contract.");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await page.route(`${serviceOrigin}/courseweave/reader/lessons/second.html`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Lesson</h1>" }),
  );
  await page.route("https://video.example.test/second.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: "" }),
  );
  await page.goto("/learn/");
  await page.evaluate(() => {
    document.body.replaceChildren();
    const frame = document.createElement("iframe");
    frame.id = "learn-frame";
    frame.title = "CourseWeave Learn host";
    frame.style.width = "320px";
    frame.style.border = "0";
    document.body.style.margin = "0";
    frame.style.height = "600px";
    frame.referrerPolicy = "origin";
    frame.src = "/learn/";
    window.addEventListener("message", (event) => {
      const data = event.data as Record<string, unknown>;
      if (
        data?.type === "courseweave.runtime.request.v1" &&
        event.source !== window
      ) {
        document.documentElement.dataset.courseweaveRuntimeRequested = "true";
        return;
      }
      if (
        data?.type !== "courseweave.open-surface.v1" ||
        event.source === window
      )
        return;
      window.dispatchEvent(
        new CustomEvent("courseweave-test-navigation", { detail: data }),
      );
      if (document.documentElement.dataset.deferReaderOutcome === "true")
        return;
      const htmlSource =
        data.surfaceId === "html-lesson"
          ? `${window.location.origin}/courseweave/reader/lessons/second.html`
          : data.surfaceId === "video-lesson"
            ? "https://video.example.test/second.mp4"
            : null;
      (event.source as Window).postMessage(
        {
          type: "courseweave.reader.opened.v1",
          sourceId: "browser-source",
          moduleId: data.moduleId,
          phaseId: data.phaseId,
          surfaceId: data.surfaceId,
          jupyterBaseUrl: `${window.location.origin}/`,
          htmlSource,
        },
        window.location.origin,
      );
    });
    document.body.append(frame);
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () => document.querySelector("#learn-frame")?.contentWindow !== null,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.dataset.courseweaveRuntimeRequested ===
          "true",
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#learn-frame");
    frame?.contentWindow?.postMessage(
      {
        type: "courseweave.runtime.v1",
        serviceOrigin: window.location.origin,
        capabilityToken: "browser-test-capability",
        sourceId: "browser-source",
      },
      window.location.origin,
    );
  });
  const learn = page.frameLocator("#learn-frame");
  await expect(learn.locator('[data-testid="learn-rail"]')).toBeVisible();
  await expect(
    learn.getByRole("heading", { name: "Browser Course" }),
  ).toBeVisible();
  return learn;
}

export async function notifyContextChanged(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#learn-frame");
    frame?.contentWindow?.postMessage(
      { type: "courseweave.context.changed.v1", sourceId: "browser-source" },
      window.location.origin,
    );
  });
}
