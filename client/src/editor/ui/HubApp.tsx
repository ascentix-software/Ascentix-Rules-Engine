import * as React from "react";
import { SearchBox, Dropdown, Option, Button, TabList, Tab } from "@fluentui/react-components";
import { Add16Regular, Copy16Regular, Delete16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { ScreenShell } from "./ScreenShell";
import { navigate } from "./router";
import { useIsWide } from "./useIsWide";
import { StatusBadge, NodeTag, Eyebrow, Pill, Callout } from "./primitives";
import { color } from "./tokens";
import { useEditorStyles } from "./styles";
import { triggerLabel } from "../model/enums";
import { relativeTime } from "./hubFormat";
import { ListFooter } from "./ListFooter";
import type { RuleListItem, ConfigListItem } from "../load/hubData";
import type { EditorApi } from "../webapi";
import { loadHubData } from "../load/hubData";
import {
  createRule, createConfig, duplicateRule, duplicateConfig, deleteRule, deleteConfig,
} from "../save/operations";
import { NewRuleDialog } from "./hub/NewRuleDialog";
import { NewConfigDialog } from "./hub/NewConfigDialog";
import { ConfirmDeleteDialog } from "./hub/ConfirmDeleteDialog";
import { activateOnKey } from "./keyboard";
import { formatError } from "./errors";

const PAGE_SIZE_DEFAULT = 10;
const RULES_COLS = "2.5fr 1fr 0.95fr 1.25fr 0.8fr 1.15fr 92px";
const CONFIG_COLS = "2.5fr 1.1fr 0.9fr 1.1fr 1.15fr 92px";

interface RowCell { label: string; node: React.ReactNode; }

function RowView({ cols, cells, onClick, dim, stacked }: {
  cols: string; cells: RowCell[]; onClick(): void; dim?: boolean; stacked: boolean;
}) {
  const [h, setH] = React.useState(false);
  const bg = h ? color.canvas : color.surface;
  const op = dim && !h ? 0.72 : 1;
  if (stacked) {
    const [primary, ...rest] = cells;
    const actions = rest[rest.length - 1];
    const middle = rest.slice(0, -1);
    return (
      <div data-testid="hub-card" role="button" tabIndex={0}
        onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick}
        onKeyDown={activateOnKey(onClick)}
        style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px",
          borderBottom: `1px solid ${color.line}`, cursor: "pointer", background: bg, opacity: op }}>
        {primary.node}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {middle.filter((c) => c.label).map((c) => (
            <div key={c.label} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5 }}>
              <span style={{ color: color.inkMuted, fontWeight: 600, minWidth: 76 }}>{c.label}</span>
              <span>{c.node}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 2 }}>{actions.node}</div>
      </div>
    );
  }
  return (
    <div data-testid="hub-row" role="button" tabIndex={0}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} onClick={onClick}
      onKeyDown={activateOnKey(onClick)}
      style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "12px 16px", alignItems: "center",
        borderBottom: `1px solid ${color.line}`, cursor: "pointer", background: bg, opacity: op }}>
      {cells.map((c, i) => <React.Fragment key={c.label || i}>{c.node}</React.Fragment>)}
    </div>
  );
}

function GridCard({ cols, headers, stacked, children }: {
  cols: string; headers: string[]; stacked: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ background: color.surface, border: `1px solid ${color.line}`, borderRadius: 12, boxShadow: "0 1px 3px rgba(0,0,0,.05)", overflow: "hidden" }}>
      {!stacked && (
        <div data-testid="hub-grid-header" style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "10px 16px", background: color.canvas, borderBottom: `1px solid ${color.line}` }}>
          {headers.map((h) => <Eyebrow key={h}>{h}</Eyebrow>)}
        </div>
      )}
      {children}
    </div>
  );
}

const distinct = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).sort();

export function HubApp({ api, rules: initialRules, configs: initialConfigs, truncated: initialTruncated }: {
  api: EditorApi; rules: RuleListItem[]; configs: ConfigListItem[]; truncated?: boolean;
}) {
  const styles = useEditorStyles();
  const stacked = !useIsWide(900);
  const [rules, setRules] = React.useState(initialRules);
  const [configs, setConfigs] = React.useState(initialConfigs);
  const [truncated, setTruncated] = React.useState(initialTruncated ?? false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [newRuleOpen, setNewRuleOpen] = React.useState(false);
  const [newConfigOpen, setNewConfigOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<{ kind: "rule" | "config"; id: string; name: string } | null>(null);
  const now = Date.now();
  const [tab, setTab] = React.useState<"rules" | "configs">("rules");
  const [search, setSearch] = React.useState("");
  const [ruleTable, setRuleTable] = React.useState("all");
  const [ruleStatus, setRuleStatus] = React.useState("all");
  const [configRoot, setConfigRoot] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(PAGE_SIZE_DEFAULT);

  const reset = () => setPage(1);
  const switchTab = (t: "rules" | "configs") => { setTab(t); setSearch(""); reset(); };

  const q = search.trim().toLowerCase();
  const filteredRules = rules.filter((r) =>
    (!q || r.name.toLowerCase().includes(q)) &&
    (ruleTable === "all" || r.tableLogicalName === ruleTable) &&
    (ruleStatus === "all" || String(r.statusCode) === ruleStatus));
  const filteredConfigs = configs.filter((c) =>
    (!q || c.name.toLowerCase().includes(q)) &&
    (configRoot === "all" || c.rootTableLogicalName === configRoot));

  const list = tab === "rules" ? filteredRules : filteredConfigs;
  const total = list.length;
  const start = (page - 1) * pageSize;
  const pageRules = filteredRules.slice(start, start + pageSize);
  const pageConfigs = filteredConfigs.slice(start, start + pageSize);

  const modified = (on: string | null, by: string | null) =>
    `${relativeTime(on, now)}${by ? ` · ${by}` : ""}`;

  async function run(op: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await op(); } catch (e) { setError(formatError(e)); } finally { setBusy(false); }
  }
  async function refresh() {
    const data = await loadHubData(api);
    setRules(data.rules); setConfigs(data.configs); setTruncated(data.truncated);
  }
  const onCreateRule = (args: { name: string; table: string; triggers: number[]; existingRootId?: string; newConfigName?: string }) =>
    run(async () => { const id = await createRule(api, args); navigate("rule", id); });
  const onCreateConfig = (args: { name: string; table: string }) =>
    run(async () => { const id = await createConfig(api, args); navigate("tableconfig", id); });
  const onDuplicateRule = (id: string) => run(async () => navigate("rule", await duplicateRule(api, id)));
  const onDuplicateConfig = (id: string) => run(async () => navigate("tableconfig", await duplicateConfig(api, id)));
  const onConfirmDelete = () => {
    const pd = pendingDelete;
    if (!pd) return;
    setPendingDelete(null);
    void (async () => {
      setBusy(true); setError(null);
      try {
        await (pd.kind === "rule" ? deleteRule(api, pd.id) : deleteConfig(api, pd.id));
      } catch (e) { setError(`Delete failed: ${formatError(e)}`); setBusy(false); return; }
      try { await refresh(); } catch (e) { setError(`Deleted. List refresh failed: ${formatError(e)}`); }
      setBusy(false);
    })();
  };

  return (
    <AppProvider>
      <ScreenShell
        header={
          <div style={{ padding: "20px 24px 0", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})` }}>
            <Eyebrow>Power Apps · Rules Engine</Eyebrow>
            <h1 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-.015em", color: color.ink, margin: "2px 0 2px" }}>Rules &amp; data model</h1>
            <div style={{ fontSize: 13.5, color: color.inkMuted }}>Browse rules and the shared table configurations they traverse.</div>
          </div>
        }
      >
        <div style={{ padding: "0 24px 24px" }}>
          {error && (
            <div style={{ marginTop: 12 }}>
              <Callout intent="danger">{error}</Callout>
            </div>
          )}
          {truncated && (
            <div style={{ marginTop: 12 }} data-testid="hub-truncation-warning">
              <Callout intent="warning">
                This environment has more rows than the hub loaded (page ceiling reached). The
                lists and counts below are incomplete.
              </Callout>
            </div>
          )}

          {/* Tabs */}
          <div style={{ borderBottom: `1px solid ${color.line}`, margin: "18px 0 16px" }}>
            <TabList selectedValue={tab} onTabSelect={(_e, d) => switchTab(d.value as "rules" | "configs")}>
              <Tab value="rules">
                Rules <Pill tone={tab === "rules" ? "info" : "neutral"}>{rules.length}</Pill>
              </Tab>
              <Tab value="configs">
                Table configurations <Pill tone={tab === "configs" ? "info" : "neutral"}>{configs.length}</Pill>
              </Tab>
            </TabList>
          </div>

          {/* Command bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <Button appearance="primary" icon={<Add16Regular />} disabled={busy}
              onClick={() => (tab === "rules" ? setNewRuleOpen(true) : setNewConfigOpen(true))}>
              {tab === "rules" ? "New rule" : "New table configuration"}
            </Button>
            <SearchBox placeholder={tab === "rules" ? "Search rules" : "Search configurations"} value={search}
              onChange={(_e, d) => { setSearch(d.value); reset(); }} style={{ minWidth: 240 }} />
            {tab === "rules" ? (
              <>
                <Dropdown style={{ marginLeft: stacked ? 0 : "auto", minWidth: 150 }} value={ruleTable === "all" ? "Table: All" : `Table: ${ruleTable}`}
                  selectedOptions={[ruleTable]} onOptionSelect={(_e, d) => { d.optionValue && setRuleTable(d.optionValue); reset(); }}>
                  <Option value="all">Table: All</Option>
                  {distinct(rules.map((r) => r.tableLogicalName)).map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Dropdown>
                <Dropdown style={{ minWidth: 150 }} value={ruleStatus === "all" ? "Status: All"
                  : ruleStatus === "1" ? "Status: Draft" : ruleStatus === "753840000" ? "Status: Published" : "Status: Archived"}
                  selectedOptions={[ruleStatus]} onOptionSelect={(_e, d) => { d.optionValue && setRuleStatus(d.optionValue); reset(); }}>
                  <Option value="all">Status: All</Option>
                  <Option value="1">Draft</Option>
                  <Option value="753840000">Published</Option>
                  <Option value="2">Archived</Option>
                </Dropdown>
              </>
            ) : (
              <Dropdown style={{ marginLeft: stacked ? 0 : "auto", minWidth: 170 }} value={configRoot === "all" ? "Root table: All" : `Root table: ${configRoot}`}
                selectedOptions={[configRoot]} onOptionSelect={(_e, d) => { d.optionValue && setConfigRoot(d.optionValue); reset(); }}>
                <Option value="all">Root table: All</Option>
                {distinct(configs.map((c) => c.rootTableLogicalName)).map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            )}
          </div>

          {tab === "configs" && (
            <div style={{ marginBottom: 12 }}>
              <Callout intent="info">Table configurations are shared. Editing one affects every rule that uses it, and a configuration in use can't be deleted.</Callout>
            </div>
          )}

          {/* Grid */}
          {tab === "rules" ? (
            <GridCard cols={RULES_COLS} headers={["Rule", "Table", "Status", "Triggers", "Actions", "Modified", ""]} stacked={stacked}>
              {pageRules.length === 0
                ? <div style={{ padding: 24, textAlign: "center", color: color.inkMuted, fontSize: 13 }}>No rules match.</div>
                : pageRules.map((r) => {
                  const cells: RowCell[] = [
                    { label: "Rule", node: (
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: color.ink }}>{r.name}</div>
                        <div style={{ fontSize: 12, color: color.inkMuted }}>uses{" "}
                          {r.rootConfigId
                            ? <button type="button" className={styles.focusRing} onClick={(e) => { e.stopPropagation(); navigate("tableconfig", r.rootConfigId!); }}
                                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: color.brandInk, fontWeight: 600, fontSize: 12 }}>{r.rootConfigName ?? r.rootConfigId}</button>
                            : <span style={{ color: color.inkMuted }}>—</span>}
                        </div>
                      </div>
                    ) },
                    { label: "Table", node: <span><NodeTag>{r.tableLogicalName}</NodeTag></span> },
                    { label: "Status", node: <span><StatusBadge statusCode={r.statusCode} /></span> },
                    { label: "Triggers", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{r.triggers.map(triggerLabel).join(", ") || "—"}</span> },
                    { label: "Actions", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{r.actionCount}</span> },
                    { label: "Modified", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{modified(r.modifiedOn, r.modifiedBy)}</span> },
                    { label: "", node: (
                      <span style={{ display: "flex", gap: 2, justifyContent: stacked ? "flex-start" : "flex-end" }} onClick={(e) => e.stopPropagation()}>
                        <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Duplicate" title="Duplicate" disabled={busy} onClick={() => onDuplicateRule(r.id)} />
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete" title="Delete" disabled={busy} style={{ color: color.danger }} onClick={() => setPendingDelete({ kind: "rule", id: r.id, name: r.name })} />
                      </span>
                    ) },
                  ];
                  return <RowView key={r.id} cols={RULES_COLS} cells={cells} dim={r.statusCode === 2} stacked={stacked} onClick={() => navigate("rule", r.id)} />;
                })}
            </GridCard>
          ) : (
            <GridCard cols={CONFIG_COLS} headers={["Configuration", "Root table", "Nodes", "Used by", "Modified", ""]} stacked={stacked}>
              {pageConfigs.length === 0
                ? <div style={{ padding: 24, textAlign: "center", color: color.inkMuted, fontSize: 13 }}>No configurations match.</div>
                : pageConfigs.map((c) => {
                  const cells: RowCell[] = [
                    { label: "Configuration", node: (
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: color.ink }}>{c.name}</div>
                        <div style={{ fontSize: 12, color: color.inkMuted }}>{c.rootTableLogicalName}</div>
                      </div>
                    ) },
                    { label: "Root table", node: <span><NodeTag>{c.rootTableLogicalName}</NodeTag></span> },
                    { label: "Nodes", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{c.nodeCount} nodes</span> },
                    { label: "Used by", node: (
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: c.usedByCount > 0 ? color.brandInk : color.inkMuted }}>
                        {c.usedByCount > 0 ? `${c.usedByCount} rules` : "Unused"}
                      </span>
                    ) },
                    { label: "Modified", node: <span style={{ fontSize: 12.5, color: color.inkMuted }}>{modified(c.modifiedOn, c.modifiedBy)}</span> },
                    { label: "", node: (
                      <span style={{ display: "flex", gap: 2, justifyContent: stacked ? "flex-start" : "flex-end" }} onClick={(e) => e.stopPropagation()}>
                        <Button size="small" appearance="subtle" icon={<Copy16Regular />} aria-label="Duplicate" title="Duplicate" disabled={busy} onClick={() => onDuplicateConfig(c.id)} />
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete"
                          title={c.usedByCount > 0 ? "In use, can't delete" : "Delete"}
                          disabled={busy || c.usedByCount > 0} style={{ color: c.usedByCount > 0 ? undefined : color.danger }}
                          onClick={() => setPendingDelete({ kind: "config", id: c.id, name: c.name })} />
                      </span>
                    ) },
                  ];
                  return <RowView key={c.id} cols={CONFIG_COLS} cells={cells} stacked={stacked} onClick={() => navigate("tableconfig", c.id)} />;
                })}
            </GridCard>
          )}

          <ListFooter total={total} page={page} pageSize={pageSize}
            onPage={setPage} onPageSize={(n) => { setPageSize(n); reset(); }}
            noun={tab === "rules" ? "rules" : "configurations"} />
          <NewRuleDialog open={newRuleOpen} configs={configs}
            onCancel={() => setNewRuleOpen(false)}
            onCreate={(args) => { setNewRuleOpen(false); onCreateRule(args); }} />
          <NewConfigDialog open={newConfigOpen}
            onCancel={() => setNewConfigOpen(false)}
            onCreate={(args) => { setNewConfigOpen(false); onCreateConfig(args); }} />
          <ConfirmDeleteDialog open={!!pendingDelete} name={pendingDelete?.name ?? ""}
            onCancel={() => setPendingDelete(null)} onConfirm={onConfirmDelete} />
        </div>
      </ScreenShell>
    </AppProvider>
  );
}
