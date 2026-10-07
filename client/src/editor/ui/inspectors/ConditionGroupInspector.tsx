import { Dropdown, Option, Input } from "@fluentui/react-components";
import { InfoField } from "../primitives";
import type { ConditionGroupNode, LogicalOperatorLabel } from "../../model/types";

export function ConditionGroupInspector({
  group, outcome = false, onPatch,
}: { group: ConditionGroupNode; outcome?: boolean; onPatch(patch: Partial<ConditionGroupNode>): void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {outcome ? (
        // An outcome's name is how actions refer to it, so it can't be blank (asx_name is 100 long).
        <InfoField label="Outcome name" required info="Actions test this outcome by name. Must be unique in the rule; up to 100 characters."
          validationState={group.name.trim() === "" ? "error" : "none"}>
          <Input value={group.name} maxLength={100} onChange={(_e, d) => onPatch({ name: d.value })} />
        </InfoField>
      ) : (
        <InfoField label="Group name">
          <Input value={group.name} onChange={(_e, d) => onPatch({ name: d.value })} />
        </InfoField>
      )}
      <InfoField label="Logical operator">
        <Dropdown
          value={group.logicalOperator}
          selectedOptions={[group.logicalOperator]}
          onOptionSelect={(_e, d) => d.optionValue && onPatch({ logicalOperator: d.optionValue as LogicalOperatorLabel })}>
          <Option value="And">And</Option>
          <Option value="Or">Or</Option>
        </Dropdown>
      </InfoField>
    </div>
  );
}
