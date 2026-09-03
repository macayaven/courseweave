import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useBeforeUnload, type RecoveryStatus } from "../src/reconnect";

const appMocks = vi.hoisted(() => ({
  getCourse: vi.fn(),
  validateCourse: vi.fn(),
  putCourse: vi.fn(),
  runtime: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../src/api", () => ({
  createAuthorClient: () => ({
    getCourse: appMocks.getCourse,
    validateCourse: appMocks.validateCourse,
    putCourse: appMocks.putCourse,
    getProposals: vi.fn(),
    postGuide: vi.fn(),
    createProposal: vi.fn(),
    editProposal: vi.fn(),
    acceptProposal: vi.fn(),
    rejectProposal: vi.fn(),
  }),
  AuthorApiError: class AuthorApiError extends Error {},
}));
vi.mock("../src/runtime", () => ({ useAuthorRuntime: appMocks.runtime }));
import { AuthorApp } from "../src/app";

const course = {
  schema_version: 1,
  id: "course",
  title: "Course",
  description: "",
  entry_module_id: "module",
  policies: {
    content_sharing: "explicit_only",
    durable_mutation: "proposal_or_direct_student_action",
    terminal_execution: "student_only",
    conversation_memory: "session_only",
    max_shared_chars: 1,
    workspace_write_globs: [],
  },
  modules: [
    {
      id: "module",
      title: "Module",
      description: "",
      phases: [
        {
          id: "phase",
          title: "Phase",
          kind: "read",
          teacher_mode: "reading_companion",
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
          surfaces: [
            {
              id: "surface",
              type: "markdown",
              role: "primary",
              path: "lesson.md",
            },
          ],
        },
      ],
    },
  ],
};
const ready = {
  status: "ready" as const,
  runtime: {
    serviceOrigin: "https://course.test",
    capabilityToken: "token",
    sourceId: "author",
  },
  retry: appMocks.retry,
};
function resetApp() {
  appMocks.getCourse.mockReset();
  appMocks.validateCourse.mockReset();
  appMocks.putCourse.mockReset();
  appMocks.retry.mockReset();
  appMocks.runtime.mockReturnValue(ready);
}
async function startDirtyApp() {
  appMocks.getCourse.mockResolvedValueOnce({
    manifest: course,
    raw: "{}",
    etag: '"old"',
  });
  const view = render(<AuthorApp />);
  fireEvent.change(await screen.findByLabelText("Course title"), {
    target: { value: "Dirty local" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Select surface surface" }),
  );
  return view;
}

function Harness({
  dirty,
  status,
}: {
  dirty: boolean;
  status: RecoveryStatus;
}) {
  useBeforeUnload(dirty);
  return <output>{status}</output>;
}
beforeEach(resetApp);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Author reconnect and unload recovery", () => {
  it("exports current local canonical bytes from a reconnect conflict without PUT", async () => {
    const localRaw = '{\n  "title": "Dirty café"\n}\n';
    const oldRaw = '{\n  "title": "Course"\n}\n';
    const remoteRaw = '{\n  "title": "Remote"\n}\n';
    appMocks.getCourse
      .mockResolvedValueOnce({ manifest: course, raw: oldRaw, etag: '"old"' })
      .mockResolvedValueOnce({
        manifest: { ...course, title: "Remote" },
        raw: remoteRaw,
        etag: '"remote"',
      });
    appMocks.validateCourse.mockResolvedValue({
      manifest: { ...course, title: "Dirty café" },
      formatted_json: localRaw,
    });
    const create = vi.fn<(blob: Blob) => string>(() => "blob:reconnect");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    let filename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        filename = this.download;
      },
    );

    const view = render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "Dirty café" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select surface surface" }),
    );

    appMocks.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);
    appMocks.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "fresh-export",
        sourceId: "author-export",
      },
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);

    await screen.findByText(/remote version changed/i);
    const exportButton = await screen.findByRole("button", {
      name: "Export local courseweave.json",
    });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);

    const blob = create.mock.calls[0]?.[0] as Blob;
    const bytes = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });

    expect(bytes).toBe(localRaw);
    expect(bytes).not.toBe(oldRaw);
    expect(bytes).not.toBe(remoteRaw);
    expect(filename).toBe("courseweave.json");
    expect(revoke).toHaveBeenCalledWith("blob:reconnect");
    expect(appMocks.putCourse).not.toHaveBeenCalled();
  });
  it("installs beforeunload only while a local draft is dirty and removes it after save/unmount", () => {
    const listener = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<Harness dirty status="connected" />);
    expect(listener).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    view.rerender(<Harness dirty={false} status="connected" />);
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    view.unmount();
  });

  it("models reconnecting and conflict recovery without an automatic save replay", () => {
    render(<Harness dirty status="conflict" />);
    expect(screen.getByText("conflict")).toBeInTheDocument();
  });

  it("aborts all active validation reads on runtime loss then refetches a changed ETag without replaying PUT", async () => {
    const manifest = {
      schema_version: 1,
      id: "course",
      title: "Course",
      description: "",
      entry_module_id: "module",
      policies: {
        content_sharing: "explicit_only",
        durable_mutation: "proposal_or_direct_student_action",
        terminal_execution: "student_only",
        conversation_memory: "session_only",
        max_shared_chars: 1,
        workspace_write_globs: [],
      },
      modules: [
        {
          id: "module",
          title: "Module",
          description: "",
          phases: [
            {
              id: "phase",
              title: "Phase",
              kind: "read",
              teacher_mode: "reading_companion",
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
              surfaces: [
                {
                  id: "surface",
                  type: "markdown",
                  role: "primary",
                  path: "lesson.md",
                },
              ],
            },
          ],
        },
      ],
    };
    let resolveValidation:
      | ((value: { manifest: unknown; formatted_json: string }) => void)
      | undefined;
    appMocks.getCourse
      .mockResolvedValueOnce({ manifest, raw: "{}", etag: '"old"' })
      .mockResolvedValueOnce({
        manifest: { ...manifest, title: "Remote" },
        raw: '{"title":"Remote"}\n',
        etag: '"new"',
      });
    appMocks.validateCourse.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveValidation = resolve;
        }),
    );
    const ready = {
      status: "ready" as const,
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: appMocks.retry,
    };
    appMocks.runtime.mockReturnValue(ready);
    const view = render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "Dirty local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await waitFor(() => expect(appMocks.validateCourse).toHaveBeenCalledOnce());
    const signal = appMocks.validateCourse.mock.calls[0]?.[2] as AbortSignal;
    appMocks.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);
    expect(signal.aborted).toBe(true);
    appMocks.runtime.mockReturnValue({
      ...ready,
      runtime: {
        ...ready.runtime,
        capabilityToken: "fresh-token",
        sourceId: "author-fresh",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(2));
    resolveValidation?.({ manifest, formatted_json: "{}\n" });
    await Promise.resolve();
    expect(appMocks.putCourse).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/remote version changed/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Course title")).toHaveValue("Dirty local");
  });

  it("invalidates a pending import validation across reconnect without replacing the selected dirty draft", async () => {
    resetApp();
    let resolve:
      | ((value: { manifest: unknown; formatted_json: string }) => void)
      | undefined;
    appMocks.validateCourse.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = await startDirtyApp();
    fireEvent.change(screen.getByLabelText("Import course file"), {
      target: {
        files: [
          new File(
            [JSON.stringify({ ...course, title: "Imported" })],
            "courseweave.json",
          ),
        ],
      },
    });
    await waitFor(() => expect(appMocks.validateCourse).toHaveBeenCalledOnce());
    const signal = appMocks.validateCourse.mock.calls[0]?.[2] as AbortSignal;
    appMocks.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);
    expect(signal.aborted).toBe(true);
    appMocks.getCourse.mockResolvedValueOnce({
      manifest: course,
      raw: "{}",
      etag: '"old"',
    });
    appMocks.runtime.mockReturnValue({
      ...ready,
      runtime: {
        ...ready.runtime,
        capabilityToken: "fresh-import",
        sourceId: "author-import",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(2));
    resolve?.({
      manifest: { ...course, title: "Imported" },
      formatted_json: '{"title":"Imported"}\n',
    });
    await Promise.resolve();
    expect(screen.getByLabelText("Path")).toHaveValue("lesson.md");
    expect(appMocks.putCourse).not.toHaveBeenCalled();
  });

  it("invalidates pending runnable diagnostics across reconnect without replaying or repopulating preview issues", async () => {
    resetApp();
    let reject: ((value: unknown) => void) | undefined;
    appMocks.validateCourse.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const view = await startDirtyApp();
    fireEvent.click(
      screen.getByRole("button", { name: "Check runnable diagnostics" }),
    );
    await waitFor(() => expect(appMocks.validateCourse).toHaveBeenCalledOnce());
    const signal = appMocks.validateCourse.mock.calls[0]?.[2] as AbortSignal;
    appMocks.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);
    expect(signal.aborted).toBe(true);
    appMocks.getCourse.mockResolvedValueOnce({
      manifest: course,
      raw: "{}",
      etag: '"old"',
    });
    appMocks.runtime.mockReturnValue({
      ...ready,
      runtime: {
        ...ready.runtime,
        capabilityToken: "fresh-runnable",
        sourceId: "author-runnable",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(2));
    reject?.(
      Object.assign(new Error("late"), {
        details: {
          issues: [
            {
              path: "/modules/0/phases/0/surfaces/0/path",
              code: "missing_artifact",
              message: "Late missing.",
            },
          ],
        },
      }),
    );
    await Promise.resolve();
    expect(screen.queryByText("Late missing.")).not.toBeInTheDocument();
    expect(appMocks.putCourse).not.toHaveBeenCalled();
  });

  it("aborts the stale conflict latest GET and lets only fresh authoritative refetch create the conflict", async () => {
    resetApp();
    appMocks.validateCourse.mockResolvedValue({
      manifest: course,
      formatted_json: "{}\n",
    });
    appMocks.putCourse.mockRejectedValue(
      Object.assign(new Error("stale"), { status: 409 }),
    );
    let latest: ((value: unknown) => void) | undefined;
    appMocks.getCourse
      .mockImplementationOnce(() =>
        Promise.resolve({ manifest: course, raw: "{}", etag: '"old"' }),
      )
      .mockImplementationOnce(
        (_signal: AbortSignal) =>
          new Promise((done) => {
            latest = done;
          }),
      );
    const view = await startDirtyApp();
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(2));
    const latestSignal = appMocks.getCourse.mock.calls[1]?.[0] as AbortSignal;
    appMocks.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);
    expect(latestSignal.aborted).toBe(true);
    appMocks.getCourse.mockResolvedValueOnce({
      manifest: { ...course, title: "Remote" },
      raw: '{"title":"Remote"}\n',
      etag: '"new"',
    });
    appMocks.runtime.mockReturnValue({
      ...ready,
      runtime: {
        ...ready.runtime,
        capabilityToken: "fresh-conflict",
        sourceId: "author-conflict",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(3));
    latest?.({
      manifest: { ...course, title: "Old latest" },
      raw: "{}",
      etag: '"wrong"',
    });
    await Promise.resolve();
    expect(screen.queryByText("Old latest")).not.toBeInTheDocument();
    expect(appMocks.putCourse).toHaveBeenCalledOnce();
  });

  it("treats a disconnected PUT as ambiguous, never replays it, and keeps local selection for fresh conflict review", async () => {
    resetApp();
    appMocks.validateCourse.mockResolvedValue({
      manifest: course,
      formatted_json: "{}\n",
    });
    let resolvePut: ((value: unknown) => void) | undefined;
    appMocks.putCourse.mockImplementation(
      () =>
        new Promise((done) => {
          resolvePut = done;
        }),
    );
    const view = await startDirtyApp();
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    await waitFor(() => expect(appMocks.putCourse).toHaveBeenCalledOnce());
    const putSignal = appMocks.putCourse.mock.calls[0]?.[2] as AbortSignal;
    appMocks.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: appMocks.retry,
    });
    view.rerender(<AuthorApp />);
    expect(putSignal.aborted).toBe(true);
    appMocks.getCourse.mockResolvedValueOnce({
      manifest: { ...course, title: "Remote" },
      raw: '{"title":"Remote"}\n',
      etag: '"new"',
    });
    appMocks.runtime.mockReturnValue({
      ...ready,
      runtime: {
        ...ready.runtime,
        capabilityToken: "fresh-put",
        sourceId: "author-put",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(2));
    resolvePut?.({
      manifest: { ...course, title: "Late saved" },
      raw: "{}",
      etag: '"late"',
    });
    await Promise.resolve();
    expect(appMocks.putCourse).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(/remote version changed/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Path")).toHaveValue("lesson.md");
  });
});
