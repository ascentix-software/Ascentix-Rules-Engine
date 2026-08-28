import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "../../src/editor/ui/AppProvider";
import { MetadataProvider } from "../../src/editor/ui/useMetadata";
import { col, fakeMetadata } from "./metaFixtures";
import { NewRuleDialog } from "../../src/editor/ui/hub/NewRuleDialog";
import { NewConfigDialog } from "../../src/editor/ui/hub/NewConfigDialog";

// Guards the <OutsideField> barriers added to the dialog roots (see ui/fieldScope.tsx).
//
// Those barriers stop a dialog opened from inside a <Field> from inheriting that Field's
// generated control id. The barrier sits at the DIALOG ROOT, so every <Field> declared INSIDE
// the dialog must keep working: its own context is created below the barrier. Nothing proved
// that: these names are exercised only by e2e (hubActions.e2e), which runs against the DEPLOYED
// web resource, so a regression here would first appear in the post-deploy run that is meant to
// verify the id fix. Assert the exact role+name locators those specs use.

const meta = () => fakeMetadata({
  account: [col({ logicalName: "name", displayName: "Name" })],
});

const wrap = (ui: React.ReactElement) =>
  render(<AppProvider><MetadataProvider service={meta()}>{ui}</MetadataProvider></AppProvider>);

describe("dialog Fields keep naming their own controls through the OutsideField barrier", () => {
  it("NewRuleDialog: Name, Configuration, and the trigger checkboxes", async () => {
    wrap(
      <NewRuleDialog
        open
        configs={[{ id: "c1", name: "ZZ cfg", rootTableLogicalName: "account", nodeCount: 1,
          usedByCount: 0, modifiedOn: null, modifiedBy: null } as any]}
        onCancel={vi.fn()} onCreate={vi.fn()}
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Use an existing configuration" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Configuration" })).toBeInTheDocument();
    // A trigger checkbox: hubActions.e2e checks "Manual" by name.
    expect(screen.getByRole("checkbox", { name: "Manual" })).toBeInTheDocument();
  });

  it("NewConfigDialog: Name and Root table", async () => {
    wrap(<NewConfigDialog open onCancel={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByRole("textbox", { name: "Name" })).toBeInTheDocument();
    // TablePicker's Combobox is the control the "Root table" Field labels.
    expect(screen.getByRole("combobox", { name: "Root table" })).toBeInTheDocument();
  });
});
