import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompatibilityPanel } from "../src/compatibility";

afterEach(cleanup);

const report = {
  passed: true,
  profile: { application_version: "0.2.0", schema_version: 2 },
  structural: [], assets: [], links: [], profile_issues: [],
  not_performed: [{ code: "installed_execution_not_checked", location: "",
    message: "Installed Student execution has not been checked.", severity: "not_performed" }],
};

it("keeps passed checks distinct from installed evidence and links failures to fields", async () => {
  const checkCompatibility = vi.fn().mockResolvedValue(report);
  const onFocusIssues = vi.fn();
  render(<CompatibilityPanel manifest={{}} check={checkCompatibility} disabled={false}
    epoch="one" onFocusIssues={onFocusIssues} />);
  fireEvent.click(screen.getByRole("button", { name: "Check student compatibility" }));
  expect(await screen.findByText("Performed checks passed.")).toBeInTheDocument();
  expect(screen.getByText("Installed Student execution has not been checked.")).toBeInTheDocument();
  checkCompatibility.mockResolvedValue({ ...report, passed: false,
    structural: [{ code: "contract_invalid", location: "/title", message: "A title is required.", severity: "error" }] });
  fireEvent.click(screen.getByRole("button", { name: "Check student compatibility" }));
  expect(await screen.findByText("Compatibility errors need attention.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review /title" }));
  expect(onFocusIssues).toHaveBeenCalledWith([{ path: "/title", code: "contract_invalid", message: "A title is required." }]);
});

it("discards a result when the draft changes during validation", async () => {
  let finish!: (value: typeof report) => void;
  const check = () => new Promise<typeof report>((resolve) => { finish = resolve; });
  const view = render(<CompatibilityPanel manifest={{ title: "Before" }} check={check}
    disabled={false} epoch="one" />);
  fireEvent.click(screen.getByRole("button", { name: "Check student compatibility" }));
  view.rerender(<CompatibilityPanel manifest={{ title: "After" }} check={check}
    disabled={false} epoch="two" />);
  await act(async () => finish(report));
  expect(screen.queryByText("Performed checks passed.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check student compatibility" })).toBeEnabled();
});
