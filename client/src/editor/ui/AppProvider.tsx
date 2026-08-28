import * as React from "react";
import { FluentProvider } from "@fluentui/react-components";
import { ascentixTheme } from "./tokens";

/**
 * The single FluentProvider for every editor entry point.
 *
 * Use this instead of <FluentProvider theme={webLightTheme}>: the raw Fluent
 * theme renders blue primaries and Segoe UI controls, which clash with the
 * Ascentix palette and type.
 */
export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <FluentProvider theme={ascentixTheme}>{children}</FluentProvider>
);
