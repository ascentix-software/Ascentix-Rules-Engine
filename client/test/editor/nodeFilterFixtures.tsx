import * as React from "react";
import { col, fakeMetadata, renderWithMeta } from "./metaFixtures";
import { NodeFilterBuilder } from "../../src/editor/ui/inspectors/NodeFilterBuilder";
import type { NodeFilterGroupModel } from "../../src/editor/model/nodeFilter";
import type { TableConfigRef } from "../../src/editor/model/types";

// Shared tree for both the exists-suite (existsCriterion.dom.test.tsx) and the grouped-spine
// suite (nodeFilterSpine.dom.test.tsx), so the two files can't silently drift onto two
// different notions of "the fixture". Root (Account, single-cardinality) has:
//   - "owner": a single-cardinality LOOKUP-chain node (Account -> Contact): the From-record
//     value-source picker's node list needs at least one non-root single-cardinality option.
//   - "lines": a child collection, the EXISTS/From-record current-node target in existsCriterion.
//   - "notes": a SIBLING child collection, the only valid EXISTS target from "lines".
export const TABLE_CONFIGS: Record<string, TableConfigRef> = {
  root: {
    id: "root", name: "Account", tableLogicalName: "account", tableConfigType: "RootTable",
    parentTableConfigId: null, lookupColumnLogicalName: null, childLinkField: null, lookupTargetIdAttribute: null,
  },
  owner: {
    id: "owner", name: "Owner", tableLogicalName: "contact", tableConfigType: "LookupTable",
    parentTableConfigId: "root", lookupColumnLogicalName: "primarycontactid", childLinkField: null,
    lookupTargetIdAttribute: "contactid",
  },
  lines: {
    id: "lines", name: "Order lines", tableLogicalName: "account_line", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "accountid", lookupTargetIdAttribute: null,
  },
  notes: {
    id: "notes", name: "Notes", tableLogicalName: "account_note", tableConfigType: "ChildTable",
    parentTableConfigId: "root", lookupColumnLogicalName: null, childLinkField: "accountid", lookupTargetIdAttribute: null,
  },
};
export const TC_LIST = Object.values(TABLE_CONFIGS);

export const META = fakeMetadata({
  account: [col({ logicalName: "name", displayName: "Account name" })],
  contact: [col({ logicalName: "fullname", displayName: "Full name" })],
  account_line: [col({ logicalName: "amount", displayName: "Amount", attributeType: "Money" })],
  account_note: [col({ logicalName: "body", displayName: "Body" })],
});

// Stateful harness: like the real editor, applies onChange back into the value it renders.
function Harness({ initial, table, currentNodeId, scalarOnly }: {
  initial: NodeFilterGroupModel; table: string; currentNodeId: string | null; scalarOnly?: boolean;
}) {
  const [value, setValue] = React.useState(initial);
  return (
    <NodeFilterBuilder table={table} tableConfigs={TABLE_CONFIGS} tcList={TC_LIST}
      currentNodeId={currentNodeId} scalarOnly={scalarOnly} value={value} onChange={setValue} />
  );
}

export function renderNodeFilterHarness(props: {
  initial: NodeFilterGroupModel; table: string; currentNodeId: string | null; scalarOnly?: boolean;
}) {
  return renderWithMeta(<Harness {...props} />, META);
}
