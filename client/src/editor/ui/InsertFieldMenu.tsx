import * as React from "react";
import {
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuButton, type MenuProps,
} from "@fluentui/react-components";
import { useMetadataService } from "./useMetadata";
import { columnKind } from "./columnKind";
import type { ColumnMeta } from "../metadata";
import type { TableConfigRef } from "../model/types";
import { isNewId } from "../model/ids";
import { isSingleCardinality } from "../model/tableConfigOps";
import { makeToken } from "../model/templateTokens";

type AggFunc = "sum" | "avg" | "min" | "max" | "count";
const AGG_FUNCS: { key: AggFunc; label: string }[] = [
  { key: "sum", label: "Sum" },
  { key: "avg", label: "Average" },
  { key: "min", label: "Min" },
  { key: "max", label: "Max" },
  { key: "count", label: "Count" },
];

// ---------------------------------------------------------------------------------------
// Where the Insert menus' popovers are mounted (WCAG 4.1.2 / axe `aria-hidden-focus`).
//
// Fluent portals every MenuPopover into its own body-level `div.fui-FluentProvider`. Inside a
// MODAL Dialog that is an accessibility defect: the modalizer stamps aria-hidden="true" on
// every body-level wrapper except the dialog's own, and does not lift it when focus enters a
// submenu. A screen-reader user who opens "Insert aggregate" in the Map columns dialog hears
// Sum/Average/Min/Max/Count, arrows into one to pick the collection, and hears nothing,
// because that submenu is focused inside an aria-hidden subtree (measured as 6 menu items by
// CSS selector but 5 by ARIA role, same instant, same page, and pinned by
// e2e/menuA11yInDialog.e2e.spec.ts).
//
// The fix is to mount the popovers INSIDE the modal surface, where the modalizer never hides
// them. A surface that needs this wraps the menus in <InsertMenuMountNode node={el}> with an
// element inside its own DialogSurface (FieldMappingDialog does exactly that). Everywhere
// else the context value stays null, which is Fluent's own `mountNode` default, so the
// non-dialog call sites (ActionInspector's message fields, the template/date/math expression
// editors) keep the body portal they have always had, unchanged.
//
// EACH LEVEL GETS ITS OWN CONTAINER inside that surface: they must NOT share one, and that
// is not a stylistic choice. Fluent tells a child menu apart from a parent menu with
// `elementContains`, which walks VIRTUAL parents: `usePortal` links a portal's mount node back
// to the `<span>` left at the menu's place in the React tree, so a submenu portalled to
// document.body still counts as "inside" its parent's popover. `useOnMenuMouseEnter` is built
// on that check: every open menu listens for the custom `fuimenuenter` event and closes
// itself when the popover the mouse entered is NOT contained by its own.
//
// Point every level at ONE shared container and all three popovers become DOM SIBLINGS, and
// `usePortal` skips the virtual-parent link for the nested ones (its `mountNode.contains(
// virtualParent)` guard is true once the parent popover already lives in that container). The
// containment chain is gone: moving the mouse into the level-2 popover to reach level 3 makes
// the level-1 menu believe the pointer left the stack, and 500 ms (`hoverDelay`) later it
// closes and takes the whole tree with it. Measured with one shared node: hovering the
// collection item left ZERO popovers and focus on <body>; keyboard ArrowRight still reached
// all 14 items, because no `fuimenuenter` is ever dispatched on the keyboard
// path. A private container per level restores the link: the level-2 container is a sibling
// of the level-1 popover rather than its ancestor, so `usePortal` wires the virtual parent
// again, and every popover still sits inside the DialogSurface. Pinned by
// test/editor/insertMenuMountNode.dom.test.tsx and e2e/aggregateFiltersUi.e2e.spec.ts.
// ---------------------------------------------------------------------------------------
const MountNodeContext = React.createContext<HTMLElement | null>(null);

/** Mount the Insert menus' popovers into `node` instead of Fluent's body-level portal.
 * `node` may be null (e.g. before the surface has mounted). That is Fluent's default. */
export function InsertMenuMountNode(
  { node, children }: { node: HTMLElement | null; children: React.ReactNode },
) {
  return <MountNodeContext.Provider value={node}>{children}</MountNodeContext.Provider>;
}

/** A container of this menu level's own, appended to the ambient mount root. Null root (no
 * provider, i.e. every non-dialog call site) yields null, Fluent's `mountNode` default.
 *
 * The container is created DURING RENDER (a lazy `useState` initialiser) and only ATTACHED by a
 * layout effect, so the value this hook returns never changes while the menu is alive. That is
 * load-bearing. Build it in a passive
 * `useEffect` + `setState` instead (the obvious shape) and a level's `mountNode` flips
 * `null -> div` one commit AFTER that level mounts. A nested level mounts as soon as its PARENT
 * popover renders, so a keyboard user who presses ArrowRight twice quickly lands inside that
 * window: the submenu opens while `mountNode` is still null, Fluent portals it to document.body,
 * and the next commit re-parents that portal into the container. Re-parenting a portal detaches
 * and re-inserts its DOM, which BLURS whatever it contained: `document.activeElement` drops to
 * `<body>` and never recovers, with all three popovers still on screen. Measured: ArrowRight,
 * ArrowRight with no wait between them left 3 popovers open and focus on <body> for 3 s. The
 * same presses 400 ms apart left focus on the column item. A stable mount
 * node removes the window entirely. (The mouse path never hit it: Fluent's 500 ms `hoverDelay`
 * is longer than the commit.) */
function useOwnMountNode(root: HTMLElement | null): HTMLElement | null {
  const [own] = React.useState<HTMLElement | null>(
    () => (typeof document === "undefined" ? null : document.createElement("div")),
  );
  React.useLayoutEffect(() => {
    if (!root || !own) return;
    root.appendChild(own);
    return () => { own.remove(); };
  }, [root, own]);
  return root ? own : null;
}

/** `<Menu>` honouring the ambient mount node. Fluent's own default for `mountNode` is `null`,
 * so with no provider above it this renders exactly as a bare `<Menu>` did. Every level of a
 * nested menu needs it: each `<Menu>` publishes its own MenuContext, and MenuPopover reads
 * `mountNode` from the nearest one, and every level needs a DIFFERENT one, see above. */
function MountedMenu({ children }: { children: MenuProps["children"] }) {
  const mountNode = useOwnMountNode(React.useContext(MountNodeContext));
  return <Menu mountNode={mountNode}>{children}</Menu>;
}

// Shared column fetch for a set of tables (root + saved nodes). The metadata service caches,
// so repeated mounts (e.g. one InsertFieldMenu per message field) are cheap.
export function useColumns(tables: string[]): Record<string, ColumnMeta[]> {
  const svc = useMetadataService();
  const [byTable, setByTable] = React.useState<Record<string, ColumnMeta[]>>({});
  const key = tables.join("|");
  React.useEffect(() => {
    let live = true;
    Promise.all(tables.map((t) => svc.columns(t).then((c) => [t, c] as const)))
      .then((pairs) => { if (live) setByTable(Object.fromEntries(pairs)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, key]);
  return byTable;
}

export function savedNodes(tableConfigs: Record<string, TableConfigRef>): TableConfigRef[] {
  return Object.values(tableConfigs).filter((tc) => !isNewId(tc.id));
}

// Single-cardinality saved related nodes, the set of tables a template/message field can
// reference besides the rule's root record.
function insertableNodes(tableConfigs: Record<string, TableConfigRef>): TableConfigRef[] {
  return savedNodes(tableConfigs)
    .filter((tc) => tc.tableConfigType !== "RootTable" && isSingleCardinality(tableConfigs, tc.id));
}

// Saved many-cardinality (collection) nodes, the tables an aggregate function (sum/avg/min/
// max/count) can run over. The engine throws if an aggregate targets a single-cardinality node,
// so the Insert-aggregate menu only ever offers these.
export function collectionNodes(tableConfigs: Record<string, TableConfigRef>): TableConfigRef[] {
  return savedNodes(tableConfigs).filter((tc) => !isSingleCardinality(tableConfigs, tc.id));
}

/** A `{node,column} -> display label` resolver for the root table and its saved single-
 * cardinality nodes; used to render friendly template previews. */
export function useFieldLabelFor(
  ruleTable: string, tableConfigs: Record<string, TableConfigRef>,
): (node: string | null, column: string) => string {
  const nodes = insertableNodes(tableConfigs);
  const cols = useColumns([ruleTable, ...nodes.map((n) => n.tableLogicalName)]);
  return (node: string | null, column: string): string => {
    const table = node === null ? ruleTable : tableConfigs[node]?.tableLogicalName;
    const display = (table && cols[table]?.find((c) => c.logicalName === column)?.displayName) ?? column;
    return node === null ? display : `${tableConfigs[node]?.name ?? "?"} → ${display}`;
  };
}

/** "Insert field ▾" menu: root columns + each related single-cardinality node's columns.
 * Emits a `{root.<col>}` / `{node:<id>.<col>}` token via onInsert. It does not own a
 * textarea, so callers place the caret and splice the token in themselves. */
export function InsertFieldMenu({ ruleTable, tableConfigs, onInsert, filterColumn }: {
  ruleTable: string; tableConfigs: Record<string, TableConfigRef>;
  onInsert(token: string): void;
  filterColumn?: (c: ColumnMeta) => boolean;
}) {
  const nodes = insertableNodes(tableConfigs);
  const cols = useColumns([ruleTable, ...nodes.map((n) => n.tableLogicalName)]);
  const keep = (list: ColumnMeta[] | undefined) => (list ?? []).filter((c) => !filterColumn || filterColumn(c));

  return (
    <MountedMenu>
      <MenuTrigger disableButtonEnhancement>
        <MenuButton size="small">Insert field</MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MountedMenu>
            <MenuTrigger disableButtonEnhancement>
              <MenuItem>This record</MenuItem>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {keep(cols[ruleTable]).map((c) => (
                  <MenuItem key={c.logicalName} onClick={() => onInsert(makeToken(null, c.logicalName))}>
                    {c.displayName}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </MountedMenu>
          {nodes.map((n) => (
            <MountedMenu key={n.id}>
              <MenuTrigger disableButtonEnhancement>
                <MenuItem>{n.name}</MenuItem>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {keep(cols[n.tableLogicalName]).map((c) => (
                    <MenuItem key={c.logicalName} onClick={() => onInsert(makeToken(n.id, c.logicalName))}>
                      {c.displayName}
                    </MenuItem>
                  ))}
                </MenuList>
              </MenuPopover>
            </MountedMenu>
          ))}
        </MenuList>
      </MenuPopover>
    </MountedMenu>
  );
}

/** "Insert aggregate ▾" menu: Function (Sum/Average/Min/Max/Count) → Collection → Column.
 * Count has no column level and emits `count(node:<id>)` directly off the collection. Renders
 * nothing when the rule has no saved many-cardinality (collection) node to aggregate over.
 * Emits a `sum(node:<id>.<col>)`-shaped token via onInsert, same contract as InsertFieldMenu. */
export function InsertAggregateMenu({ tableConfigs, onInsert }: {
  tableConfigs: Record<string, TableConfigRef>;
  onInsert(token: string): void;
}) {
  const collections = collectionNodes(tableConfigs);
  const cols = useColumns(collections.map((c) => c.tableLogicalName));
  if (collections.length === 0) return null;

  const numericCols = (table: string) => (cols[table] ?? []).filter((c) => columnKind(c.attributeType) === "number");

  return (
    <MountedMenu>
      <MenuTrigger disableButtonEnhancement>
        <MenuButton size="small">Insert aggregate</MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {AGG_FUNCS.map((fn) => (
            <MountedMenu key={fn.key}>
              <MenuTrigger disableButtonEnhancement>
                <MenuItem>{fn.label}</MenuItem>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {fn.key === "count"
                    ? collections.map((c) => (
                        <MenuItem key={c.id} onClick={() => onInsert(`count(node:${c.id})`)}>
                          {c.name}
                        </MenuItem>
                      ))
                    : collections.map((c) => (
                        <MountedMenu key={c.id}>
                          <MenuTrigger disableButtonEnhancement>
                            <MenuItem>{c.name}</MenuItem>
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              {numericCols(c.tableLogicalName).map((col) => (
                                <MenuItem key={col.logicalName}
                                  onClick={() => onInsert(`${fn.key}(node:${c.id}.${col.logicalName})`)}>
                                  {col.displayName}
                                </MenuItem>
                              ))}
                            </MenuList>
                          </MenuPopover>
                        </MountedMenu>
                      ))}
                </MenuList>
              </MenuPopover>
            </MountedMenu>
          ))}
        </MenuList>
      </MenuPopover>
    </MountedMenu>
  );
}
