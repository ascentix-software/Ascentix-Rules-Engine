import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import type { WebApiPort, RunPageResult } from "../../src/editor/webapi";

vi.mock("../../src/editor/runs/runDriver", () => ({
  driveRun: vi.fn(),
  cancelRun: vi.fn(),
  RUN_STATUS: { Queued: 1, Running: 2, Completed: 3, CompletedWithFailures: 4, Failed: 5, Cancelled: 6 },
}));

import { driveRun, cancelRun } from "../../src/editor/runs/runDriver";
import { RunProgress } from "../../src/editor/runs/RunProgress";

const api = {} as WebApiPort;
const running: RunPageResult = { done: false, status: 2, evaluated: 3, changed: 1, blocked: 0, failed: 0, skipped: 2 };

describe("RunProgress", () => {
  beforeEach(() => {
    vi.mocked(driveRun).mockReset();
    vi.mocked(cancelRun).mockReset();
  });

  it("keeps Cancel after a fatal error while the run is still Running", async () => {
    vi.mocked(driveRun).mockImplementation(async (_api, _id, onProgress) => {
      onProgress(running);
      throw new Error("The plug-in timed out.");
    });
    vi.mocked(cancelRun).mockResolvedValue(undefined);
    renderWithFluent(<RunProgress api={api} runId="run1" />);

    await waitFor(() => expect(screen.getByText("The plug-in timed out.")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument());
    expect(cancelRun).toHaveBeenCalledWith(api, "run1");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("keeps Cancel after a fatal error on the first page, while the run is still Queued", async () => {
    vi.mocked(driveRun).mockRejectedValue(new Error("The plug-in timed out."));
    renderWithFluent(<RunProgress api={api} runId="run1" />);

    await waitFor(() => expect(screen.getByText("The plug-in timed out.")).toBeInTheDocument());
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("a finished run offers no Cancel", async () => {
    vi.mocked(driveRun).mockResolvedValue({ ...running, done: true, status: 3 });
    renderWithFluent(<RunProgress api={api} runId="run1" />);

    await waitFor(() => expect(screen.getByText("Completed")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("a page that lands after Cancel doesn't relabel the run", async () => {
    let report: (page: RunPageResult) => void = () => {};
    let finish: (page: RunPageResult) => void = () => {};
    vi.mocked(driveRun).mockImplementation((_api, _id, onProgress) => {
      report = onProgress;
      return new Promise<RunPageResult>((resolve) => { finish = resolve; });
    });
    vi.mocked(cancelRun).mockResolvedValue(undefined);
    renderWithFluent(<RunProgress api={api} runId="run1" />);

    act(() => report(running));
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument());

    // The page that was in flight when Cancel was clicked reports, then the loop returns it.
    act(() => report({ ...running, evaluated: 9 }));
    await act(async () => finish({ ...running, evaluated: 9 }));

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });
});
