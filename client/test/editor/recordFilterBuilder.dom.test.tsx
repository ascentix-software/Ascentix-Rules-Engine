import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { RecordFilterBuilder } from "../../src/editor/ui/pickers/RecordFilterBuilder";
import { emptyGroup, type FilterGroup } from "../../src/editor/ui/pickers/recordFilter";

const meta = fakeMetadata({ account: [col({ logicalName: "name", displayName: "Account name" })] });

describe("RecordFilterBuilder", () => {
  it("adds a condition row when 'Add condition' is clicked", async () => {
    const onChange = vi.fn();
    let value: FilterGroup = { kind: "group", op: "and", rules: [] };
    renderWithMeta(<RecordFilterBuilder table="account" value={value} onChange={onChange} />, meta);
    fireEvent.click(await screen.findByRole("button", { name: /add condition/i }));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0][0] as FilterGroup;
    expect(next.rules).toHaveLength(1);
    expect(next.rules[0].kind).toBe("rule");
  });

  it("toggles the group operator between AND and OR", async () => {
    const onChange = vi.fn();
    renderWithMeta(<RecordFilterBuilder table="account" value={emptyGroup()} onChange={onChange} />, meta);
    fireEvent.click(await screen.findByRole("button", { name: /^or$/i }));
    expect((onChange.mock.calls[0][0] as FilterGroup).op).toBe("or");
  });

  it("removes a condition row", async () => {
    const onChange = vi.fn();
    renderWithMeta(<RecordFilterBuilder table="account" value={emptyGroup()} onChange={onChange} />, meta);
    fireEvent.click(await screen.findByRole("button", { name: /remove condition/i }));
    expect((onChange.mock.calls[0][0] as FilterGroup).rules).toHaveLength(0);
  });
});
