import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ImportExport, readImportFile } from "../src/import-export";

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

const valid = { schema_version: 1, id: "course", title: "C" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Author import and export", () => {
  it("fatally reads only a bounded UTF-8 schema-v1 object before validation", async () => {
    await expect(
      readImportFile(
        new File([JSON.stringify(valid)], "courseweave.json", {
          type: "application/json",
        }),
      ),
    ).resolves.toEqual(valid);
    await expect(
      readImportFile(new File(["[1]"], "array.json")),
    ).rejects.toThrow("object");
    await expect(
      readImportFile(new File(["{"], "malformed.json")),
    ).rejects.toThrow("JSON");
    await expect(
      readImportFile(new File(['{"schema_version":0}'], "legacy.json")),
    ).rejects.toThrow("schema version");
    await expect(
      readImportFile(new File(['{"schema_version":2}'], "future.json")),
    ).rejects.toThrow("schema version");
    await expect(
      readImportFile(new File([new Uint8Array([0xc3, 0x28])], "broken.json")),
    ).rejects.toThrow("UTF-8");
    await expect(
      readImportFile(new File([new Uint8Array(1024 * 1024 + 1)], "large.json")),
    ).rejects.toThrow("1 MiB");
  });

  it("retains the current state on failed import and can import the same file twice", async () => {
    const validate = vi.fn().mockResolvedValue({
      manifest: valid,
      formatted_json: '{\n  "schema_version": 1\n}\n',
    });
    const imported = vi.fn();
    render(
      <ImportExport
        manifest={valid}
        formattedJson={null}
        validate={validate}
        onImport={imported}
      />,
    );
    const input = screen.getByLabelText("Import course file");
    const bad = new File(["[]"], "bad.json");
    fireEvent.change(input, { target: { files: [bad] } });
    expect(await screen.findByText(/must be an object/i)).toBeInTheDocument();
    expect(imported).not.toHaveBeenCalled();
    const good = new File([JSON.stringify(valid)], "courseweave.json");
    fireEvent.change(input, { target: { files: [good] } });
    await screen.findByText(/Imported into the local draft/i);
    fireEvent.change(input, { target: { files: [good] } });
    await waitFor(() => expect(imported).toHaveBeenCalledTimes(2));
  });

  it("keeps a dirty selected AuthorApp draft and baseline untouched when server structural import validation rejects unexpected fields", async () => {
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
      raw: "{}",
      etag: '"saved-etag"',
    });
    app.validateCourse.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            {
              path: "/unexpected",
              code: "schema_validation",
              message: "Unexpected field.",
            },
          ],
        },
      }),
    );
    render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText("Course title"), {
      target: { value: "Dirty title" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Select surface surface" }),
    );
    fireEvent.change(screen.getByLabelText("Import course file"), {
      target: {
        files: [
          new File(
            [JSON.stringify({ ...manifest, unexpected: true })],
            "bad.json",
          ),
        ],
      },
    });
    expect(await screen.findByText("invalid")).toBeInTheDocument();
    expect(screen.getByLabelText("Path")).toHaveValue("saved.md");
    expect(screen.getByText("Unsaved local draft.")).toBeInTheDocument();
    expect(app.putCourse).not.toHaveBeenCalled();
  });

  it("does not replace a newer draft when import validation completes after its operation epoch changes", async () => {
    let complete:
      | ((value: { manifest: unknown; formatted_json: string }) => void)
      | undefined;
    const validate = vi.fn(
      () =>
        new Promise<{ manifest: unknown; formatted_json: string }>(
          (resolve) => {
            complete = resolve;
          },
        ),
    );
    const imported = vi.fn();
    const view = render(
      <ImportExport
        manifest={{ title: "old" }}
        formattedJson={null}
        validate={validate}
        onImport={imported}
        operationEpoch="0:0"
      />,
    );
    fireEvent.change(screen.getByLabelText("Import course file"), {
      target: {
        files: [new File([JSON.stringify(valid)], "courseweave.json")],
      },
    });
    await waitFor(() => expect(validate).toHaveBeenCalledOnce());
    view.rerender(
      <ImportExport
        manifest={{ title: "edited" }}
        formattedJson={null}
        validate={validate}
        onImport={imported}
        operationEpoch="1:0"
      />,
    );
    complete?.({ manifest: valid, formatted_json: "{}\n" });
    await Promise.resolve();
    expect(imported).not.toHaveBeenCalled();
  });

  it("exports exactly server canonical bytes using a fixed safe filename and revokes its blob URL", async () => {
    const create = vi.fn<(blob: Blob) => string>(() => "blob:course");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    let filename = "";
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        filename = this.download;
      });
    render(
      <ImportExport
        manifest={valid}
        formattedJson={'{\n  "title": "café"\n}\n'}
        validate={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export courseweave.json" }),
    );
    expect(create).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("application/json;charset=utf-8");
    const bytes = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(bytes).toBe('{\n  "title": "café"\n}\n');
    expect(filename).toBe("courseweave.json");
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:course");
  });

  it("exports and explicitly saves the identical server canonical byte sequence", async () => {
    const manifest = {
      schema_version: 1,
      id: "course",
      title: "Café",
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
    const canonical = '{\n  "title": "Café"\n}\n';
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
      etag: '"etag"',
    });
    app.validateCourse.mockResolvedValue({
      manifest,
      formatted_json: canonical,
    });
    app.putCourse.mockResolvedValue({
      manifest,
      raw: canonical,
      etag: '"next"',
    });
    const create = vi.fn<(blob: Blob) => string>(() => "blob:canonical");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    render(<AuthorApp />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Validate structure" }),
    );
    await screen.findByText("Structural validation passed.");
    fireEvent.click(
      screen.getByRole("button", { name: "Export courseweave.json" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save course" }));
    await waitFor(() => expect(app.putCourse).toHaveBeenCalledOnce());
    const blob = create.mock.calls[0]?.[0] as Blob;
    const bytes = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(bytes).toBe(canonical);
    expect(app.putCourse).toHaveBeenCalledWith(
      canonical,
      '"etag"',
      expect.anything(),
    );
  });
});
