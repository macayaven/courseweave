import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SaveConflict } from "../src/save-conflict";

const app = vi.hoisted(() => ({
  getCourse: vi.fn(),
  validateCourse: vi.fn(),
  putCourse: vi.fn(),
  runtime: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../src/api", () => ({
  createAuthorClient: () => ({
    getCourse: app.getCourse,
    validateCourse: app.validateCourse,
    putCourse: app.putCourse,
    getProposals: vi.fn(),
    postGuide: vi.fn(),
    createProposal: vi.fn(),
    editProposal: vi.fn(),
    acceptProposal: vi.fn(),
    rejectProposal: vi.fn(),
  }),
  AuthorApiError: class AuthorApiError extends Error {},
}));
vi.mock("../src/runtime", () => ({ useAuthorRuntime: app.runtime }));
import { AuthorApp } from "../src/app";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("Author Save and stale recovery", () => {
  it("saves current canonical bytes, updates the baseline, and preserves a newer semantic selection", async () => {
    const manifest = {
      schema_version: 1,
      id: "course",
      title: "Saved",
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
                  path: "saved.md",
                },
              ],
            },
          ],
        },
      ],
    };
    const canonical = '{\n  "title": "Saved"\n}\n';
    app.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: app.retry,
    });
    app.getCourse.mockResolvedValue({
      manifest,
      raw: canonical,
      etag: '"old"',
    });
    app.validateCourse.mockResolvedValue({
      manifest,
      formatted_json: canonical,
    });
    app.putCourse.mockResolvedValue({
      manifest,
      raw: canonical,
      etag: '"new"',
    });
    render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "Local edit" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select surface surface" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    await screen.findByText("Saved exact canonical course bytes.");
    expect(app.putCourse).toHaveBeenCalledWith(
      canonical,
      '"old"',
      expect.anything(),
    );
    expect(screen.getByLabelText("Path")).toHaveValue("saved.md");
    expect(
      screen.getByText("Draft matches the loaded course."),
    ).toBeInTheDocument();
  });
  it("keeps a later real edit and selection when an in-flight PUT succeeds", async () => {
    const manifest = {
      schema_version: 1,
      id: "course",
      title: "Saved",
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
                  path: "saved.md",
                },
              ],
            },
          ],
        },
      ],
    };
    app.getCourse.mockReset();
    app.validateCourse.mockReset();
    app.putCourse.mockReset();
    let complete: ((value: unknown) => void) | undefined;
    app.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: app.retry,
    });
    app.getCourse.mockResolvedValue({ manifest, raw: "{}", etag: '"old"' });
    app.validateCourse.mockResolvedValue({
      manifest,
      formatted_json: '{\n  "title": "Saved"\n}\n',
    });
    app.putCourse.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    render(<AuthorApp />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Select surface surface" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    await waitFor(() => expect(app.putCourse).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "newer.md" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select module Module" }),
    );
    complete?.({ manifest, raw: "{}", etag: '"saved"' });
    await Promise.resolve();
    expect(screen.getByLabelText("Module title")).toBeInTheDocument();
    expect(app.putCourse).toHaveBeenCalledOnce();
    expect(screen.getByText("Unsaved local draft.")).toBeInTheDocument();
  });
  it("shows paired current canonical conflict bytes, exports local bytes, and only applies Use latest after confirmation", async () => {
    app.getCourse.mockReset();
    app.validateCourse.mockReset();
    app.putCourse.mockReset();
    const local = {
      schema_version: 1,
      id: "course",
      title: "Local",
      description: "",
      entry_module_id: null,
      policies: {
        content_sharing: "explicit_only",
        durable_mutation: "proposal_or_direct_student_action",
        terminal_execution: "student_only",
        conversation_memory: "session_only",
        max_shared_chars: 1,
        workspace_write_globs: [],
      },
      modules: [],
    };
    const remote = { ...local, title: "Remote" };
    const localRaw = '{\n  "title": "Local"\n}\n';
    const remoteRaw = '{\n  "title": "Remote"\n}\n';
    app.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: app.retry,
    });
    app.getCourse
      .mockResolvedValueOnce({ manifest: local, raw: localRaw, etag: '"old"' })
      .mockResolvedValueOnce({
        manifest: remote,
        raw: remoteRaw,
        etag: '"remote"',
      });
    app.validateCourse.mockResolvedValue({
      manifest: local,
      formatted_json: localRaw,
    });
    app.putCourse.mockRejectedValue(
      Object.assign(new Error("stale"), { status: 409 }),
    );
    const create = vi.fn<(blob: Blob) => string>(() => "blob:local");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AuthorApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Save course" }));
    expect(await screen.findByText("Local canonical JSON")).toBeInTheDocument();
    expect(screen.getByText("Remote canonical JSON")).toBeInTheDocument();
    expect(app.putCourse).toHaveBeenCalledOnce();
    expect(app.getCourse).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Export local courseweave.json" }),
    );
    const blob = create.mock.calls[0]?.[0] as Blob;
    const bytes = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(bytes).toBe(localRaw);
    expect(revoke).toHaveBeenCalledWith("blob:local");
    fireEvent.click(screen.getByRole("button", { name: "Use latest" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByText("Local canonical JSON")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Course title")).toHaveValue("Remote");
    expect(app.putCourse).toHaveBeenCalledOnce();
  });
  it("validates before one exact save and leaves a stale draft for an explicit later decision", async () => {
    const validate = vi.fn().mockResolvedValue({
      manifest: { schema_version: 1 },
      formatted_json: '{\n  "schema_version": 1\n}\n',
    });
    const put = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("stale"), { status: 409 }));
    const latest = vi.fn().mockResolvedValue({
      manifest: { schema_version: 1, title: "Remote" },
      raw: '{\n  "title": "Remote"\n}\n',
      etag: '"remote"',
    });
    const saved = vi.fn();
    render(
      <SaveConflict
        manifest={{ schema_version: 1 }}
        etag={'"old"'}
        exists
        dirty
        validate={validate}
        put={put}
        getLatest={latest}
        onSaved={saved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    expect(
      await screen.findByText(/remote version changed/i),
    ).toBeInTheDocument();
    expect(validate).toHaveBeenCalledBefore(put as never);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      '{\n  "schema_version": 1\n}\n',
      '"old"',
      expect.anything(),
    );
    expect(latest).toHaveBeenCalledOnce();
    expect(screen.getByText(/"Remote"/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep my draft after review" }),
    );
    expect(saved).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
  });

  it("does not create a missing manifest until the explicit Save click", () => {
    render(
      <SaveConflict
        manifest={{ schema_version: 1 }}
        etag=""
        exists={false}
        dirty={false}
        validate={vi.fn(
          () =>
            new Promise<{ manifest: unknown; formatted_json: string }>(
              () => {},
            ),
        )}
        put={vi.fn()}
        getLatest={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled();
  });

  it("does not overwrite a newer local edit when its save response arrives late", async () => {
    let finishValidation:
      | ((value: { manifest: unknown; formatted_json: string }) => void)
      | undefined;
    const validate = vi.fn(
      () =>
        new Promise<{ manifest: unknown; formatted_json: string }>(
          (resolve) => {
            finishValidation = resolve;
          },
        ),
    );
    const put = vi.fn().mockResolvedValue({
      manifest: { schema_version: 1, title: "Saved" },
      raw: '{\n  "title": "Saved"\n}\n',
      etag: '"saved"',
    });
    const saved = vi.fn();
    const props = {
      manifest: { schema_version: 1 },
      etag: '"old"',
      exists: true,
      dirty: true,
      validate,
      put,
      getLatest: vi.fn(),
      onSaved: saved,
      requestGeneration: 0,
      onRemoteSaved: vi.fn(),
    };
    const view = render(<SaveConflict {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    view.rerender(<SaveConflict {...props} requestGeneration={1} />);
    finishValidation?.({
      manifest: { schema_version: 1 },
      formatted_json: "{}\n",
    });
    await Promise.resolve();
    expect(put).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("pairs local and remote canonical JSON, exports local bytes, and clears conflict after confirmed Use latest", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const saved = vi.fn();
    const validate = vi.fn().mockResolvedValue({
      manifest: { schema_version: 1 },
      formatted_json: '{\n  "title": "Local"\n}\n',
    });
    const put = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("stale"), { status: 409 }));
    const getLatest = vi.fn().mockResolvedValue({
      manifest: { schema_version: 1 },
      raw: '{\n  "title": "Remote"\n}\n',
      etag: '"remote"',
    });
    render(
      <SaveConflict
        manifest={{ schema_version: 1 }}
        etag={'"old"'}
        exists
        dirty
        validate={validate}
        put={put}
        getLatest={getLatest}
        onSaved={saved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    expect(await screen.findByText("Local canonical JSON")).toBeInTheDocument();
    expect(screen.getByText("Remote canonical JSON")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use latest" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("region", { name: "Remote conflict" }),
    ).not.toBeInTheDocument();
  });
});
