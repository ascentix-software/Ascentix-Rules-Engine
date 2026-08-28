import * as React from "react";
import type { RecordSearchService } from "../records";

const RecordSearchContext = React.createContext<RecordSearchService | null>(null);

export function RecordSearchProvider(props: { service: RecordSearchService; children: React.ReactNode }) {
  return React.createElement(RecordSearchContext.Provider, { value: props.service }, props.children);
}

export function useRecordSearch(): RecordSearchService {
  const svc = React.useContext(RecordSearchContext);
  if (!svc) throw new Error("RecordSearchProvider is missing");
  return svc;
}
