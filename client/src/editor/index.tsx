import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createWebApiPort } from "./webapi";
import { loadRuleEditorGraph } from "./load/ruleEditorGraph";
import { loadConfigGraph } from "./load/tableConfigEditor";
import { loadHubData } from "./load/hubData";
import { loadValueLabels } from "./load/valueLabels";
import { createMetadataService } from "./metadata";
import { createRecordSearchService } from "./records";
import { RuleEditorApp } from "./ui/RuleEditorApp";
import { HubApp } from "./ui/HubApp";
import { TableConfigApp } from "./ui/TableConfigApp";
import { HelpApp } from "./help/HelpApp";
import { MetadataProvider } from "./ui/useMetadata";
import { RecordSearchProvider } from "./ui/useRecordSearch";
import { SystemChoicesProvider } from "./ui/useSystemChoices";
import { resolveRoute, type View } from "./ui/router";
import { ErrorBoundary, ErrorPanel, formatError, installLastResortRejectionHandler } from "./ui/errors";

// Kept exported so the toolchain test still has a stable symbol.
export const EDITOR_BUNDLE = "asx_ruleeditor";

// The documented standalone-URL degradation (Rule-Editor.md §3): a raw web-resource
// URL gets no Xrm Client API, and the page must say so instead of crashing.
const NO_XRM_HINT =
  "The editor must be opened from within a model-driven app. A standalone " +
  "web-resource URL gets no Xrm Client API. Launch it from the Rules Engine app.";

function missingId(kind: string) {
  return <div style={{ padding: 16 }}>No {kind} id supplied (expected ?id=&lt;guid&gt;).</div>;
}

// Tolerant Xrm lookup for the help route: unlike webapi.ts's resolveXrm(), this
// never throws: the help viewer must still render (with degraded images) when
// run standalone/outside Dataverse.
function resolveClientUrl(): string {
  try {
    const x = (window.parent as any)?.Xrm ?? (window as any).Xrm;
    return x?.Utility?.getGlobalContext?.().getClientUrl?.() ?? "";
  } catch {
    return "";
  }
}

async function renderView(root: Root) {
  const route = resolveRoute(window.location.search);
  // help.html sets this global so it lands on the help route without query-param
  // plumbing; only takes effect when the query string didn't already resolve a view.
  const initialView = (window as any).__ASX_INITIAL_VIEW as View | undefined;
  const view: View = route.view === "hub" && initialView ? initialView : route.view;

  // The help viewer needs no Dataverse api port, so it's rendered before
  // createWebApiPort() runs. It must still work standalone, outside Dataverse.
  if (view === "help") {
    root.render(
      <ErrorBoundary area="help viewer">
        <HelpApp getClientUrl={resolveClientUrl} />
      </ErrorBoundary>,
    );
    return;
  }

  const api = createWebApiPort();
  const service = createMetadataService(api);
  const records = createRecordSearchService(api, service);

  const withProviders = (area: string, child: ReactNode) => (
    <ErrorBoundary area={area}>
      <MetadataProvider service={service}>
        <RecordSearchProvider service={records}>
          <SystemChoicesProvider>{child}</SystemChoicesProvider>
        </RecordSearchProvider>
      </MetadataProvider>
    </ErrorBoundary>
  );

  if (view === "hub") {
    try {
      const data = await loadHubData(api);
      root.render(withProviders("hub",
        <HubApp api={api} rules={data.rules} configs={data.configs} truncated={data.truncated} />));
    } catch (e) {
      root.render(<ErrorPanel title="The hub could not load." error={e} />);
    }
    return;
  }

  if (route.view === "tableconfig") {
    if (!route.id) { root.render(missingId("table configuration")); return; }
    const cfgId = route.id;
    try {
      const reload = () => loadConfigGraph(api, cfgId);
      const { graph, usage } = await reload();
      root.render(withProviders("configuration editor",
        <TableConfigApp initialGraph={graph} initialUsage={usage} api={api} reload={reload} />,
      ));
    } catch (e) {
      root.render(<ErrorPanel title="The table configuration could not load." error={e} />);
    }
    return;
  }

  // route.view === "rule"
  if (!route.id) { root.render(missingId("rule")); return; }
  const ruleId = route.id;
  try {
    const reload = () => loadRuleEditorGraph(api, ruleId);
    const graph = await reload();
    const valueLabels = await loadValueLabels(service, graph);
    root.render(withProviders("rule editor",
      <RuleEditorApp
        initialGraph={graph}
        api={api}
        reload={reload}
        initialValueLabels={valueLabels}
        loadValueLabels={(g) => loadValueLabels(service, g)}
      />,
    ));
  } catch (e) {
    root.render(<ErrorPanel title="The rule could not load." error={e} />);
  }
}

async function main() {
  const host = document.getElementById("root");
  if (!host) return;
  const root = createRoot(host);

  const bootPanel = (e: unknown) => root.render(
    <ErrorPanel
      title="The editor could not start."
      error={e}
      hint={/Xrm\.WebApi/.test(formatError(e)) ? NO_XRM_HINT : undefined}
    />,
  );
  installLastResortRejectionHandler(host, bootPanel);

  try {
    await renderView(root);
  } catch (e) {
    // Catches createWebApiPort() (no Xrm) and anything route dispatch throws.
    bootPanel(e);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void main());
  } else {
    void main();
  }
}
