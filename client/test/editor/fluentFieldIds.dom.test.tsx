import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Field } from "@fluentui/react-components";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { RecordSearchProvider } from "../../src/editor/ui/useRecordSearch";
import { col, fakeMetadata } from "./metaFixtures";
import { ColumnPicker, LookupPicker } from "../../src/editor/ui/pickers/MetadataPickers";
import { SystemChoicesProvider } from "../../src/editor/ui/useSystemChoices";
import { ruleEditorInspectorContent } from "../../src/editor/ui/inspectors/ruleEditorInspectorContent";
import { makeGraph, makeAction } from "./domFixtures";

// Regression pin for the Fluent id collision measured live against DEV
// (see e2e/editorA11yIds.e2e.spec.ts for the verbatim measurement).
//
// Root cause: Fluent's <Field> does NOT inject its generated control id by cloning its child.
// It publishes { generatedControlId, labelId, ... } on a React CONTEXT, and every Fluent
// control calls useFieldControlProps_unstable() and takes `id = generatedControlId` when it
// has no id of its own. So EVERY field-aware control anywhere in the Field's React subtree,
// including ones rendered through a portal (Dialog surfaces, Combobox popups), which stay in
// the React tree even though they leave the DOM tree, receives the SAME id, and the Field's
// <label for> then binds to whichever one the document-order lookup happens to hit.
//
// That is why the record picker's "Advanced filter" checkbox (which is not wrapped in a Field
// anywhere in our source) was observed carrying id="field-rr__control" and announcing as
// "Value": it was mounted inside <Field label="Value"><ValueEditor/></Field>.

function duplicateIds(): string[] {
  const seen = new Map<string, number>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[id]"))) {
    if (!el.id) continue;
    seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();
}

function labelTextFor(id: string): string | null {
  const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
  return label ? (label.textContent ?? "").trim() : null;
}

function lookupHarness() {
  const meta = fakeMetadata({});
  meta.lookupTargets = async () => ["account"];
  meta.tables = async () => [{
    logicalName: "account", displayName: "Account", entitySetName: "accounts",
    primaryNameAttribute: "name", primaryIdAttribute: "accountid", isCustom: false,
  }];
  meta.views = async () => [{
    id: "v1", name: "Active", isPersonal: false, isDefault: true,
    fetchXml: `<fetch><entity name="account"><attribute name="name" /></entity></fetch>`,
    columns: [{ logicalName: "name", displayName: "Name", width: 200 }],
  }];
  const records: any = {
    search: vi.fn(async () => []), resolveName: vi.fn(async () => null),
    queryByFetchXml: vi.fn(async () => [{ id: "g1", name: "Acme", entity: { accountid: "g1", name: "Acme" } }]),
  };
  // The real nesting from ConditionInspector: <Field label="Value"><ValueEditor/></Field>,
  // where ValueEditor delegates a lookup column to LookupPicker.
  render(
    <AppProvider>
      <MetadataProvider service={meta}>
        <RecordSearchProvider service={records}>
          <Field label="Value">
            <LookupPicker table="contact" column="parentcustomerid" value={null}
              onChange={vi.fn()} ariaLabel="Value" />
          </Field>
        </RecordSearchProvider>
      </MetadataProvider>
    </AppProvider>,
  );
}

describe("Fluent Field context does not leak generated ids across controls", () => {
  it("a dialog rendered inside a Field does not inherit the Field's control id", async () => {
    lookupHarness();
    fireEvent.click(await screen.findByRole("button", { name: /browse/i }));
    // The record picker is open once its "Advanced filter" checkbox is mounted.
    const checkbox = await screen.findByRole("checkbox", { name: "Advanced filter", hidden: true });

    // The measured symptom: the checkbox carried the "Value" Field's generated control id, so
    // the Field's <label for> named it "Value".
    expect(labelTextFor(checkbox.id)).not.toBe("Value");
    expect(checkbox.id).not.toMatch(/^field-.*__control$/);

    // And the invalid-HTML half: no two elements may share an id.
    expect(duplicateIds()).toEqual([]);
  });

  it("a Combobox popup's own controls do not inherit the Field's control id", async () => {
    const meta = fakeMetadata({ sample_order: [col({ logicalName: "sample_total" })] });
    render(
      <AppProvider>
        <MetadataProvider service={meta}>
          <Field label="Comparison column">
            <ColumnPicker table="sample_order" context="read" value={null}
              onChange={vi.fn()} ariaLabel="Comparison column" />
          </Field>
        </MetadataProvider>
      </AppProvider>,
    );
    const combobox = await screen.findByRole("combobox", { name: "Comparison column" });
    fireEvent.click(combobox);
    const checkbox = await screen.findByRole("checkbox", { name: "Custom columns only", hidden: true });

    expect(checkbox.id).not.toBe(combobox.id);
    expect(duplicateIds()).toEqual([]);
  });

  it("a Field wrapping a repeated group hands its id to at most one control", async () => {
    // ActionInspector's <Field label="Translations (fallback = message above)"> wraps one Input
    // per localized message plus the "+ add language" Dropdown: every one of them claimed the
    // same generated control id.
    const graph = makeGraph({
      actions: [makeAction({
        id: "a1", actionType: "ShowMessage", message: "hi", severity: 1,
        localizedMessages: [
          { id: "m1", languageCode: 1036, message: "bonjour" },
          { id: "m2", languageCode: 1031, message: "hallo" },
        ],
      })],
    });
    const { body } = ruleEditorInspectorContent(graph, { kind: "action", id: "a1" }, {
      onPatchRule: vi.fn(), onPatchGroup: vi.fn(), onPatchCondition: vi.fn(), onPatchAction: vi.fn(),
      onAddTranslation: vi.fn(), onUpdateTranslation: vi.fn(), onRemoveTranslation: vi.fn(),
    });
    render(
      <AppProvider>
        <MetadataProvider service={fakeMetadata({ account: [col({ logicalName: "name" })] })}>
          <SystemChoicesProvider>{body}</SystemChoicesProvider>
        </MetadataProvider>
      </AppProvider>,
    );
    await screen.findByLabelText("Show-message message");
    expect(duplicateIds()).toEqual([]);
  });
});
