import { Text } from "@fluentui/react-components";
import type { ActionNode, TableConfigRef } from "../model/types";
import { actionSummary } from "./labels";

interface Props {
  actions: ActionNode[];
  tableConfigs: Record<string, TableConfigRef>;
}

export function ActionList({ actions, tableConfigs }: Props) {
  if (actions.length === 0) return <Text italic>(none)</Text>;
  return (
    <ol>
      {actions.map((a) => (
        <li key={a.id}><Text>{actionSummary(a, tableConfigs)}</Text></li>
      ))}
    </ol>
  );
}
