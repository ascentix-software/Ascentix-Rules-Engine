import { createDevApi, updateDevRecord, deleteDevRecord } from "../devApi";
import { settle, dataVisible, traversalDiagnostics } from "./settle";
import { resolveNavProp } from "./navProps";
import { expect } from "vitest";

// Act + assert primitives for the rule-behavior server suite's enforcement cases. `subjects.ts`
// drives real Create/Update against a `sample_*` row and asserts what the enforcing plugin does:
// a fired Block must throw + roll back (nothing persists / nothing changes); a satisfying
// operation must succeed. See docs/guide/03-administering/02-runtime-enforcement.md for the
// exact message shape this module asserts against.

const BLOCK_HEADER = "This record could not be saved:";

const api = createDevApi();

// Real create, returns the new row's id. Throws on any 400 (block or otherwise). Callers that
// expect a block use expectBlockedOnCreate instead, which asserts the specific block shape.
export async function createSubject(entitySet: string, data: Record<string, unknown>): Promise<string> {
  return api.createRecord(entitySet, data);
}

// A violating create must throw the Block AND leave nothing behind (rollback).
//
// Enforcement settle (built in): the publish transaction writes the enforcement step, but the
// plugin pipeline metadata cache propagates asynchronously across front-end nodes: a create
// issued milliseconds post-publish can land on a node that doesn't run the step yet (observed
// live: OnDelete, operator-matrix Equals, both green on re-run). When the
// create unexpectedly SUCCEEDS, the row is deleted and the attempt retried with backoff (1s
// interval, 30s cap). A genuinely dead rule still fails (at the cap, with a distinct message),
// so the assertion stays honest. This is the sacrificial-probe settle applied at the layer
// every Block suite already goes through.
export async function expectBlockedOnCreate(
  entitySet: string,
  data: Record<string, unknown>,
  expectMessage: string,
): Promise<void> {
  await settle(
    async () => {
      let createdId: string | null = null;
      try {
        createdId = await api.createRecord(entitySet, data);
      } catch (e: any) {
        expect(e.message).toContain("(400)");
        expect(e.message).toContain(BLOCK_HEADER);
        expect(e.message).toContain(expectMessage);
        return true;
      }
      // Unexpected success: clean up the sacrificial row and re-probe until the cap.
      if (createdId) await deleteDevRecord(entitySet, createdId).catch(() => {});
      return false;
    },
    {
      label: `expectBlockedOnCreate ${entitySet}`,
      capMs: 30000,
      intervalMs: 1000,
      timeoutMessage: ({ capMs }) =>
        `expectBlockedOnCreate: create of '${data.sample_name}' was never blocked within ` +
        `${capMs}ms — step cache never settled or the rule never enforced.`,
    },
  );
  // Rollback: the row must not exist. (data carries a unique ZZ_RB_ sample_name.)
  const name = data.sample_name as string;
  const r = await api.retrieveMultipleRecords(entitySet, `?$filter=sample_name eq '${name}'&$select=sample_name`);
  expect(r.entities.length).toBe(0);
}

// A satisfying create must succeed. Returns the new id so the caller can track it for cleanup.
export async function expectAllowedOnCreate(entitySet: string, data: Record<string, unknown>): Promise<string> {
  const id = await api.createRecord(entitySet, data);
  expect(id).toBeTruthy();
  return id;
}

// Real update against an existing row. Throws on any 400. Callers that expect a block use
// expectBlockedOnUpdate instead, which asserts the specific block shape.
export async function updateSubject(entitySet: string, id: string, data: Record<string, unknown>): Promise<void> {
  try {
    await updateDevRecord(entitySet, id, data);
  } catch (e: any) {
    // An update the test expected to pass was blocked: say what the traversal saw, so a stale
    // child read (0 rows) is distinguishable from a genuinely wrong verdict.
    if (String(e?.message).includes(BLOCK_HEADER)) {
      const diag = await traversalDiagnostics(tableOf(entitySet), id, "4", JSON.stringify(data));
      throw new Error(`${e.message}\nTraversal saw: ${diag}`);
    }
    throw e;
  }
}

// Entity set -> table logical name for the sample_* fixture sets (sample_orders -> sample_order).
function tableOf(entitySet: string): string {
  return entitySet.replace(/s$/, "");
}

// An update the rule must NOT block. Waits for the engine's own read-only verdict (asx_RunRules
// with the update's values overlaid) to agree the rule does not fire -- the data-settle oracle
// described below -- then performs the real update once. A rule that genuinely fires still fails,
// at the cap, with the per-node row counts.
export async function expectAllowedOnUpdate(
  entitySet: string,
  id: string,
  data: Record<string, unknown>,
  notMessage: string,
): Promise<void> {
  await awaitEngineVerdict(tableOf(entitySet), id, {
    expectMessage: notMessage, expectFired: false, recordJson: JSON.stringify(data),
  });
  await updateDevRecord(entitySet, id, data);
}

// A violating update must throw the Block AND leave the row's offending column(s) unchanged
// (rollback). `data`'s keys are read BEFORE the attempted (rejected) patch, and re-read
// afterward to confirm none of them moved off their pre-update value.
export async function expectBlockedOnUpdate(
  entitySet: string,
  id: string,
  data: Record<string, unknown>,
  expectMessage: string,
  opts: { settle?: boolean } = {},
): Promise<void> {
  const columns = Object.keys(data);
  const before = await api.retrieveRecord(entitySet, id, `?$select=${columns.join(",")}`);

  // Data settle first (see "Data settle" below): the child rows this rule counts were created
  // moments ago and Dataverse does not promise the traversal's RetrieveMultiple sees them yet.
  // Poll the engine's read-only verdict with the update's values overlaid until it says the
  // rule fires; only then assert the real enforcement. On timeout this reports what the
  // traversal actually saw (per-node row counts) instead of "never blocked".
  // Opt out (settle: false) where the report-only verdict cannot mirror enforcement, e.g. the
  // in-flight suite, whose outcome depends on the reconciler seeing the unsaved Target.
  if (opts.settle !== false) {
    await awaitEngineVerdict(tableOf(entitySet), id, {
      expectMessage, expectFired: true, recordJson: JSON.stringify(data),
    });
  }

  // Enforcement settle, mirroring expectBlockedOnCreate: an unexpected success means the
  // update went through on a stale-cache node: restore the pre-update values and re-probe
  // until the block is observed (30s cap, distinct failure).
  await settle(
    async () => {
      try {
        await updateDevRecord(entitySet, id, data);
      } catch (e: any) {
        expect(e.message).toContain("(400)");
        expect(e.message).toContain(BLOCK_HEADER);
        expect(e.message).toContain(expectMessage);
        return true;
      }
      const restore: Record<string, unknown> = {};
      for (const col of columns) restore[col] = before[col] ?? null;
      await updateDevRecord(entitySet, id, restore);
      return false;
    },
    {
      label: `expectBlockedOnUpdate ${entitySet}(${id})`,
      capMs: 30000,
      intervalMs: 1000,
      timeoutMessage: ({ capMs }) =>
        `expectBlockedOnUpdate: update of ${entitySet}(${id}) was never blocked within ` +
        `${capMs}ms — step cache never settled or the rule never enforced.`,
    },
  );

  // Rollback: re-read and confirm the offending column(s) were NOT changed.
  const after = await api.retrieveRecord(entitySet, id, `?$select=${columns.join(",")}`);
  for (const col of columns) {
    expect(after[col]).toBe(before[col]);
  }
}

// ── Data settle ──────────────────────────────────────────────────────────────
//
// A second lag, distinct from the enforcement settle in authoring.ts. That one waits for the
// plugin STEP cache; this waits for the DATA that step will read. The engine's traversal is a
// RetrieveMultiple against the same org the test just wrote to, and Dataverse does not promise
// read-after-write visibility for it: a child row created (or deleted) milliseconds earlier can
// be missing from (or still present in) the collection the rule counts.
//
// The Block helpers above already retry for 30s, but an "allowed" assertion has no such slack on
// its own: a single attempt against a stale read fails intermittently, and the failure moves
// between runs, which reads like an engine defect and is not one.
//
// asx_RunRules is the engine's own read-only verdict over the identical evaluation path, which
// makes it the honest oracle: poll it until it agrees with the state the test just established,
// then assert enforcement. A rule that genuinely disagrees still fails (at the cap, with a
// message that says so), so this waits out a race without ever masking a wrong verdict.
//
// Adapter over settle.ts's dataVisible (the named data-settle probe); the timeout message carries
// the per-node row counts the traversal actually saw (asx_RunRules IncludeDiagnostics).
export async function awaitEngineVerdict(
  tableName: string,
  recordId: string,
  opts: { expectMessage: string; expectFired: boolean; triggers?: string; capMs?: number; recordJson?: string },
): Promise<void> {
  await dataVisible(tableName, recordId, opts);
}

// A violating delete must throw the Block AND leave the row in place (rollback). Unlike the
// create/update helpers this cannot self-settle (an unexpected success destroys the subject),
// so callers pass `settleProbe` to authorRule (which re-seeds its own sacrificial subject) and
// this asserts a single, already-settled attempt.
export async function expectBlockedOnDelete(
  entitySet: string,
  id: string,
  expectMessage: string,
): Promise<void> {
  let threw = false;
  try {
    await deleteDevRecord(entitySet, id);
  } catch (e: any) {
    threw = true;
    expect(e.message).toContain("(400)");
    expect(e.message).toContain(BLOCK_HEADER);
    expect(e.message).toContain(expectMessage);
  }
  expect(threw).toBe(true);
  // Rollback: the row survives its own blocked delete.
  const still = await api.retrieveRecord(entitySet, id, "?$select=sample_name");
  expect(still).toBeTruthy();
}

// Related-record helpers for depth cases where the compared value lives on another node (a
// FieldReference condition's Right-hand node, docs/guide/02-building-rules/06-comparison-value-
// sources.md) rather than the subject record itself. `sample_customers` isn't part of the
// table-config graph's own subject set, so these live alongside the plain create/update
// primitives above instead of in authoring.ts.

// Real create of a `sample_customers` row (the FieldReference RHS record). Returns the new id,
// which callers track for cleanup like any other subject.
export async function createCustomer(data: { name: string; creditLimit: number }): Promise<string> {
  return api.createRecord("sample_customers", { sample_name: data.name, sample_creditlimit: data.creditLimit });
}

// The customer -> parentCustomer self-ref lookup's @odata.bind nav-prop, resolved once.
let customerParentNav: string | undefined;

// Real create of a sample_customers row with its parent-customer lookup bound (for the
// order -> customer -> parentCustomer multi-hop chain). Returns the new id.
export async function createCustomerWithParent(name: string, creditLimit: number, parentId: string): Promise<string> {
  if (!customerParentNav) {
    customerParentNav = await resolveNavProp("sample_customer", "sample_customer", "sample_parentcustomerid");
  }
  return api.createRecord("sample_customers", {
    sample_name: name,
    sample_creditlimit: creditLimit,
    [`${customerParentNav}@odata.bind`]: `/sample_customers(${parentId})`,
  });
}

// The order->customer lookup's @odata.bind nav-prop name, resolved once from live metadata by
// navProps.ts rather than hardcoded, and cached for the process lifetime.
let orderCustomerNav: string | undefined;

// Builds a `sample_orders` create/update payload with its customer lookup bound, WITHOUT
// creating anything: the caller still drives the actual create through expectBlockedOnCreate /
// expectAllowedOnCreate / createSubject so block-detection and rollback assertions stay uniform
// across subject shapes. Does not mutate `data`.
export async function orderDataForCustomer(
  customerId: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!orderCustomerNav) {
    orderCustomerNav = await resolveNavProp("sample_order", "sample_customer", "sample_customerid");
  }
  return { ...data, [`${orderCustomerNav}@odata.bind`]: `/sample_customers(${customerId})` };
}

// The order-line->order lookup's @odata.bind nav-prop name (sample_orderline.sample_orderid ->
// sample_order), resolved once from live metadata and cached for the process lifetime, mirroring
// orderCustomerNav above.
let orderLineOrderNav: string | undefined;

// Real create of a `sample_orderlines` row (the RowCount depth case's child collection)
// bound to the given order via its resolved sample_orderid @odata.bind nav-prop. Returns the new
// id. Callers track it for cleanup like any other subject, deleting the line BEFORE the parent
// order (sweep.ts's own ordering already anticipates this: sample_orderlines before sample_orders).
export async function createOrderLine(orderId: string, data: Record<string, unknown>): Promise<string> {
  if (!orderLineOrderNav) {
    orderLineOrderNav = await resolveNavProp("sample_orderline", "sample_order", "sample_orderid");
  }
  return api.createRecord("sample_orderlines", {
    ...data,
    [`${orderLineOrderNav}@odata.bind`]: `/sample_orders(${orderId})`,
  });
}

// The sample_shipment -> sample_order lookup's @odata.bind nav-prop, resolved once.
let orderShipmentNav: string | undefined;

// Real create of a sample_shipments row bound to the given order (the EXISTS sibling collection).
export async function createShipment(orderId: string, data: Record<string, unknown>): Promise<string> {
  if (!orderShipmentNav) {
    orderShipmentNav = await resolveNavProp("sample_shipment", "sample_order", "sample_orderid");
  }
  return api.createRecord("sample_shipments", {
    ...data,
    [`${orderShipmentNav}@odata.bind`]: `/sample_orders(${orderId})`,
  });
}
