import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, cleanup } from "@testing-library/react";
import { renderWithMeta, fakeMetadata } from "./metaFixtures";
import { renderWithFluent, makeGraph } from "./domFixtures";
import { RuleInspector } from "../../src/editor/ui/inspectors/RuleInspector";
import { ScheduleSection } from "../../src/editor/schedule/ScheduleSection";
import { emptySchedule } from "../../src/editor/schedule/scheduleModel";
import type { RuleSchedule } from "../../src/editor/schedule/scheduleModel";
import type { RuleHeader } from "../../src/editor/model/types";

function mountInspector(ruleOver: Partial<RuleHeader> = {}, schedule: RuleSchedule | null = null) {
  const rule: RuleHeader = { ...makeGraph().rule, ...ruleOver };
  const onPatch = vi.fn();
  const onPatchSchedule = vi.fn();
  renderWithMeta(
    <RuleInspector rule={rule} onPatch={onPatch} schedule={schedule} onPatchSchedule={onPatchSchedule} />,
    fakeMetadata({ account: [] }),
  );
  return { rule, onPatch, onPatchSchedule };
}

function mountSection(over: Partial<RuleSchedule> = {}, onPatch = vi.fn(), onOpenRuns = vi.fn()) {
  const schedule: RuleSchedule = { ...emptySchedule(), on: true, ...over };
  renderWithFluent(
    <ScheduleSection schedule={schedule} onPatch={onPatch} ruleTimeZone={null} evaluationContext={null} onOpenRuns={onOpenRuns} />,
  );
  return { schedule, onPatch, onOpenRuns };
}

describe("RuleInspector — Schedule section visibility", () => {
  it("is hidden unless the rule is On demand + Runs for = All records", () => {
    mountInspector({ triggers: [3], onDemandScope: 1 });
    expect(screen.queryByRole("group", { name: "Schedule" })).not.toBeInTheDocument();
    cleanup();

    mountInspector({ triggers: [1], onDemandScope: 2 });
    expect(screen.queryByRole("group", { name: "Schedule" })).not.toBeInTheDocument();
    cleanup();

    mountInspector({ triggers: [3], onDemandScope: 2 });
    expect(screen.getByRole("group", { name: "Schedule" })).toBeInTheDocument();
  });
});

describe("ScheduleSection", () => {
  it("shows Every (minutes) for pattern 1 and hides the other pattern fields", () => {
    mountSection({ pattern: 1, every: 15 });
    expect(screen.getByRole("combobox", { name: "Every" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Time of day")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Days of week" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Day of month" })).not.toBeInTheDocument();
  });

  it("offers exactly 15/30/45 in the minutes dropdown", async () => {
    mountSection({ pattern: 1, every: 15 });
    fireEvent.click(screen.getByRole("combobox", { name: "Every" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["15 minutes", "30 minutes", "45 minutes"]);
  });

  it("shows Time of day for Daily/Weekly/Monthly, plus day toggles for Weekly and Day of month for Monthly", () => {
    mountSection({ pattern: 3, timeOfDay: "09:00" });
    expect(screen.getByLabelText("Time of day")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Days of week" })).not.toBeInTheDocument();
    cleanup();

    const { onPatch } = mountSection({ pattern: 4, timeOfDay: "09:00", days: [1] });
    expect(screen.getByLabelText("Time of day")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Days of week" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Thursday" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Thursday" }));
    expect(onPatch).toHaveBeenCalledWith({ days: [1, 4] });
    cleanup();

    mountSection({ pattern: 5, timeOfDay: "09:00", dayOfMonth: 15 });
    expect(screen.getByLabelText("Time of day")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Day of month" })).toBeInTheDocument();
  });

  it("explains timing, and the scheduler's account unless the rule runs as System, behind an info icon", () => {
    const schedule: RuleSchedule = { ...emptySchedule(), on: true, pattern: 3, timeOfDay: "09:00" };
    const tip = () => screen.getByText(/^Runs within 15 minutes of the scheduled time, in the rule time zone/);
    renderWithFluent(<ScheduleSection schedule={schedule} onPatch={vi.fn()} ruleTimeZone={null} evaluationContext={2} onOpenRuns={vi.fn()} />);
    expect(tip().textContent).not.toContain("scheduler's account");
    cleanup();

    renderWithFluent(<ScheduleSection schedule={schedule} onPatch={vi.fn()} ruleTimeZone={null} evaluationContext={1} onOpenRuns={vi.fn()} />);
    expect(tip().textContent).toContain("as the scheduler's account");
  });

  it("shows a client-side validation message only when On", () => {
    mountSection({ pattern: 1, every: 20 });
    expect(screen.getByText("Every N minutes must be 15, 30 or 45.")).toBeInTheDocument();
    cleanup();

    renderWithFluent(
      <ScheduleSection schedule={{ ...emptySchedule(), on: false, pattern: 1, every: 20 }}
        onPatch={vi.fn()} ruleTimeZone={null} evaluationContext={null} onOpenRuns={vi.fn()} />,
    );
    expect(screen.queryByText("Every N minutes must be 15, 30 or 45.")).not.toBeInTheDocument();
  });

  it("shows a load-failure note with Try again, hiding the controls, when loadError is set", () => {
    const onRetry = vi.fn();
    renderWithFluent(
      <ScheduleSection schedule={null} onPatch={vi.fn()} ruleTimeZone={null} evaluationContext={null}
        onOpenRuns={vi.fn()} loadError onRetry={onRetry} />,
    );
    expect(screen.getByText("Could not load the schedule.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows Next and Last as text, and View runs opens Runs", () => {
    const { onOpenRuns } = mountSection({
      nextRunOn: "2026-10-08T06:00:00Z", lastRunOn: "2026-10-05T06:00:00Z", lastOutcome: 1,
    });
    expect(screen.getByText("Thu 8 Oct, 06:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("Mon 5 Oct, 06:00 UTC")).toBeInTheDocument();
    expect(screen.getByText(/Started a run/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View runs" }));
    expect(onOpenRuns).toHaveBeenCalledTimes(1);
  });
});
