// One-time idempotent seed for the ZZ_VOL_ pushdown volume fixture.
// ~26,020 sample_orderline rows under one ZZ_VOL_order — deliberately ABOVE the engine's 25k
// cap-on-returned so pushdownVolume.dev.test.ts can prove the pair: a server-filtered rule
// succeeds (pushdown demonstrably fired — an unpushed fetch would trip the cap) while an
// unfiltered rule trips the cap with the named error. Shape flags via sample_notes:
//   volA × 6,000 (a paged filtered variant: >1 fetch page)
//   volB × 20     (the selective 3M-case-in-miniature)
//   volN × 20,000 (bulk)
// PERMANENT: prefix ZZ_VOL_ is outside every sweep; do not add it to sweep.ts.
import { devOrg } from "./devOrg.mjs";

const TARGETS = { volA: 6000, volB: 20, volN: 20000 };
const BATCH = 1000;

// DevOrg "user": DATAVERSE_URL from process.env / the repo-root .env; the token is the injected
// DATAVERSE_TOKEN (Tier-C runner seam) or the az user mint (scripts/devOrg.mjs).
const org = devOrg("user");

async function req(method, path, body) {
  const res = await org.request(method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${res.text}`);
  return res.json;
}

// Resolve the orderline->order @odata.bind nav prop from live metadata (BIND_NAV contract).
const rel = await req(
  "GET",
  "RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata" +
    "?$select=ReferencingEntityNavigationPropertyName" +
    "&$filter=ReferencingEntity eq 'sample_orderline' and ReferencingAttribute eq 'sample_orderid'",
);
const NAV = rel.value[0].ReferencingEntityNavigationPropertyName;

// Find-or-create the fixture order.
const orders = await req("GET", "sample_orders?$filter=sample_name eq 'ZZ_VOL_order'&$select=sample_orderid");
let orderId = orders.value[0]?.sample_orderid;
if (!orderId) {
  orderId = await org.api.createRecord("sample_orders", { sample_name: "ZZ_VOL_order" });
  console.log("created ZZ_VOL_order", orderId);
}

// Per-flag existing counts via FetchXML aggregate (26k < the 50k aggregate limit).
async function countFlag(flag) {
  const fetchXml =
    `<fetch aggregate='true'><entity name='sample_orderline'>` +
    `<attribute name='sample_orderlineid' alias='n' aggregate='count' />` +
    `<filter><condition attribute='sample_orderid' operator='eq' value='${orderId}' />` +
    `<condition attribute='sample_notes' operator='eq' value='${flag}' /></filter>` +
    `</entity></fetch>`;
  const r = await req("GET", `sample_orderlines?fetchXml=${encodeURIComponent(fetchXml)}`);
  return r.value[0]?.n ?? 0;
}

for (const [flag, target] of Object.entries(TARGETS)) {
  let have = await countFlag(flag);
  console.log(`${flag}: have ${have} / ${target}`);
  let serial = have;
  while (have < target) {
    const n = Math.min(BATCH, target - have);
    const targets = Array.from({ length: n }, (_, i) => ({
      "@odata.type": "Microsoft.Dynamics.CRM.sample_orderline",
      sample_name: `ZZ_VOL_${flag}_${serial + i}`,
      sample_notes: flag,
      [`${NAV}@odata.bind`]: `/sample_orders(${orderId})`,
    }));
    await req("POST", "sample_orderlines/Microsoft.Dynamics.CRM.CreateMultiple", { Targets: targets });
    have += n;
    serial += n;
    console.log(`${flag}: ${have}/${target}`);
  }
}
console.log("ZZ_VOL_ fixture ready.");
