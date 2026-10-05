import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent } from "./domFixtures";
import { DataUpdateProvider, useDataUpdates } from "../../src/editor/dataUpdates/DataUpdateContext";
import { DataUpdateBanner, NOT_ADMIN_NOTE } from "../../src/editor/dataUpdates/DataUpdateBanner";
import type { DataUpdateStatus } from "../../src/editor/webapi";

const pending = (canApply: boolean): DataUpdateStatus => ({
  required: 1, pending: [{ number: 1, title: "Convert actions" }], latest: null, canApply, done: false,
});
const withFailures: DataUpdateStatus = {
  required: 1, pending: [], canApply: true, done: true,
  latest: { number: 1, title: "Convert actions", status: 3, succeeded: 4, failed: 1, failures: [{ item: "r1", message: "Bad rule" }] },
};

function ReadOnlyProbe() {
  const { readOnly } = useDataUpdates();
  return <span data-testid="probe">{readOnly ? "read-only" : "editable"}</span>;
}

function renderBanner(api: { applyDataUpdates?: (...a: any[]) => Promise<DataUpdateStatus> }, reloadPage = vi.fn()) {
  return renderWithFluent(
    <DataUpdateProvider api={api}><DataUpdateBanner api={api} reloadPage={reloadPage} /><ReadOnlyProbe /></DataUpdateProvider>,
  );
}

const completed: DataUpdateStatus = {
  required: 1, pending: [], canApply: true, done: true,
  latest: { number: 1, title: "Convert actions", status: 2, succeeded: 4, failed: 0, failures: [] },
};

async function applyNow() {
  fireEvent.click(await screen.findByRole("button", { name: "Apply now" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
}

describe("data update banner", () => {
  it("offers Apply now to an administrator and makes the views read-only", async () => {
    renderBanner({ applyDataUpdates: vi.fn().mockResolvedValue(pending(true)) });
    expect(await screen.findByText("Update 1 · Convert actions must be applied before rules can be edited.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply now" })).toBeInTheDocument();
    expect(screen.getByTestId("probe")).toHaveTextContent("read-only");
  });

  it("tells everyone else to ask an administrator, with no button", async () => {
    renderBanner({ applyDataUpdates: vi.fn().mockResolvedValue(pending(false)) });
    expect(await screen.findByText(NOT_ADMIN_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply now" })).toBeNull();
  });

  it("asks before applying", async () => {
    renderBanner({ applyDataUpdates: vi.fn().mockResolvedValue(pending(true)) });
    fireEvent.click(await screen.findByRole("button", { name: "Apply now" }));
    expect(await screen.findByText("Apply update 1?")).toBeInTheDocument();
  });

  it("reloads the page when the apply dialog closes after a run that finished", async () => {
    const api = { applyDataUpdates: vi.fn(async (mode: string) => (mode === "Status" ? pending(true) : completed)) };
    const reloadPage = vi.fn();
    renderBanner(api, reloadPage);
    await applyNow();
    expect(await screen.findByText("Update 1 · Convert actions: 4 converted, 0 failed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(reloadPage).toHaveBeenCalledOnce();
  });

  it("reloads only the status when the apply dialog closes after an error", async () => {
    const api = { applyDataUpdates: vi.fn(async (mode: string) => {
      if (mode === "Status") return pending(true);
      throw new Error("Access denied");
    }) };
    const reloadPage = vi.fn();
    renderBanner(api, reloadPage);
    await applyNow();
    expect(await screen.findByText("Access denied", { exact: false })).toBeInTheDocument();
    const statusCalls = api.applyDataUpdates.mock.calls.filter(([mode]) => mode === "Status").length;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => expect(api.applyDataUpdates.mock.calls.filter(([mode]) => mode === "Status").length).toBe(statusCalls + 1));
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("lists failed items with a retry for an administrator, and can be dismissed", async () => {
    renderBanner({ applyDataUpdates: vi.fn().mockResolvedValue(withFailures) });
    expect(await screen.findByText("Bad rule", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry failed items" })).toBeInTheDocument();
    expect(screen.getByTestId("probe")).toHaveTextContent("editable");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Bad rule", { exact: false })).toBeNull();
  });

  it("shows nothing and stays editable when nothing is pending", async () => {
    const api = { applyDataUpdates: vi.fn().mockResolvedValue({ ...pending(true), pending: [], done: true }) };
    renderBanner(api);
    await vi.waitFor(() => expect(api.applyDataUpdates).toHaveBeenCalledWith("Status"));
    expect(screen.queryByTestId("data-update-banner")).toBeNull();
    expect(screen.getByTestId("probe")).toHaveTextContent("editable");
  });

  it("stays editable when the Status call fails or the API is missing", async () => {
    // Review focus 3.
    const failing = { applyDataUpdates: vi.fn().mockRejectedValue(new Error("network")) };
    const { unmount } = renderBanner(failing);
    await vi.waitFor(() => expect(failing.applyDataUpdates).toHaveBeenCalled());
    expect(screen.getByTestId("probe")).toHaveTextContent("editable");
    unmount();
    renderBanner({});
    expect(screen.getByTestId("probe")).toHaveTextContent("editable");
  });
});
