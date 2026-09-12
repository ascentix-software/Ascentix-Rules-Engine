import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithFluent, makeGraph } from "./domFixtures";
import { EffectiveWindowFields, dateTimeInput, dateTimeIso } from "../../src/editor/ui/inspectors/EffectiveWindowFields";

describe("effective window precision and timezone", () => {
  it("preserves seconds and milliseconds through the UTC input conversion", () => {
    const iso = "2026-09-30T23:59:42.125Z";
    expect(dateTimeIso(dateTimeInput(iso, "utc"), "utc")).toBe(iso);
    expect(dateTimeIso("2026-09-30T17:45", "utc")).toBe("2026-09-30T17:45:00.000Z");
  });

  it("switching timezone displays the same instant without patching it", () => {
    const rule = { ...makeGraph().rule, effectiveTo: "2026-09-30T23:59:42.125Z" };
    const patch = vi.fn();
    renderWithFluent(<EffectiveWindowFields rule={rule} onPatch={patch} />);
    expect(screen.getByLabelText("Effective to")).toHaveValue("2026-09-30T23:59:42.125");
    fireEvent.change(screen.getByLabelText("Schedule timezone"), { target: { value: "local" } });
    expect(patch).not.toHaveBeenCalled();
    expect(dateTimeIso((screen.getByLabelText("Effective to") as HTMLInputElement).value, "local")).toBe(rule.effectiveTo);
  });

  it("clearing an endpoint removes only that bound", () => {
    const patch = vi.fn();
    renderWithFluent(<EffectiveWindowFields rule={{ ...makeGraph().rule, effectiveTo: "2026-09-30T23:59:00Z" }} onPatch={patch} />);
    fireEvent.change(screen.getByLabelText("Effective to"), { target: { value: "" } });
    expect(patch).toHaveBeenCalledWith({ effectiveTo: null });
  });

  it("explains reversed bounds and exact end-time semantics", () => {
    renderWithFluent(<EffectiveWindowFields rule={{ ...makeGraph().rule,
      effectiveFrom: "2026-09-30T12:00:00Z", effectiveTo: "2026-09-30T08:00:00Z" }} onPatch={vi.fn()} />);
    expect(screen.getByText("The end must be at or after the start.")).toBeInTheDocument();
    expect(screen.getByText(/does not extend to the end of the day/)).toBeInTheDocument();
  });
});
