import * as React from "react";
import type { MetadataService } from "../metadata";

const MetadataContext = React.createContext<MetadataService | null>(null);

export function MetadataProvider(props: { service: MetadataService; children: React.ReactNode }) {
  return React.createElement(MetadataContext.Provider, { value: props.service }, props.children);
}

export function useMetadataService(): MetadataService {
  const svc = React.useContext(MetadataContext);
  if (!svc) throw new Error("MetadataProvider is missing");
  return svc;
}
