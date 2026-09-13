import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AuthorPhase } from "@courseweave/ui";
import { AuthorPreview } from "../src/preview";

const phase = (
  kind: Extract<AuthorPhase["experience"], { type: "builtin" }>["id"],
): AuthorPhase => ({
  id: kind,
  title: `A ${kind} phase`,
  progress: "required",
  experience: { type: "builtin", id: kind },
  teacher: {
    access: { mode: "observer_only" as const, requires: [] },
    guidance: {
      style: { type: "builtin" as const, id: "explanatory" as const },
      hint_level: "none" as const,
    },
    sharing: { allow: [] },
    proposals: { allow: [] },
  },
  completion: { requirements: [] },

  surfaces: [
    {
      id: "remote",
      type: "video",
      purpose: "reference" as const,
      label: "Content",
      src: "https://video.example/movie.mp4",
    },
  ],
});

afterEach(cleanup);
describe("inert Author preview", () => {
  it("renders every phase kind as a no-action learner card and never fetches, navigates, or messages a parent", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const post = vi.spyOn(window.parent, "postMessage");
    for (const kind of [
      "generic",
      "orientation",
      "reading",
      "media",
      "prediction",
      "experiment",
      "practice",
      "review",
      "project",
    ] as const) {
      const view = render(
        <AuthorPreview
          phase={phase(kind)}
          issues={[
            {
              path: "/modules/0/phases/0/surfaces/0/path",
              code: "missing_artifact",
              message: "Missing local artifact.",
            },
            { path: "", code: "lfs_pointer", message: "LFS pointer." },
          ]}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent("Preview only");
      expect(
        screen.getByText("https://video.example/movie.mp4"),
      ).toBeInTheDocument();
      view.unmount();
    }
    render(
      <AuthorPreview
        phase={null}
        issues={[
          {
            path: "",
            code: "invalid_terminal_cwd",
            message: "Invalid terminal directory.",
          },
        ]}
      />,
    );
    expect(screen.getByText(/select a phase/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("distinguishes structural and runnable checking, passed, and issue states without probing HTTPS media", () => {
    const view = render(
      <AuthorPreview
        phase={phase("media")}
        structural={{ status: "checking", issues: [] }}
        runnable={{ status: "not_requested", issues: [] }}
      />,
    );
    expect(
      screen.getByText("Structural validation: checking."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Runnable diagnostics: not requested."),
    ).toBeInTheDocument();
    view.rerender(
      <AuthorPreview
        phase={phase("media")}
        structural={{ status: "passed", issues: [] }}
        runnable={{
          status: "issues",
          issues: [
            {
              path: "/p",
              code: "missing_artifact",
              message: "Missing local artifact.",
            },
            {
              path: "/c",
              code: "invalid_terminal_cwd",
              message: "Invalid terminal directory.",
            },
            { path: "/v", code: "lfs_pointer", message: "LFS pointer video." },
          ],
        }}
      />,
    );
    expect(
      screen.getByText("Structural validation: passed."),
    ).toBeInTheDocument();
    for (const message of [
      "Missing local artifact.",
      "Invalid terminal directory.",
      "LFS pointer video.",
    ])
      expect(screen.getByText(message)).toBeInTheDocument();
  });
});
