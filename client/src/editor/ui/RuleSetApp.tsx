import * as React from "react";
import { Button, Field, Input, Textarea, Tooltip, Link } from "@fluentui/react-components";
import { Add16Regular, Delete16Regular, SubtractCircle16Regular, Checkmark16Regular } from "@fluentui/react-icons";
import { AppProvider } from "./AppProvider";
import { ScreenShell } from "./ScreenShell";
import { Breadcrumb, type Crumb } from "./Breadcrumb";
import { navigate, navigateHubTab } from "./router";
import { useIsWide } from "./useIsWide";
import { Callout, Eyebrow, NodeTag, Pill, StatusBadge } from "./primitives";
import { color } from "./tokens";
import { relativeTime, envHost, shortDate } from "./hubFormat";
import { formatError } from "./errors";
import { useNotify } from "./notify";
import { OutsideField } from "./fieldScope";
import { RowView, GridCard, type RowCell } from "./hub/HubGrid";
import { AddRulesDialog } from "./hub/AddRulesDialog";
import { ConfirmDeleteDialog } from "./hub/ConfirmDeleteDialog";
import { useDataUpdates } from "../dataUpdates/DataUpdateContext";
import { DataUpdateBanner } from "../dataUpdates/DataUpdateBanner";
import { loadHubData, type HubData, type RuleSetItem } from "../load/hubData";
import { isDuplicateRuleSetName, ruleSetErrorMessage } from "../save/ruleSetWrites";
import type { EditorApi } from "../webapi";

const COLS = "2.4fr 1fr 0.9fr 1.2fr 56px";
const DELETE_SET_BLOCKED = "Move or remove its rules first.";
const CRUMBS: Crumb[] = [
  { label: "Rules & data model", view: "hub" },
  { label: "Rule sets", view: "hub", tab: "rulesets" },
];
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const panel: React.CSSProperties = {
  border: `1px solid ${color.line}`, borderRadius: 12, padding: 16, background: color.surface,
  display: "flex", flexDirection: "column", gap: 12,
};

/** One rule set: its rules (add, remove), its details (saved on blur) and its import stamp. */
export function RuleSetApp({ api, ruleSetId, data: initialData }: { api: EditorApi; ruleSetId: string; data: HubData }) {
  const { readOnly } = useDataUpdates();
  const stacked = !useIsWide(900);
  const notify = useNotify();
  const [data, setData] = React.useState(initialData);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const now = Date.now();

  const set = data.ruleSets.find((s) => s.id === ruleSetId) ?? null;
  const inSet = data.rules.filter((r) => r.ruleSetId === ruleSetId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const ruleSetsById = React.useMemo(() => new Map(data.ruleSets.map((s) => [s.id, s])), [data.ruleSets]);

  async function refresh() {
    try { setData(await loadHubData(api)); } catch (e) { setError(`Saved. Refresh failed: ${formatError(e)}`); }
  }

  if (!set) {
    return (
      <AppProvider>
        <ScreenShell aboveCard={<Breadcrumb segments={CRUMBS} current="Rule set" />}
          header={<div style={{ padding: "20px 24px 0" }}><Eyebrow>Rule set</Eyebrow></div>}>
          <div style={{ padding: "12px 24px 24px", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <div style={{ fontSize: 14, color: color.ink }}>This rule set no longer exists.</div>
            <Link as="button" onClick={() => navigateHubTab("rulesets")}>Back to rule sets</Link>
          </div>
        </ScreenShell>
      </AppProvider>
    );
  }

  const canMove = !readOnly && !!api.moveRules;
  const canEdit = !readOnly && !!api.updateRuleSet;
  const canDelete = !readOnly && !!api.deleteRuleSet;
  const blocked = inSet.length > 0;

  const onRemove = (ruleId: string) => {
    void (async () => {
      setBusy(true); setError(null);
      try {
        await api.moveRules!([ruleId], null);
      } catch (e) {
        setError(formatError(e)); setBusy(false); return;
      }
      notify.undo(`Removed from ${set.name}`, () => {
        void (async () => {
          setBusy(true); setError(null);
          try { await api.moveRules!([ruleId], set.id); } catch (e) { setError(formatError(e)); setBusy(false); return; }
          await refresh();
          setBusy(false);
        })();
      });
      await refresh();
      setBusy(false);
    })();
  };

  // Rejects back into the dialog, which shows the reason and stays open.
  async function onAdd(ruleIds: string[]) {
    await api.moveRules!(ruleIds, set!.id);
    setAddOpen(false);
    notify.success(`Added ${plural(ruleIds.length, "rule")} to ${set!.name}`);
    setBusy(true); setError(null);
    await refresh();
    setBusy(false);
  }

  const onConfirmDelete = () => {
    setConfirmDelete(false);
    void (async () => {
      setBusy(true); setError(null);
      try {
        await api.deleteRuleSet!(set.id);
      } catch (e) {
        setError(`Delete failed: ${ruleSetErrorMessage(e)}`); setBusy(false); return;
      }
      navigateHubTab("rulesets");
    })();
  };

  const deleteButton = (
    <Button appearance="outline" icon={<Delete16Regular />} disabled={busy}
      disabledFocusable={blocked} aria-description={blocked ? DELETE_SET_BLOCKED : undefined}
      style={{ color: blocked ? undefined : color.danger }} onClick={() => setConfirmDelete(true)}>
      Delete
    </Button>
  );

  const addButton = (
    <Button appearance="primary" icon={<Add16Regular />} disabled={busy} onClick={() => setAddOpen(true)}>Add rules</Button>
  );

  const rulesSection = (
    <section aria-labelledby="rs-rules" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h2 id="rs-rules" style={{ margin: 0, fontSize: 16, fontWeight: 700, color: color.ink, display: "flex", alignItems: "center", gap: 8 }}>
          Rules <Pill tone="info">{inSet.length}</Pill>
        </h2>
        {canMove && addButton}
      </div>
      <GridCard cols={COLS} headers={["Rule", "Table", "Status", "Modified", ""]} stacked={stacked}>
        {inSet.length === 0 ? (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <div style={{ color: color.inkMuted, fontSize: 13 }}>No rules in this set</div>
            {canMove && addButton}
          </div>
        ) : inSet.map((r) => {
          const cells: RowCell[] = [
            { label: "Rule", node: (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: color.ink }}>{r.name}</div>
                <div style={{ fontSize: 12, color: color.inkMuted }}>uses {r.rootConfigName ?? "—"}</div>
              </div>
            ) },
            { label: "Table", node: <span><NodeTag>{r.tableLogicalName}</NodeTag></span> },
            { label: "Status", node: <span><StatusBadge statusCode={r.statusCode} /></span> },
            { label: "Modified", node: (
              <span style={{ fontSize: 12.5, color: color.inkMuted }}>
                {relativeTime(r.modifiedOn, now)}{r.modifiedBy ? ` · ${r.modifiedBy}` : ""}
              </span>
            ) },
            { label: "", node: (
              <span style={{ display: "flex", justifyContent: stacked ? "flex-start" : "flex-end" }} onClick={(e) => e.stopPropagation()}>
                {canMove && (
                  <Tooltip content="Remove from set" relationship="description">
                    <Button size="small" appearance="subtle" icon={<SubtractCircle16Regular />} disabled={busy}
                      aria-label={`Remove ${r.name} from set`} onClick={() => onRemove(r.id)}>
                      {stacked ? "Remove from set" : undefined}
                    </Button>
                  </Tooltip>
                )}
              </span>
            ) },
          ];
          return <RowView key={r.id} cols={COLS} cells={cells} stacked={stacked} dim={r.statusCode === 2} onClick={() => navigate("rule", r.id)} />;
        })}
      </GridCard>
    </section>
  );

  const side = (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <DetailsPanel key={set.id} api={api} set={set} sets={data.ruleSets} editable={canEdit}
        onSaved={async () => { await refresh(); }} />
      <section aria-labelledby="rs-transport" style={{ ...panel, gap: 8 }}>
        <span id="rs-transport"><Eyebrow>Between environments</Eyebrow></span>
        <div style={{ fontSize: 13, color: color.ink }}>
          {set.lastImportedFrom
            ? <span title={set.lastImportedFrom}>{`Last imported from ${envHost(set.lastImportedFrom)} on ${shortDate(set.lastImportedOn)}`}</span>
            : "Never imported"}
        </div>
      </section>
    </div>
  );

  return (
    <AppProvider>
      <ScreenShell
        aboveCard={
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Breadcrumb segments={CRUMBS} current={set.name} />
            <DataUpdateBanner api={api} />
          </div>
        }
        header={
          <div style={{ padding: "20px 24px 18px", background: `linear-gradient(180deg, ${color.canvas}, ${color.surface})`,
            display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <Eyebrow>Rule set</Eyebrow>
              <h1 style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-.015em", color: color.ink, margin: "2px 0 2px", overflowWrap: "anywhere" }}>{set.name}</h1>
              {set.description && <div style={{ fontSize: 13.5, color: color.inkMuted }}>{set.description}</div>}
              {set.modifiedOn && (
                <div style={{ fontSize: 12.5, color: color.inkMuted, marginTop: 4 }}>
                  {`Modified ${relativeTime(set.modifiedOn, now)}${set.modifiedBy ? ` by ${set.modifiedBy}` : ""}`}
                </div>
              )}
            </div>
            {canDelete && (blocked
              ? <Tooltip content={DELETE_SET_BLOCKED} relationship="inaccessible">{deleteButton}</Tooltip>
              : deleteButton)}
          </div>
        }
      >
        <div style={{ padding: "16px 24px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          {error && <Callout intent="danger">{error}</Callout>}
          <div style={stacked
            ? { display: "flex", flexDirection: "column", gap: 16 }
            : { display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 20, alignItems: "start" }}>
            {stacked ? <>{side}{rulesSection}</> : <>{rulesSection}{side}</>}
          </div>
        </div>
        <AddRulesDialog open={addOpen} target={set} rules={data.rules} ruleSetsById={ruleSetsById}
          onCancel={() => setAddOpen(false)} onAdd={onAdd} />
        <ConfirmDeleteDialog open={confirmDelete} name={set.name}
          onCancel={() => setConfirmDelete(false)} onConfirm={onConfirmDelete} />
      </ScreenShell>
    </AppProvider>
  );
}

/** Name (required, unique) and Description, each saved on blur. A refused name stays in the box
 *  with the reason under it; the set keeps its old name. */
function DetailsPanel({ api, set, sets, editable, onSaved }: {
  api: EditorApi; set: RuleSetItem; sets: RuleSetItem[]; editable: boolean; onSaved(): Promise<void>;
}) {
  const [name, setName] = React.useState(set.name);
  const [description, setDescription] = React.useState(set.description ?? "");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [descError, setDescError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // Follow the stored values after a refresh (a rename here, or another tab's edit).
  React.useEffect(() => { setName(set.name); }, [set.name]);
  React.useEffect(() => { setDescription(set.description ?? ""); }, [set.description]);

  async function write(patch: { name?: string; description?: string | null }, fail: (msg: string) => void) {
    setSaving(true); setSaved(false);
    try {
      await api.updateRuleSet!(set.id, patch);
    } catch (e) {
      fail(ruleSetErrorMessage(e, patch.name)); setSaving(false); return;
    }
    await onSaved();
    setSaving(false); setSaved(true);
  }

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === set.name) { setNameError(null); setName(set.name); return; }
    if (trimmed === "") { setNameError("Enter a name."); setSaved(false); return; }
    if (isDuplicateRuleSetName(sets, trimmed, set.id)) { setNameError(`A rule set named ${trimmed} already exists.`); setSaved(false); return; }
    setNameError(null);
    void write({ name: trimmed }, setNameError);
  };
  const commitDescription = () => {
    const next = description.trim() || null;
    if (next === (set.description ?? null)) { setDescError(null); return; }
    setDescError(null);
    void write({ description: next }, setDescError);
  };

  return (
    <OutsideField>
      <section aria-labelledby="rs-details" style={panel}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span id="rs-details"><Eyebrow>Details</Eyebrow></span>
          {editable && saved && !saving && (
            <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: color.success }}>
              <Checkmark16Regular aria-hidden />Saved
            </span>
          )}
        </div>
        {editable ? (
          <>
            <Field label="Name" required validationState={nameError ? "error" : "none"} validationMessage={nameError ?? undefined}>
              <Input value={name} disabled={saving}
                onChange={(_e, d) => { setName(d.value); setSaved(false); }}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") { setName(set.name); setNameError(null); }
                }} />
            </Field>
            <Field label="Description" validationState={descError ? "error" : "none"} validationMessage={descError ?? undefined}>
              <Textarea value={description} disabled={saving} resize="vertical" rows={3}
                onChange={(_e, d) => { setDescription(d.value); setSaved(false); }}
                onBlur={commitDescription} />
            </Field>
          </>
        ) : (
          <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
            <div>
              <dt style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>Name</dt>
              <dd style={{ margin: 0, color: color.ink, overflowWrap: "anywhere" }}>{set.name}</dd>
            </div>
            <div>
              <dt style={{ fontSize: 12.5, fontWeight: 600, color: color.ink }}>Description</dt>
              <dd style={{ margin: 0, color: set.description ? color.ink : color.inkMuted }}>{set.description ?? "—"}</dd>
            </div>
          </dl>
        )}
      </section>
    </OutsideField>
  );
}
