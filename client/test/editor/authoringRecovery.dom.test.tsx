import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { RuleEditorApp } from "../../src/editor/ui/RuleEditorApp";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { fakeMetadata } from "./metaFixtures";
import { makeGraph, makeGroup, makeAction } from "./domFixtures";
import { recoveryKey } from "../../src/editor/ui/useRuleRecovery";
import { resetTempIds } from "../../src/editor/model/ids";
import type { EditorApi } from "../../src/editor/webapi";
import type { RuleGraph } from "../../src/editor/model/types";
import { publishedDefinition, publishedRuleId } from "./publishedFixtures";

const PUBLISHED = 753840000;
const scope = "https://audit.crm.dynamics.com";
const clone = (graph: RuleGraph): RuleGraph => JSON.parse(JSON.stringify(graph));
const records = { search: async () => [], resolveName: async () => null, queryByFetchXml: async () => [] };

function mount(graph = makeGraph(), overrides: Partial<EditorApi> = {}, reload = vi.fn(async () => clone(graph))) {
  const api = { getClientUrl: () => scope, executeBatch: vi.fn(async () => ({ httpStatus: 200, text: "HTTP/1.1 204 No Content" })),
    validateRule: vi.fn(async () => ({ isValid: true, issues: [], draftHash: "validated-candidate" })), publishRule: vi.fn(async () => {}),
    unpublishRule: vi.fn(async () => {}), ...overrides };
  const view = render(<MetadataProvider service={fakeMetadata({ account: [] })}>
    <RecordSearchProvider service={records}><SystemChoicesProvider>
      <RuleEditorApp initialGraph={graph} api={api as EditorApi} reload={reload}
        initialValueLabels={{}} loadValueLabels={async () => ({})} />
    </SystemChoicesProvider></RecordSearchProvider>
  </MetadataProvider>);
  return { ...view, api, reload };
}

function rename(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Rename rule" }));
  const field = screen.getByLabelText("Rule name");
  fireEvent.change(field, { target: { value: name } });
  fireEvent.keyDown(field, { key: "Enter" });
}

const toolbar = () => within(screen.getByTestId("title-actions-row"));

async function menu(item: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

function stored(snapshot: RuleGraph, working: RuleGraph) {
  sessionStorage.setItem(recoveryKey(scope, snapshot.rule.id), JSON.stringify({ version: 1, snapshot, working }));
}

describe("authoring lifecycle and recovery", () => {
  it("requires a working draft to edit the last revision of an unpublished rule", async () => {
    const graph = makeGraph(); graph.rule.statusCode = 1; graph.rule.publishedRevisionId = "revision-2";
    const draft = clone(graph); draft.rule.id = "draft"; draft.rule.activeRuleId = graph.rule.id;
    const openRuleDraft = vi.fn(async () => "draft");
    const { api } = mount(graph, { openRuleDraft }, vi.fn(async () => draft));
    expect(screen.queryByRole("button", { name: "Rename rule" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menuitem", { name: /Reload from server/ });
    expect(screen.queryByRole("menuitem", { name: /Unpublish/ })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename rule" })).toBeEnabled());
    expect(openRuleDraft).toHaveBeenCalledWith(graph.rule.id);
    expect(api.publishRule).not.toHaveBeenCalled();
  });

  it("views a frozen revision read-only and returns to unsaved draft edits", async () => {
    const graph = makeGraph(); graph.rule.activeRuleId = publishedRuleId; graph.rule.statusCode = PUBLISHED;
    graph.rule.publishedRevisionId = "revision-1"; graph.rule.publishedVersion = 1;
    mount(graph, { readPublishedRule: vi.fn(async () => publishedDefinition) });
    rename("Unsaved draft");
    await menu("View published");
    await screen.findByText("Viewing live v1");
    expect(screen.queryByRole("button", { name: "Rename rule" })).toBeNull();
    expect(screen.getAllByText("Frozen version").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Back to draft" }));
    expect(screen.getByRole("button", { name: "Rename rule" })).toBeEnabled();
    expect(screen.getAllByText("Unsaved draft").length).toBeGreaterThan(0);
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("restoring a draft is explicit without a stale-version veto", async () => {
    const graph = makeGraph(); graph.rule.statusCode = PUBLISHED; graph.rule.publishedRevisionId = "revision-1";
    graph.rule.activeRuleId = "active-rule"; graph.rule.publishedVersion = 2;
    graph.rule.etag = 'W/"42"';
    const restoreRuleDraft = vi.fn(async () => {});
    const { api } = mount(graph, { restoreRuleDraft });
    rename("Will be discarded");
    await menu("Restore published to draft…");
    expect(restoreRuleDraft).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Restore draft" }));
    await screen.findByText("Draft restored from v2");
    expect(restoreRuleDraft).toHaveBeenCalledWith("r1");
    expect(api.unpublishRule).not.toHaveBeenCalled();
  });
  it("edits a draft while the published rule stays active", async () => {
    const graph = makeGraph({ actions: [makeAction()] });
    graph.rule.statusCode = PUBLISHED;
    const opened = clone(graph); opened.rule.id = "draft-id"; opened.rule.activeRuleId = graph.rule.id;
    const draft = clone(opened); draft.rule.name = "Revised draft";
    const openRuleDraft = vi.fn(async () => opened.rule.id);
    const { api } = mount(graph, { openRuleDraft }, vi.fn().mockResolvedValueOnce(opened).mockResolvedValueOnce(draft));
    expect(screen.queryByRole("button", { name: "Rename rule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete action" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename rule" })).toBeEnabled());
    expect(openRuleDraft).toHaveBeenCalledWith("r1");
    expect(screen.getByRole("button", { name: "Delete action" })).toBeEnabled();
    // Publish… is never disabled in a draft state: it saves and checks first.
    expect(screen.getByRole("button", { name: "Publish…" })).toBeEnabled();
    rename("Revised draft");
    fireEvent.click(toolbar().getByRole("button", { name: "Save" }));
    await screen.findByText("Saved");
    expect(JSON.stringify(vi.mocked(api.executeBatch).mock.calls)).toContain("draft-id");
    expect(screen.getByText(/Live · v/)).toBeInTheDocument();
    expect(api.unpublishRule).not.toHaveBeenCalled();
    expect(api.publishRule).not.toHaveBeenCalled();
  });

  it("undo restores a deleted subtree and redo removes it again", () => {
    const nested = makeGroup({ id: "nested", name: "Nested", parentGroupId: "g1" });
    mount(makeGraph({ executionGroups: [makeGroup({ name: "Parent", groups: [nested] })] }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete group" })[0]);
    expect(screen.queryByRole("button", { name: "Edit group Nested" })).toBeNull();
    fireEvent.click(toolbar().getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Edit group Nested" })).toBeInTheDocument();
    fireEvent.click(toolbar().getByRole("button", { name: "Redo" }));
    expect(screen.queryByRole("button", { name: "Edit group Nested" })).toBeNull();
  });

  it("publishes the validated draft and keeps editing available", async () => {
    const graph = makeGraph(); graph.rule.etag = 'W/"1"';
    graph.rule.activeRuleId = "active-rule";
    const saved = clone(graph); saved.rule.name = "Validated draft"; saved.rule.etag = 'W/"2"';
    const published = clone(saved); published.rule.statusCode = PUBLISHED;
    const { api } = mount(graph, {}, vi.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce(published));
    rename("Validated draft");
    // Publish… saves, checks, then asks.
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(api.executeBatch).toHaveBeenCalledOnce();
    expect(api.validateRule).toHaveBeenCalledWith("r1");
    expect(dialog.getByText("No errors")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Publish v1" }));
    await screen.findByText("v1 is live");
    expect(api.publishRule).toHaveBeenCalledWith("r1");
    expect(screen.getByRole("button", { name: "Rename rule" })).toBeEnabled();
  });

  it("keeps edits available to review and copy after a failed save", async () => {
    const { reload } = mount(makeGraph(), { executeBatch: vi.fn(async () => ({
      httpStatus: 200, text: 'HTTP/1.1 403 Forbidden\n{"error":{"message":"Write permission denied"}}',
    })) });
    rename("My pending change");
    fireEvent.click(toolbar().getByRole("button", { name: "Save" }));
    const failure = await screen.findByTestId("save-error");
    expect(failure).toHaveTextContent("Couldn't save.");
    expect(failure).toHaveTextContent("Write permission denied");
    expect(within(failure).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getAllByText("My pending change").length).toBeGreaterThan(0);
    await menu(/Review changes/);
    expect((await screen.findByLabelText("Pending changes") as HTMLTextAreaElement).value).toContain("My pending change");
  });

  it("offers recovery after remount and reserves recovered temporary ids", async () => {
    resetTempIds();
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "+ Action" }));
    const key = recoveryKey(scope, "r1");
    await waitFor(() => expect(sessionStorage.getItem(key)).toContain("new-1"));
    first.unmount();
    resetTempIds();
    mount();
    expect(screen.queryByRole("button", { name: "Rename rule" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Action" }));
    await waitFor(() => {
      const recovered = JSON.parse(sessionStorage.getItem(key)!);
      expect(recovered.working.actions.map((a: { id: string }) => a.id)).toEqual(["new-1", "new-3"]); // each action also takes a temp id for its Fires when tree
    });
  });

  it("unpublishing preserves recovered pending edits and explains that choice", async () => {
    const graph = makeGraph(); graph.rule.statusCode = PUBLISHED; graph.rule.etag = 'W/"1"';
    const pending = clone(graph); pending.rule.name = "Retained edit";
    stored(graph, pending);
    const draft = clone(graph); draft.rule.statusCode = 1; draft.rule.etag = 'W/"2"';
    const reload = vi.fn().mockResolvedValueOnce(draft);
    const { api } = mount(graph, {}, reload);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await menu("Unpublish…");
    expect(await screen.findByText(/Unpublishing does not save or discard them/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unpublish" }));
    await screen.findByText(/is no longer enforced/);
    expect(screen.getAllByText("Retained edit").length).toBeGreaterThan(0);
    expect(screen.getByText("1 unsaved change")).toBeInTheDocument();
    expect(api.executeBatch).not.toHaveBeenCalled();
    const recovery = JSON.parse(sessionStorage.getItem(recoveryKey(scope, "r1"))!);
    expect(recovery.snapshot.rule.etag).toBe('W/"2"');
    expect(recovery.working.rule.name).toBe("Retained edit");
  });

  it("retains older recovered edits for a later last-save-wins save", async () => {
    const baseline = makeGraph(); baseline.rule.etag = 'W/"1"';
    const pending = clone(baseline); pending.rule.name = "Older edit";
    stored(baseline, pending);
    const current = clone(baseline); current.rule.statusCode = PUBLISHED; current.rule.etag = 'W/"2"';
    const draft = clone(current); draft.rule.statusCode = 1; draft.rule.etag = 'W/"3"';
    mount(current, {}, vi.fn().mockResolvedValueOnce(draft));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await menu("Unpublish…");
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Unpublish" }));
    await screen.findByText(/is no longer enforced/);
    const recovery = JSON.parse(sessionStorage.getItem(recoveryKey(scope, "r1"))!);
    expect(recovery.snapshot.rule.etag).toBe('W/"3"');
    expect(recovery.working.rule.name).toBe("Older edit");
  });
});
