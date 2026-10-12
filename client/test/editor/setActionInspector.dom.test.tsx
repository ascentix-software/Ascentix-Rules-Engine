import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithMeta, fakeMetadata, col } from "./metaFixtures";
import { makeGraph, makeAction } from "./domFixtures";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { ruleEditorInspectorContent } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import type { RuleEditorInspectorHandlers } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import type { ActionNode, TableConfigRef } from "../../src/editor/model/types";
import { FieldMappingDialog } from "../../src/editor/ui/inspectors/FieldMappingDialog";
import { InsertFieldMenu } from "../../src/editor/ui/InsertFieldMenu";
import { TemplateEditor } from "../../src/editor/ui/valueExpressions";

const node = (id: string, name: string, type: TableConfigRef["tableConfigType"], parent: string | null, table: string): TableConfigRef => ({
  id, name, tableLogicalName: table, tableConfigType: type, parentTableConfigId: parent,
  lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
});
const R = "aaaaaaaa-0000-0000-0000-000000000001", O = "aaaaaaaa-0000-0000-0000-000000000002", C = "aaaaaaaa-0000-0000-0000-000000000003";
const NODES = { [R]: node(R, "Account", "RootTable", null, "account"), [O]: node(O, "Owner", "LookupTable", R, "systemuser"),
  [C]: node(C, "Contacts", "ChildTable", R, "contact") };
const META = fakeMetadata({
  account: [col({ logicalName: "name" })],
  contact: [col({ logicalName: "statecode", attributeType: "State" }), col({ logicalName: "fullname", displayName: "Full Name" }), col({ logicalName: "donotbulkemail", attributeType: "Boolean" })],
  task: [col({ logicalName: "subject" }), col({ logicalName: "regardingobjectid", attributeType: "Lookup" }), col({ logicalName: "statuscode", attributeType: "Status" })],
});

function handlers(): RuleEditorInspectorHandlers {
  return { onPatchRule: vi.fn(), onPatchGroup: vi.fn(), onPatchCondition: vi.fn(), onPatchAction: vi.fn(),
    onAddTranslation: vi.fn(), onUpdateTranslation: vi.fn(), onRemoveTranslation: vi.fn() };
}
function renderAction(over: Partial<ActionNode>, h = handlers(), nodes: Record<string, TableConfigRef> = NODES) {
  const graph = makeGraph({ tableConfigs: nodes, actions: [makeAction({ id: "a1", ...over })] });
  const { body } = ruleEditorInspectorContent(graph, { kind: "action", id: "a1" }, h);
  return { ...renderWithMeta(<SystemChoicesProvider>{body}</SystemChoicesProvider>, META), h };
}

describe("set actions in the action inspector", () => {
  it("offers collections as Update targets, labelled as each row", () => {
    renderAction({ actionType: "UpdateRecord", targetNodeId: null });
    fireEvent.click(screen.getByRole("combobox", { name: "Target node" }));
    expect(screen.getByRole("option", { name: "Contacts (each row)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Owner" })).toBeInTheDocument();
  });

  it("shows the Rows filter only on a set action, and hides Apply to previous there", () => {
    renderAction({ actionType: "UpdateRecord", targetNodeId: C });
    expect(screen.getByText("Every row.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit rows filter…" })).toBeInTheDocument();
    expect(screen.queryByText(/Also apply to the previous/)).toBeNull();
  });

  it("shows Apply to previous and hides the Rows filter on a single lookup target", () => {
    renderAction({ actionType: "UpdateRecord", targetNodeId: O });
    expect(screen.queryByRole("button", { name: "Edit rows filter…" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Also apply to the previous Owner when it changes" })).toBeInTheDocument();
  });

  it("opens the Rows filter dialog bound to the target node", () => {
    renderAction({ actionType: "UpdateRecord", targetNodeId: C });
    fireEvent.click(screen.getByRole("button", { name: "Edit rows filter…" }));
    expect(screen.getByText("Only write rows where…")).toBeInTheDocument();
    expect(screen.getByText("The action writes every row of Contacts that matches.")).toBeInTheDocument();
  });

  it("Create offers an optional For each row of picker with collections only", () => {
    const { h } = renderAction({ actionType: "CreateRecord", targetTable: "task" });
    fireEvent.click(screen.getByRole("combobox", { name: "For each row of" }));
    expect(screen.getByRole("option", { name: "(one record)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Contacts" }));
    expect(h.onPatchAction).toHaveBeenCalledWith("a1", { targetNodeId: C });
  });

  it("Create on a rule with no collection node has no For each row of picker", () => {
    renderAction({ actionType: "CreateRecord", targetTable: "task" }, handlers(), { [R]: NODES[R], [O]: NODES[O] });
    expect(screen.getByText("Target table")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "For each row of" })).toBeNull();
  });

  it("Create with a stale single-record target shows one record", () => {
    renderAction({ actionType: "CreateRecord", targetTable: "task", targetNodeId: O });
    expect(screen.getByRole("combobox", { name: "For each row of" })).toHaveTextContent("(one record)");
  });

  it("Deactivate is an action type and edits only the status reason", () => {
    renderAction({ actionType: "DeactivateRecord", targetNodeId: C });
    expect(screen.getByText("Status reason (optional)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit rows filter…" })).toBeInTheDocument();
  });
});

describe("the mapping dialog on a set action", () => {
  it("offers Current row only when the action writes a set of rows", async () => {
    renderWithMeta(<FieldMappingDialog open title="t" targetTable="task" ruleTable="account" tableConfigs={NODES}
      fieldMapping='[{"target":"subject","source":"literal","value":"x"}]' rowTable="contact" onCancel={() => {}} onApply={() => {}} />, META);
    fireEvent.click((await screen.findAllByTestId("fm-list-item"))[0]); // the detail pane shows the selected row
    fireEvent.click(screen.getByRole("combobox", { name: /^Source for/ }));
    expect(screen.getByRole("option", { name: "Current row" })).toBeInTheDocument();
  });

  it("does not offer Current row on a single action", async () => {
    renderWithMeta(<FieldMappingDialog open title="t" targetTable="task" ruleTable="account" tableConfigs={NODES}
      fieldMapping='[{"target":"subject","source":"literal","value":"x"}]' onCancel={() => {}} onApply={() => {}} />, META);
    fireEvent.click((await screen.findAllByTestId("fm-list-item"))[0]);
    fireEvent.click(screen.getByRole("combobox", { name: /^Source for/ }));
    expect(screen.queryByRole("option", { name: "Current row" })).toBeNull();
  });

  it("links a lookup to the current row itself", async () => {
    renderWithMeta(<FieldMappingDialog open title="t" targetTable="task" ruleTable="account" tableConfigs={NODES}
      fieldMapping='[{"target":"regardingobjectid","source":"row","column":"contactid"}]' rowTable="contact"
      onCancel={() => {}} onApply={() => {}} />, META);
    fireEvent.click((await screen.findAllByTestId("fm-list-item"))[0]);
    expect(await screen.findByRole("switch", { name: "Link to the current row itself" })).toBeChecked();
  });

  it("limits the columns to the allowed targets (Deactivate's status reason)", async () => {
    renderWithMeta(<FieldMappingDialog open title="t" targetTable="task" ruleTable="account" tableConfigs={NODES}
      fieldMapping='[{"target":null,"source":"literal","value":null}]' allowedTargets={["statuscode"]}
      onCancel={() => {}} onApply={() => {}} />, META);
    fireEvent.click((await screen.findAllByTestId("fm-list-item"))[0]);
    fireEvent.click(await screen.findByRole("combobox", { name: "Column 1" }));
    expect(screen.getByRole("option", { name: /statuscode/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /subject/ })).toBeNull();
  });
});

describe("current-row tokens", () => {
  it("Insert field offers the current row's columns as {row.<column>} tokens", async () => {
    const onInsert = vi.fn();
    renderWithMeta(<InsertFieldMenu ruleTable="account" tableConfigs={NODES} rowTable="contact" onInsert={onInsert} />, META);
    fireEvent.click(screen.getByRole("button", { name: "Insert field" }));
    fireEvent.click(await screen.findByText("Current row"));
    fireEvent.click(await screen.findByText("Full Name"));
    expect(onInsert).toHaveBeenCalledWith("{row.fullname}");
  });

  it("Insert field has no Current row without a row table", async () => {
    renderWithMeta(<InsertFieldMenu ruleTable="account" tableConfigs={NODES} onInsert={() => {}} />, META);
    fireEvent.click(screen.getByRole("button", { name: "Insert field" }));
    await screen.findByText("This record");
    expect(screen.queryByText("Current row")).toBeNull();
  });

  it("previews a row token with the row column's display name", async () => {
    renderWithMeta(<TemplateEditor value="Hi {row.fullname}" ruleTable="account" tableConfigs={NODES} rowTable="contact"
      onChange={() => {}} />, META);
    expect(await screen.findByText("Preview: Hi {Current row → Full Name}")).toBeInTheDocument();
  });
});
