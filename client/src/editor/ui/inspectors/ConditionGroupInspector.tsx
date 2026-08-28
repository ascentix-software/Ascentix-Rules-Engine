import { Dropdown, Option, Field, Input } from "@fluentui/react-components";
import type { ConditionGroupNode, LogicalOperatorLabel } from "../../model/types";

export function ConditionGroupInspector({
  group, onPatch,
}: { group: ConditionGroupNode; onPatch(patch: Partial<ConditionGroupNode>): void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Field label="Group name">
        <Input value={group.name} onChange={(_e, d) => onPatch({ name: d.value })} />
      </Field>
      <Field label="Logical operator">
        <Dropdown
          value={group.logicalOperator}
          selectedOptions={[group.logicalOperator]}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ logicalOperator: d.optionValue as LogicalOperatorLabel })}>
          <Option value="And">And</Option>
          <Option value="Or">Or</Option>
        </Dropdown>
      </Field>
    </div>
  );
}
