export type FilterRule = { kind: "rule"; column: string | null; operator: number | null; value: string | null };
export type FilterGroup = { kind: "group"; op: "and" | "or"; rules: FilterNode[] };
export type FilterNode = FilterGroup | FilterRule;

export function emptyRule(): FilterRule { return { kind: "rule", column: null, operator: null, value: null }; }
export function emptyGroup(): FilterGroup { return { kind: "group", op: "and", rules: [emptyRule()] }; }

// Operator value codes mirror the C# ComparisonOperator enum (see plan Global Constraints).
export function operatorToFetchOp(op: number): { op: string; needsValue: boolean; like?: boolean } {
  switch (op) {
    case 1: return { op: "eq", needsValue: true };
    case 2: return { op: "ne", needsValue: true };
    case 3: return { op: "gt", needsValue: true };
    case 4: return { op: "ge", needsValue: true };
    case 5: return { op: "lt", needsValue: true };
    case 6: return { op: "le", needsValue: true };
    case 7: return { op: "like", needsValue: true, like: true };
    case 8: return { op: "not-like", needsValue: true, like: true };
    case 9: return { op: "null", needsValue: false };
    case 10: return { op: "not-null", needsValue: false };
    default: return { op: "eq", needsValue: true };
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function compileRule(rule: FilterRule): string | null {
  if (!rule.column || rule.operator == null) return null;
  const spec = operatorToFetchOp(rule.operator);
  if (!spec.needsValue) return `<condition attribute="${xmlEscape(rule.column)}" operator="${spec.op}" />`;
  if (rule.value == null || rule.value === "") return null;
  const v = spec.like ? `%${rule.value}%` : rule.value;
  return `<condition attribute="${xmlEscape(rule.column)}" operator="${spec.op}" value="${xmlEscape(v)}" />`;
}

function compileNode(node: FilterNode): string | null {
  return node.kind === "rule" ? compileRule(node) : compileGroupInner(node);
}

function compileGroupInner(group: FilterGroup): string | null {
  const parts = group.rules.map(compileNode).filter((s): s is string => s !== null);
  if (parts.length === 0) return null;
  return `<filter type="${group.op}">${parts.join("")}</filter>`;
}

export function compileToFetchXml(group: FilterGroup): string {
  return compileGroupInner(group) ?? "";
}

function parseFetch(fetchXml: string): { doc: Document; entity: Element } {
  const doc = new DOMParser().parseFromString(fetchXml, "text/xml");
  const entity = doc.querySelector("entity");
  if (!entity) throw new Error("FetchXML has no <entity> element");
  return { doc, entity };
}

// Wrap the view's existing top-level filter(s) plus the compiled user filter and an optional
// text-search condition under one <filter type="and">, so view + user criteria all apply.
export function mergeFilterIntoFetchXml(
  viewFetchXml: string,
  userFilterXml: string,
  textSearch: { attribute: string; term: string } | null,
): string {
  const { doc, entity } = parseFetch(viewFetchXml);

  const existing = Array.from(entity.children).filter((c) => c.tagName === "filter");
  const fragments: string[] = existing.map((f) => new XMLSerializer().serializeToString(f));
  if (userFilterXml && userFilterXml.trim()) fragments.push(userFilterXml);
  if (textSearch && textSearch.term.trim()) {
    const term = xmlEscape(textSearch.term);
    fragments.push(`<condition attribute="${xmlEscape(textSearch.attribute)}" operator="like" value="%${term}%" />`);
  }

  // Nothing to add and nothing existing → return the view unchanged.
  if (fragments.length === 0) return new XMLSerializer().serializeToString(doc);

  existing.forEach((f) => entity.removeChild(f));
  const wrapper = new DOMParser()
    .parseFromString(`<filter type="and">${fragments.join("")}</filter>`, "text/xml")
    .documentElement;
  entity.insertBefore(doc.importNode(wrapper, true), entity.firstChild);
  return new XMLSerializer().serializeToString(doc);
}

export function withPaging(fetchXml: string, page: number, count: number): string {
  const { doc } = parseFetch(fetchXml);
  const fetch = doc.querySelector("fetch")!;
  fetch.setAttribute("page", String(page));
  fetch.setAttribute("count", String(count));
  return new XMLSerializer().serializeToString(doc);
}
