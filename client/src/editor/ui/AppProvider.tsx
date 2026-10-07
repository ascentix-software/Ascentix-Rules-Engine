import * as React from "react";
import { FluentProvider } from "@fluentui/react-components";
import { ascentixTheme } from "./tokens";
import { NotifyToaster } from "./notify";

const InsideAppProvider = React.createContext(false);

/**
 * The single FluentProvider for every editor entry point.
 *
 * Use this instead of <FluentProvider theme={webLightTheme}>: the raw Fluent
 * theme renders blue primaries and Segoe UI controls, which clash with the
 * Ascentix palette and type.
 *
 * The outermost provider also mounts the one Toaster (useNotify). A nested
 * provider (a screen rendered inside a test wrapper) doesn't mount a second
 * one, so a toast never shows twice.
 */
export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const nested = React.useContext(InsideAppProvider);
  return (
    <FluentProvider theme={ascentixTheme}>
      <InsideAppProvider.Provider value={true}>
        {children}
        {!nested && <NotifyToaster />}
      </InsideAppProvider.Provider>
    </FluentProvider>
  );
};
