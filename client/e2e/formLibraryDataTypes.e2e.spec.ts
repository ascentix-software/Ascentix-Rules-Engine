import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createDevApi, deleteDevRecord } from "../test-dev/devApi";
import { resolveAppId } from "./devHelpers";
import { sweepRuleBehaviorOrphans } from "../test-dev/ruleBehavior/sweep";
import { ensureTableConfig, authorRule } from "../test-dev/ruleBehavior/authoring";
import {
  createSubjectOrder, openOrderForm, expectRequiredLevel, expectFormAlive, setField,
  COND_COL, BLOCK_COL,
} from "./formHarness";
import { formSaveOrderOnce } from "./formSaveOracle";
import type { SaveVerdict } from "./formSaveOracle";

// ---------------------------------------------------------------------------------------------
// COLUMN TYPES ON A REAL FORM.
//
// WHAT THIS PINS.
//   * `recordJson.encode()` (src/recordJson.ts:21-38) has branches for lookup, datetime and
//     multi-select and a primitive passthrough for choice/boolean. The first test drives all of
//     them against real `Xrm` attributes. The other form-library specs use only the money
//     column COND_COL (`formHarness.ts:8`). L1 covers every branch
//     (test/recordJson.test.ts:141-196) but feeds it shapes the TEST invented:
//     `mockXrm.ts:47-48` returns whatever `{type, value}` the test wrote, so the one thing
//     at risk (that the REAL `getAttributeType()` string and the REAL `getValue()` shape
//     match what the switch expects) is precisely what L1 is constitutionally unable to see.
//     A wrong branch is a split-brain failure: the rule silently never fires ON THE FORM
//     while still enforcing on save (the server reads the persisted row, not RecordJson), so
//     the user reports a rule that "only works sometimes".
//   * the multi-select branch (`recordJson.ts:31-32`) is the one encode() case whose SHAPE
//     is a container rather than a scalar: an array of ints, decoded element-by-element by
//     `decimal.Parse` in Core/Engine/JsonPrimitiveDecoder.cs `DecodeMultiSelect`. Same L1
//     blind spot as the branches above, with a larger blast radius: a comma-joined STRING would
//     decode as one opaque value instead of a collection. The second test drives it from a REAL
//     multi-select control: `sample_ordertags` IS on the form layout (see the note on
//     MULTI_COL below).
//   * `SetRequired` (applier.ts:67-70 -> xrm.ts:64-67) exercised through an
//     actual save attempt in BOTH directions. It is the one client action
//     docs/Client-Form-Library.md:41 says blocks ("empty required field blocks natively"),
//     and both L1 (applier.test.ts:25-31) and L2 (formActions.dev.test.ts:47-60) stop at the
//     flag / the payload. Neither layer has a save at all.
//
// WHY THESE RULES ARE `triggers: "2"` (OnForm ONLY). Publishing an OnForm-only rule registers NO
// server plugin step, so nothing here can be produced by server enforcement: the effect is the
// client library's or it is nothing. That is also why this file is deliberately absent from
// ENFORCEMENT_SPECS in playwright.config.ts and never calls awaitBlockArmed: there is no step to
// propagate, hence no registration race.
//
// THE ORACLE, and why the weak version of the encoding test is a false positive.
// The server does RetrieveAndOverlay: it reads the PERSISTED row and overlays RecordJson on top
// (src/recordJson.ts:3-7). So a subject row that already carries the matching values would fire
// the rule whether or not the client encoded anything: a test built that way passes on a totally
// broken encoder. The encoding test therefore creates the subject with values that DO NOT match
// (customer null, status Draft, not expedited, dated 2020) and sets the matching values ONLY on
// the form. The rule can then fire for exactly one reason: the client's encoding travelled and won
// the overlay. It asserts both halves separately and in this order: the outgoing payload SHAPE
// first (via page.route capture, the interception formLibraryDegradation.e2e.spec.ts:39 uses), then
// the fired action, so a red says WHICH half broke rather than "the rule didn't fire".
// ---------------------------------------------------------------------------------------------

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000); // the sweep runs long when a red run left orphans behind
  await sweepRuleBehaviorOrphans();
});

const rand = () => Math.random().toString(36).slice(2, 8);

// The typed columns that are actually ON the sample_order main form. This matters because
// recordJson.ts:11 OMITS any column not on the layout: an off-form column can never exercise its
// encode branch at all.
//
// AUTHORITY IS THE LIVE FORM, NOT THE SCRIPT. scripts/sample-app/build-order-form.py:31-42 (the
// FIELDS list that originally BUILT the layout) does not place `sample_ordertags`, and this file
// used to take that as proof the column was unreachable. The live DEV form has since drifted:
// enumerating the form's attributes found 14, `sample_ordertags` among them
// (attribute AND control present). Every assertion below re-checks presence on the live form
// through Xrm rather than trusting either source, so a future drift fails loudly.
const LOOKUP_COL = "sample_customerid"; // Lookup -> sample_customer   (recordJson.ts:24-30)
const CHOICE_COL = "sample_status"; //     Choice 1..5                 (recordJson.ts:35-37, default)
const BOOL_COL = "sample_isexpedited"; //  Boolean                     (recordJson.ts:35-37, default)
const DATE_COL = "sample_orderdate"; //    DateTime, DateOnly/UserLocal(recordJson.ts:33-34)
const MULTI_COL = "sample_ordertags"; //   Multi-select 1..3           (recordJson.ts:31-32)

// Values set ON THE FORM. Each is deliberately different from what the subject row persists, so
// the condition can only match through RecordJson (see the overlay note in the header).
const FORM_STATUS = 3; // Approved; the row persists 1 (Draft)
const TAG_GIFT = 1; // sample_ordertags options: 1 Gift, 2 Fragile, 3 Rush
const TAG_RUSH = 3;
const FORM_TAGS = [TAG_GIFT, TAG_RUSH]; // the row persists {Gift} alone, which does NOT contain Rush
const FORM_YEAR = 2099; // noon UTC so no viewer time zone can shift the YEAR the assertion reads
const FORM_DATE_ISO = `${FORM_YEAR}-06-15T12:00:00.000Z`;

interface CapturedRun {
  recordJson: Record<string, unknown>;
  recordId: string | null;
}

// Fulfil-through capture of the outgoing asx_RunRules request. This is the ONLY place in the repo
// where what the CLIENT produces is observable: L2 hand-writes a RecordJson string and proves the
// server accepts it (ruleBehaviorRunRules.dev.test.ts:8), which is the opposite direction.
// A capture failure must never change what the page sees, hence the try/continue split.
async function captureRunRules(page: Page): Promise<CapturedRun[]> {
  const seen: CapturedRun[] = [];
  await page.route("**/asx_RunRules*", async (route) => {
    try {
      const body = route.request().postDataJSON();
      seen.push({
        recordJson: JSON.parse(String(body?.RecordJson ?? "{}")) as Record<string, unknown>,
        recordId: (body?.RecordId as string) ?? null,
      });
    } catch {
      /* never let the instrument break the subject */
    }
    await route.continue();
  });
  return seen;
}

// Wait for the cycle that FOLLOWS our edit, identified by request count rather than by any
// property of the payload: keying on a value would presuppose the very encoding under test, so a
// broken encoder would time out here instead of failing the specific assertion that names it.
async function awaitRunCount(seen: CapturedRun[], atLeast: number, capMs = 20_000): Promise<CapturedRun> {
  const started = Date.now();
  for (;;) {
    if (seen.length >= atLeast) return seen[seen.length - 1];
    if (Date.now() - started > capMs) {
      throw new Error(
        `Only ${seen.length} asx_RunRules request(s) captured within ${capMs}ms; expected at least ` +
        `${atLeast}. Either the OnChange never reached the library (no handler registered for the ` +
        "edited column — engine.ts:91-92 skips a column that is not on the form layout), or " +
        "page.route is not intercepting (a service worker served the request; this file blocks " +
        "service workers for exactly that reason).",
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

test.describe("RecordJson encoding of non-money column types", () => {
  // UCI registers a service worker and page.route does NOT intercept SW-handled requests, so the
  // capture would silently see nothing. Same reason formLibraryDegradation.e2e.spec.ts:20 blocks
  // them. Scoped to this describe so the save-probing test below runs on an untouched browser.
  test.use({ serviceWorkers: "block" });

  // Lookup, choice, date-time and boolean, encoded live and evaluated live.
  test("lookup, choice, date-time and boolean form values reach the server in the RecordJson contract shape", async ({ page }) => {
    const MSG = "ZZ_RB datatypes: all four typed columns arrived from the form";
    const appId = await resolveAppId();
    const api = createDevApi();
    const tc = await ensureTableConfig();

    // A throwaway lookup target. sweep.ts DOES reclaim ZZ_RB_ sample_customers, so a crash between
    // here and the finally does not leak; the cleanup order below is still child-before-parent
    // (the order references the customer).
    const custName = `ZZ_RB_dt_cust_${rand()}`;
    const custId = await api.createRecord("sample_customers", { sample_name: custName });

    // One AND group, one condition per column type. Each operator is the one the server validator
    // allows for that metadata type (Core Validation/ComparisonOperatorSupport.cs:50-77: Lookup /
    // Boolean / Picklist get the Equality set; DateTime gets the Ordered set), so `authorRule`'s
    // asx_ValidateRule gate is a real gate here and not something being routed around.
    //
    // Every literal is written against what the SERVER stringifies the decoded value to
    // (Core Resolution/FieldValueResolver.cs:15-33): EntityReference -> the bare id,
    // OptionSetValue -> its int, bool -> "true"/"false", DateTime -> round-trip "o". So each
    // condition is false unless the whole chain (encode -> JsonPrimitiveDecoder -> overlay ->
    // FieldValueResolver) produced the right CLR type from the form's value.
    const rule = await authorRule({
      name: `ZZ_RB_dtypes_${rand()}`,
      rootNodeId: tc.order,
      triggers: "2", // OnForm ONLY: no server step; see the file header.
      conditions: [
        // lookup: encode() must emit { id, logicalname } with the braces stripped
        // (recordJson.ts:24-30) or JsonPrimitiveDecoder.DecodeLookup throws / yields no match.
        { nodeId: tc.order, conditionType: 1, column: LOOKUP_COL, operator: 1 /* Equals */, valueSource: 1, literal: custId.toLowerCase() },
        // choice: the primitive passthrough must stay a NUMBER. A label string or an object here
        // stringifies to something that is not "3".
        { nodeId: tc.order, conditionType: 1, column: CHOICE_COL, operator: 1, valueSource: 1, literal: String(FORM_STATUS) },
        // boolean: passthrough as a JSON boolean -> decoded bool -> "true".
        { nodeId: tc.order, conditionType: 1, column: BOOL_COL, operator: 1, valueSource: 1, literal: "true" },
        // datetime: recordJson.ts:33-34 turns a Date into toISOString(). The persisted row is
        // dated 2020, so this is only >= 2090 if the FORM's value travelled.
        { nodeId: tc.order, conditionType: 1, column: DATE_COL, operator: 4 /* >= */, valueSource: 1, literal: "2090-01-01T00:00:00Z" },
      ],
      // Form-level ShowMessage: a single form notification renders inline, so its text is directly
      // assertable with exact:true (multiple simultaneous notifications collapse into a flyout,
      // a platform-fragile dead end documented at formLibraryNotifyVariants.e2e.spec.ts:14-15).
      actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1 /* OnMatch */, message: MSG, severity: 3 }],
    });

    // NONE of these four match the rule. If any of them did, this test would pass on a broken encoder.
    const subject = await createSubjectOrder({
      [CHOICE_COL]: 1, // Draft, not Approved
      [BOOL_COL]: false,
      [DATE_COL]: "2020-01-01", // decades before the 2090 threshold
      // sample_customerid deliberately left null
    });

    try {
      const seen = await captureRunRules(page);
      await openOrderForm(page, appId, subject.id);
      // The OnLoad cycle. It carries the PERSISTED values, so the rule must not have fired yet,
      // asserted below against the same captured payload, which also proves the capture works
      // before anything depends on it.
      await awaitRunCount(seen, 1);
      const onLoad = seen[0];
      // Case/brace-normalised on both sides: xrm.ts:41-44 strips the braces UCI's getId() returns
      // but does not lower-case, while the Web API hands back a bare lower-case guid.
      const norm = (g: string) => g.replace(/[{}]/g, "").toLowerCase();
      expect(
        norm(String(onLoad.recordId ?? "")),
        "asx_RunRules was called without the record's id on an EXISTING record form; the server " +
        "would then have nothing to overlay onto and this whole test would be measuring a create form",
      ).toBe(norm(subject.id));
      const keys = Object.keys(onLoad.recordJson);
      expect(
        [LOOKUP_COL, CHOICE_COL, BOOL_COL, DATE_COL].filter((c) => !keys.includes(c)),
        "RecordJson is missing a root dependency column (engine.ts:24-39 computeDependencyColumns). " +
        "A missing key means the column is not on the form layout, so recordJson.ts:11 dropped it " +
        `before encode() ever saw it — its branch is not being exercised at all. Keys seen: ${keys.join(", ")}`,
      ).toEqual([]);

      // Set all four on the live form and fire ONE OnChange. Every dependency column is wired to
      // the same cycle (engine.ts:91-92), so one is enough, and one cycle keeps the whole edit
      // inside a single Xrm.Page live window (formHarness.ts:144-158: the deprecated global stops
      // answering ~2.2 s after an OnChange).
      const probe = await page.evaluate(
        (p) => {
          const X = (window as any).Xrm;
          if (!X?.Page?.getAttribute) return { ok: false, why: "no form context", types: {} as Record<string, string> };
          const cols = [p.lookupCol, p.choiceCol, p.boolCol, p.dateCol];
          const missing = cols.filter((c) => !X.Page.getAttribute(c));
          if (missing.length) return { ok: false, why: `not on the form layout: ${missing.join(", ")}`, types: {} as Record<string, string> };
          const types: Record<string, string> = {};
          for (const c of cols) types[c] = X.Page.getAttribute(c).getAttributeType();
          X.Page.getAttribute(p.lookupCol).setValue([
            // Braced + upper-cased on purpose: this is the shape UCI itself stores, and it is what
            // makes recordJson.ts:29's `.replace(/[{}]/g, "")` a branch under test rather than a no-op.
            { id: `{${p.custId.toUpperCase()}}`, name: p.custName, entityType: "sample_customer" },
          ]);
          X.Page.getAttribute(p.choiceCol).setValue(p.status);
          X.Page.getAttribute(p.boolCol).setValue(true);
          // A real Date, constructed in the page realm, so `value instanceof Date`
          // (recordJson.ts:34) is genuinely exercised.
          X.Page.getAttribute(p.dateCol).setValue(new Date(p.dateIso));
          X.Page.getAttribute(p.dateCol).fireOnChange();
          return { ok: true, why: "", types };
        },
        { lookupCol: LOOKUP_COL, choiceCol: CHOICE_COL, boolCol: BOOL_COL, dateCol: DATE_COL, custId, custName, status: FORM_STATUS, dateIso: FORM_DATE_ISO },
      );
      expect(probe.ok, `could not drive the typed columns on the form: ${probe.why}`).toBe(true);

      // The attribute-type STRINGS themselves. This is the assertion L1 cannot make: mockXrm
      // returns whatever type string the test wrote (mockXrm.ts:47-48), so recordJson.ts:23's
      // switch has only ever been matched against its own fixtures. If the platform ever renames
      // one of these, the branch stops being selected and the value falls through to the
      // passthrough default, silently, and only on the form.
      expect(
        probe.types,
        "the live Xrm attribute-type keys no longer match the ones recordJson.ts:23-38 switches on",
      ).toEqual({
        [LOOKUP_COL]: "lookup",
        [CHOICE_COL]: "optionset",
        [BOOL_COL]: "boolean",
        [DATE_COL]: "datetime",
      });

      // --- Half 1: what the CLIENT produced -----------------------------------------------
      const after = await awaitRunCount(seen, 2);
      const rj = after.recordJson;

      expect(
        rj[LOOKUP_COL],
        "the lookup did not encode to { id, logicalname } with braces stripped (recordJson.ts:24-30). " +
        "Core Engine/JsonPrimitiveDecoder.cs:41-49 REJECTS anything else with " +
        "\"A lookup value must be an object with 'id' and 'logicalname'\", so a wrong shape here is " +
        "not a silent miss on the server — it is a thrown plugin exception on every OnChange",
      // GUID CASE IS NOT PART OF THE CONTRACT: measured, UCI's getId() returns an
      // UPPERCASE guid ("EC57F03F-…"), and encode() passes the case through after stripping the
      // braces. That is correct: the server parses it with Guid.Parse
      // (Core/Engine/JsonPrimitiveDecoder.cs:49), which is case-insensitive. Asserting a
      // lowercase id would pin an accident of the platform rather than the contract, and would go
      // red the day UCI changed its casing without anything actually breaking. Normalise the id;
      // keep logicalname exact, because THAT is compared as a string on the server.
      ).toEqual({ id: expect.stringMatching(new RegExp(`^${custId}$`, "i")), logicalname: "sample_customer" });

      expect(
        rj[CHOICE_COL],
        "a choice value must cross the wire as a JSON number (recordJson.ts:35-37 passthrough); a " +
        "string or a { value, label } object decodes to a string and never equals the option's int",
      ).toBe(FORM_STATUS);
      expect(typeof rj[CHOICE_COL], "choice encoded as a non-number").toBe("number");

      expect(
        rj[BOOL_COL],
        "a boolean must cross the wire as a JSON boolean, not \"true\"/1 — " +
        "JsonPrimitiveDecoder.cs:25 keys on the JSON type, not on the text",
      ).toBe(true);

      const encodedDate = String(rj[DATE_COL]);
      expect(
        encodedDate,
        "a date must be encoded with Date.toISOString() (recordJson.ts:33-34). A locale-formatted " +
        "string is the dangerous failure: LiteralCoercer / ValueComparer parse with " +
        "CultureInfo.InvariantCulture, so \"06/15/2099\" and \"15/06/2099\" silently compare as " +
        "different days rather than failing",
      ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(
        new Date(encodedDate).getUTCFullYear(),
        "the encoded instant is not the date the form holds",
      ).toBe(FORM_YEAR);

      // --- Half 2: what the SERVER made of it ----------------------------------------------
      // The banner appears only if all four conditions matched, and each of the four can only
      // match on the value that came from the form. This is the end-to-end proof that the shapes
      // asserted above are the shapes the engine actually accepts.
      await expect(
        page.getByText(MSG, { exact: true }),
        "the rule did not fire even though the payload above carried all four values in the " +
        "documented shape. The encoder is fine and the SERVER side of one of these types is not: " +
        "RecordJsonDeserializer/JsonPrimitiveDecoder, the RetrieveAndOverlay order, or " +
        "FieldValueResolver's stringification for that type",
      ).toBeVisible();
      await expectFormAlive(page);
    } finally {
      await subject.cleanup();
      await rule.cleanup();
      await tc.cleanup();
      await deleteDevRecord("sample_customers", custId).catch(() => {});
    }
  });

  // The container-shaped encode() branch.
  //
  // WHAT IS AT RISK. recordJson.ts:31-32 (`case "multiselectoptionset"`) passes the attribute's
  // value straight through on the stated assumption that it is `number[]`. The server reads it as
  // a JSON ARRAY and builds an OptionSetValueCollection element by element
  // (Core/Engine/JsonPrimitiveDecoder.cs `DecodeMultiSelect`, one `decimal.Parse` per element),
  // which FieldValueResolver.cs:17-18 then joins with commas. So "an array of ints" IS the
  // contract. If UCI ever handed encode() the comma-joined STRING that the Web API itself uses
  // for this type ("1,3"), the passthrough would ship a string, `Decode` would fall to its
  // `default: return element.Value` and the condition would compare against one opaque token,
  // and a Contains would still match often enough to look fine. L1 cannot see this: mockXrm
  // returns whatever value the test wrote (mockXrm.ts:47-48), so the array is the test's own
  // invention. Only a real multi-select control can say what UCI actually hands over.
  //
  // THE ORACLE is the previous test's, for its reason (see the overlay note in the file header): the subject
  // persists {Gift}, which does NOT contain Rush, so the banner can appear for exactly one reason:
  // the array set ON THE FORM travelled and won the server's RetrieveAndOverlay.
  test("a multi-select choice column encodes as an array of ints", async ({ page }) => {
    const MSG = "ZZ_RB datatypes: the multi-select arrived from the form";
    const appId = await resolveAppId();
    const tc = await ensureTableConfig();

    // Contains (operator 7) is the operator the server validator ALLOWS for a multi-select:
    // Dataverse reports a MultiSelectPicklist as AttributeTypeCode.Virtual (confirmed live against
    // EntityDefinitions(LogicalName='sample_order')/Attributes) and
    // Core Validation/ComparisonOperatorSupport.cs:71-74 maps Virtual to the Textual set. So
    // authorRule's asx_ValidateRule gate is a real gate here, not something being routed around.
    // RHS "3" (Rush): the persisted {Gift} stringifies to "1" and does not contain it; the form's
    // {Gift, Rush} stringifies to "1,3" and does.
    const rule = await authorRule({
      name: `ZZ_RB_dtmulti_${rand()}`,
      rootNodeId: tc.order,
      triggers: "2", // OnForm ONLY: no server step; see the file header.
      conditions: [
        { nodeId: tc.order, conditionType: 1, column: MULTI_COL, operator: 7 /* Contains */, valueSource: 1, literal: String(TAG_RUSH) },
      ],
      actions: [{ actionType: 3 /* ShowMessage */, fireOn: 1 /* OnMatch */, message: MSG, severity: 3 }],
    });
    // The Web API takes a multi-select as a comma-separated int string. {Gift} alone: NOT a match.
    const subject = await createSubjectOrder({ [MULTI_COL]: String(TAG_GIFT) });
    const banner = page.getByText(MSG, { exact: true });

    try {
      const seen = await captureRunRules(page);
      await openOrderForm(page, appId, subject.id);

      // The OnLoad cycle already runs the branch, on the value the CONTROL loaded from the row.
      // Asserting it here proves the capture works and the column is genuinely on the layout
      // before anything below depends on either.
      const onLoad = await awaitRunCount(seen, 1);
      expect(
        onLoad.recordJson[MULTI_COL],
        `RecordJson does not carry '${MULTI_COL}' as an array of ints on load. A MISSING key means ` +
        "the column is not on the form layout, so recordJson.ts:11 dropped it before encode() ever " +
        "saw it and this test is measuring nothing; a STRING means UCI hands the encoder the " +
        "comma-joined Web API form and recordJson.ts:31-32's passthrough is wrong for this type. " +
        `Keys seen: ${Object.keys(onLoad.recordJson).join(", ")}`,
      ).toEqual([TAG_GIFT]);
      await expect(
        banner,
        "the PERSISTED tags already satisfied the rule, so nothing below could distinguish the " +
        "form's value from the row's",
      ).toHaveCount(0);

      const probe = await page.evaluate(
        (p) => {
          const X = (window as any).Xrm;
          if (!X?.Page?.getAttribute) return { ok: false, why: "no form context", type: "" };
          const attr = X.Page.getAttribute(p.col);
          if (!attr) return { ok: false, why: `not on the form layout: ${p.col}`, type: "" };
          const type: string = attr.getAttributeType();
          attr.setValue(p.tags);
          attr.fireOnChange();
          return { ok: true, why: "", type };
        },
        { col: MULTI_COL, tags: FORM_TAGS },
      );
      expect(probe.ok, `could not drive the multi-select on the form: ${probe.why}`).toBe(true);

      // The attribute-type STRING itself, the assertion L1 is constitutionally unable to make.
      // If the platform ever renames this key, recordJson.ts:31's case stops being selected and
      // the value falls through to the passthrough default, silently and only on the form.
      expect(
        probe.type,
        "the live Xrm attribute-type key for a multi-select no longer matches the one " +
        "recordJson.ts:31 switches on",
      ).toBe("multiselectoptionset");

      // --- Half 1: what the CLIENT produced -----------------------------------------------
      const after = await awaitRunCount(seen, 2);
      const encoded = after.recordJson[MULTI_COL];
      expect(
        Array.isArray(encoded),
        "a multi-select must cross the wire as a JSON ARRAY. JsonPrimitiveDecoder.Decode keys on " +
        'the JSON type: only `case "array"` reaches DecodeMultiSelect, and anything else lands on ' +
        `\`default: return element.Value\` — one opaque string, never a collection. Sent: ${JSON.stringify(encoded)}`,
      ).toBe(true);
      expect(
        (encoded as unknown[]).every((v) => typeof v === "number" && Number.isInteger(v)),
        "a multi-select array must carry JSON NUMBERS, one per selected option. DecodeMultiSelect " +
        "does `(int)decimal.Parse(item.Value, ...)` per element with CultureInfo.InvariantCulture, " +
        "so a label string (\"Rush\") throws a FormatException inside the plugin on every OnChange " +
        `rather than failing quietly. Sent: ${JSON.stringify(encoded)}`,
      ).toBe(true);
      expect(
        encoded,
        "the encoded options are not the ones the form holds",
      ).toEqual(FORM_TAGS);

      // --- Half 2: what the SERVER made of it ----------------------------------------------
      await expect(
        banner,
        "the rule did not fire even though the payload above carried the options as an array of " +
        "ints. The encoder is fine and the SERVER side of this type is not: DecodeMultiSelect, the " +
        "RetrieveAndOverlay order, or FieldValueResolver.cs:17-18's comma join of the " +
        "OptionSetValueCollection that the Contains operator reads",
      ).toBeVisible();
      await expectFormAlive(page);
    } finally {
      await subject.cleanup();
      await rule.cleanup();
      await tc.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// SetRequired, through a real save, in both directions.
//
// WHY THE TARGET IS BLOCK_COL AND NOT formHarness's REQUIRED_COL. `sample_handlinginstructions`
// (REQUIRED_COL) is HIDDEN on the form by default: build-order-form.py:42 places it with
// visible="false" so the sample app's R2 rule has something to reveal. A save verdict taken on a
// hidden required field would confound the contract under test ("an empty required field blocks")
// with a different, murkier platform question ("does a HIDDEN empty required field block, and can
// the user even fix it"). `sample_shippingpostalcode` is on the form, visible, and left empty by
// formSaveOrderOnce, which fills only Name and Order Total.
//
// WHY A BLOCKED VERDICT HERE CAN ONLY BE THE PLATFORM'S NATIVE REQUIRED-FIELD VALIDATION.
// Three things are true at once: (1) the rule is `triggers: "2"`, so no server plugin step exists
// to reject the write; (2) `SetRequired` produces NO notification of any kind: applier.ts:67-70
// calls setRequiredLevel and nothing else, so the ERROR-control-notification mechanism that stops
// a field-level Block (and, per defect G1, a field-targeted ShowMessage) is not in play; (3) the
// only difference between the two legs below is whether the rule matched. That leaves exactly one
// mechanism: the platform refusing to submit a form with an empty required attribute.
// ---------------------------------------------------------------------------------------------

const VIOLATING_TOTAL = 150;
const COMPLIANT_TOTAL = 50;

// formSaveOrderOnce returns "VOID" when a row lands WITHOUT the total under test: the attempt
// never exercised the rule, so coercing it to a verdict is exactly how a harness lies.
async function saveOnceStrict(
  page: Page, uiName: string, orderTotal: number, ready?: (page: Page) => Promise<void>,
): Promise<SaveVerdict> {
  const v = await formSaveOrderOnce(page, uiName, orderTotal, ready ? { ready } : {});
  if (v === "VOID") {
    throw new Error(
      `form save '${uiName}' returned VOID: a sample_order row landed WITHOUT ` +
      `sample_ordertotal=${orderTotal}, so the rule was never exercised. This is a harness/form ` +
      "problem (a modal stealing focus, the control not ready, or the save committing before the " +
      "field does) — NOT evidence about SetRequired.",
    );
  }
  return v;
}

// The readiness gate. Without it formSaveOrderOnce presses Control+s in the same tick as the Tab
// that starts the library's OnChange cycle, so the save can commit before setRequiredLevel has
// run, and a SAVED verdict would then be ambiguous between "an empty required field does not
// block" and "the field was not required yet", which are opposite conclusions about the product.
// expectRequiredLevel polls and THROWS at its cap, so a library that never fired can never be
// downgraded into a save verdict. It reads through the deprecated Xrm.Page global, which stops
// answering ~2.2 s after an OnChange (formHarness.ts:144-158). The applier lands in ~200 ms, so
// this normally returns on the second or third poll; a CONTEXT_LOST here is a harness signal about
// that window, not a verdict about SetRequired.
const requiredOn = (col: string) => async (page: Page) => {
  await expectRequiredLevel(page, col, "required", 10_000);
};

test("SetRequired makes an empty field block the save natively, and releases it when the rule stops matching", async ({ page }) => {
  const appId = await resolveAppId();
  const tc = await ensureTableConfig();
  const rule = await authorRule({
    name: `ZZ_RB_setreq_${rand()}`,
    rootNodeId: tc.order,
    triggers: "2",
    conditions: [{ nodeId: tc.order, conditionType: 1, column: COND_COL, operator: 3 /* > */, valueSource: 1, literal: "100" }],
    actions: [{ actionType: 2 /* SetRequired */, fireOn: 1 /* OnMatch */, targetColumn: BLOCK_COL, valueBool: true }],
  });
  const subject = await createSubjectOrder({ [COND_COL]: VIOLATING_TOTAL });
  try {
    // --- Direction 1, in the form: the flag goes ON, then comes back OFF -------------------
    // This half is about applier.ts:44-48's reset-to-baseline. The other release direction,
    // SetRequired(false) RELEASING a field the form customization itself marks required, is not
    // reachable: formHarness.ts:5-7 records that every sample_order column is un-governed and
    // optional, so there is no such column to release. That is a fixture change, not harness code.
    await openOrderForm(page, appId, subject.id);
    await expectRequiredLevel(page, BLOCK_COL, "required");

    await expectFormAlive(page); // setField below throws unhelpfully on a dead context
    await setField(page, COND_COL, COMPLIANT_TOTAL, { settleMs: 0 });
    await expectRequiredLevel(
      page, BLOCK_COL, "none",
    ).catch((e: Error) => {
      throw new Error(
        "the required flag was never released when the rule stopped matching. applier.ts:47 " +
        "restores baseline.required[c] on every cycle; if that path is broken the user faces a " +
        `field they cannot clear and cannot save around. Underlying: ${e.message}`,
      );
    });
    await expectFormAlive(page); // "it went away" proves nothing on a disposed form

    // --- Direction 2, through a real save: required + empty => the platform refuses ---------
    // Pins docs/Client-Form-Library.md:41 ("empty required field blocks natively"), the one
    // client-side enforcement mechanism the product advertises and the only one no layer has
    // ever exercised: L1 stops at the flag, L2 at the payload, and neither models a save.
    const violating = await saveOnceStrict(
      page, `ZZ_RB_setreq_bad_${rand()}`, VIOLATING_TOTAL, requiredOn(BLOCK_COL),
    );
    expect(
      violating,
      "a record saved with an EMPTY field that the rule had provably just marked required. Either " +
      "the platform does not enforce a required level set at runtime through setRequiredLevel " +
      "(docs/Client-Form-Library.md:41 is then wrong, and SetRequired is purely decorative), or " +
      "applier.ts:67-70 set the level on an attribute the save path does not consult",
    ).toBe("BLOCKED");

    // The other half: a rule that marks the field required unconditionally, or a required level
    // that is never released, would satisfy the assertion above. This proves it is conditional,
    // and it is the same field, left equally empty.
    const compliant = await saveOnceStrict(page, `ZZ_RB_setreq_ok_${rand()}`, COMPLIANT_TOTAL);
    expect(
      compliant,
      "a COMPLIANT record was also stopped with the same field empty: SetRequired is being applied " +
      "unconditionally, or a required level from an earlier cycle is never released and wedges the " +
      "form permanently unsaveable with no visible cause",
    ).toBe("SAVED");
  } finally {
    await subject.cleanup();
    await rule.cleanup();
    await tc.cleanup();
  }
});
