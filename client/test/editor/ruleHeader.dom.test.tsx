import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithFluent, makeGraph } from "./domFixtures";
import { RuleHeader } from "../../src/editor/ui/header/RuleHeader";
import { LifecycleStatus } from "../../src/editor/ui/header/LifecycleStatus";
import { PublishDialog } from "../../src/editor/ui/header/PublishDialog";
import { deriveLifecycle, changesSince, type Lifecycle } from "../../src/editor/ui/header/lifecycle";
import type { Issue } from "../../src/editor/ui/useIssues";

const rule = makeGraph().rule;

describe("deriveLifecycle", () => {
  const base = { rule: { ...rule, publishedVersion: 3 }, needsDraft: false, viewingPublished: false, dirtyCount: 0 };
  it("maps each state", () => {
    expect(deriveLifecycle({ ...base, serverStatus: 753840000, needsDraft: true }).kind).toBe("liveReadOnly");
    expect(deriveLifecycle({ ...base, serverStatus: 753840000, viewingPublished: true }).kind).toBe("viewingPublished");
    expect(deriveLifecycle({ ...base, serverStatus: 753840000 })).toMatchObject({ kind: "draftOfLive", version: 3, live: true });
    expect(deriveLifecycle({ ...base, serverStatus: 1, rule })).toMatchObject({ kind: "newDraft" });
    expect(deriveLifecycle({ ...base, serverStatus: 2 }).kind).toBe("archived");
  });
});

describe("LifecycleStatus", () => {
  it.each<[Lifecycle, string[]]>([
    [{ kind: "liveReadOnly", version: 3, live: true }, ["Live · v3"]],
    [{ kind: "draftOfLive", version: 3, dirtyCount: 4, saved: false, live: true }, ["Live · v3", "Editing draft", "4 unsaved changes"]],
    [{ kind: "draftOfLive", version: 3, dirtyCount: 0, saved: true, live: true }, ["Draft differs from v3"]],
    [{ kind: "newDraft", dirtyCount: 1 }, ["Not live", "Draft", "1 unsaved change"]],
    [{ kind: "viewingPublished", version: 3, dirtyCount: 4 }, ["Viewing live v3", "Read-only · Your draft has 4 unsaved changes"]],
    [{ kind: "archived" }, ["Archived"]],
  ])("%o", (lifecycle, texts) => {
    renderWithFluent(<LifecycleStatus lifecycle={lifecycle} publishedText="Published 2 Oct by Dana" />);
    const status = screen.getByTestId("lifecycle-status");
    for (const t of texts) expect(status).toHaveTextContent(t);
  });
});

describe("RuleHeader", () => {
  it.each<[Lifecycle, "edit" | "publish" | "backToDraft", string]>([
    [{ kind: "liveReadOnly", version: 3, live: true }, "edit", "Edit rule"],
    [{ kind: "draftOfLive", version: 3, dirtyCount: 1, saved: false, live: true }, "publish", "Publish…"],
    [{ kind: "viewingPublished", version: 3, dirtyCount: 0 }, "backToDraft", "Back to draft"],
  ])("renders exactly one primary for %o", (lifecycle, kind, label) => {
    const { container } = renderWithFluent(
      <RuleHeader name="Rule" lifecycle={lifecycle} stacked={false} canRename onRename={() => {}}
        primary={{ kind, onClick: () => {} }} save={{ dirty: true, onSave: () => {} }} />,
    );
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    const primaries = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === label);
    expect(primaries).toHaveLength(1);
  });

  it("shows Checking… while Publish… runs", () => {
    renderWithFluent(<RuleHeader name="Rule" lifecycle={{ kind: "newDraft", dirtyCount: 0 }} stacked={false}
      canRename onRename={() => {}} primary={{ kind: "publish", onClick: () => {}, busy: true }} />);
    expect(screen.getByRole("button", { name: /Checking…/ })).toBeDisabled();
  });

  it("shows Saved instead of Save when clean", () => {
    renderWithFluent(<RuleHeader name="Rule" lifecycle={{ kind: "newDraft", dirtyCount: 0 }} stacked={false}
      canRename onRename={() => {}} save={{ dirty: false, onSave: () => {} }} />);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("PublishDialog", () => {
  const err: Issue = { id: "e", severity: "Error", code: "X", message: "Choose at least one day.",
    target: { kind: "schedule", id: "r1" }, path: "Schedule › Days of week", stale: false, source: "client" };
  const props = {
    open: true, ruleName: "High-value deal guardrails", version: 3, warnings: [], changeCount: 4,
    modelName: "Opportunity", onCancel: vi.fn(), onConfirm: vi.fn(), onViewWarnings: vi.fn(),
    onReviewChanges: vi.fn(), onGoTo: vi.fn(), onOpenIssues: vi.fn(),
  };

  it("asks to publish the next version when ready", () => {
    renderWithFluent(<PublishDialog {...props} errors={[]} />);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Publish v4?")).toBeInTheDocument();
    expect(dialog.getByText("No errors")).toBeInTheDocument();
    expect(dialog.getByText("4 changes since v3")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Publish v4" })).toBeEnabled();
  });

  it("lists errors with Go to field when blocked", () => {
    renderWithFluent(<PublishDialog {...props} errors={[err]} />);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Fix 1 error to publish")).toBeInTheDocument();
    expect(dialog.getByText("Schedule › Days of week")).toBeInTheDocument();
    dialog.getByRole("button", { name: "Go to field" }).click();
    expect(props.onGoTo).toHaveBeenCalledWith(err);
    expect(dialog.getByRole("button", { name: "Open issues" })).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: /Publish v/ })).toBeNull();
  });
});

describe("changesSince", () => {
  it("matches entities by position and ignores ids", () => {
    const live = makeGraph();
    const draft = { ...makeGraph(), rule: { ...makeGraph().rule, id: "draft-id", activeRuleId: "r1" } };
    expect(changesSince(live, draft)).toEqual([]);
    draft.rule.name = "Renamed";
    expect(changesSince(live, draft)).toEqual(["Rule settings"]);
  });
});
