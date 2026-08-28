// Client-side mirror of the engine math-expression parser (Core/Execution/MathExpr.cs):
// numeric literals, {root.<col>} / {node:<guid>.<col>} tokens (same grammar as templateTokens),
// binary + - * /, unary -, and parentheses with standard precedence. Used for author-time
// validation (does it parse?) and to enumerate referenced nodes/columns. Kept in lockstep
// with the engine: same accepted forms, same rejections.

export interface MathRef { node: string | null; column: string; agg?: "sum" | "avg" | "min" | "max" | "count"; filterKey?: string }
export type MathParseResult = { ok: true; refs: MathRef[] } | { ok: false; error: string };

type Tok =
  | { k: "num" } | { k: "ref"; node: string | null; column: string }
  | { k: "agg"; node: string; column: string; func: MathRef["agg"]; filterKey?: string }
  | { k: "+" } | { k: "-" } | { k: "*" } | { k: "/" } | { k: "(" } | { k: ")" };

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEY_RE = /^[A-Za-z0-9_]+$/;

function parseToken(token: string): MathRef | string {
  if (token.startsWith("root.")) {
    const column = token.slice("root.".length);
    return column ? { node: null, column } : `token '{${token}}' is missing a column name.`;
  }
  if (token.startsWith("node:")) {
    const rest = token.slice("node:".length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return `token '{${token}}' must be '{node:<id>.<column>}'.`;
    const node = rest.slice(0, dot);
    if (!GUID_RE.test(node) && !node.startsWith("new-")) return `token node '${node}' is not a valid id.`;
    return { node, column: rest.slice(dot + 1) };
  }
  return `unknown token '{${token}}'.`;
}

function parseAggArg(arg: string, func: MathRef["agg"]): { node: string; column: string; filterKey?: string } | string {
  let filterKey: string | undefined;
  const ws = arg.search(/[ \t]/);
  if (ws >= 0) {
    const tail = arg.slice(ws + 1).trim();
    arg = arg.slice(0, ws);
    if (!tail.startsWith("filter:")) return `${func}(...) has unexpected text '${tail}'; expected 'filter:<key>'.`;
    filterKey = tail.slice("filter:".length).trim();
    if (!filterKey || !FILTER_KEY_RE.test(filterKey)) return `${func}(...) filter key '${filterKey}' must be one or more letters, digits, or underscores.`;
  }
  if (!arg.startsWith("node:")) return `${func}(...) argument must be a node reference.`;
  const rest = arg.slice("node:".length);
  const dot = rest.indexOf(".");
  const node = dot < 0 ? rest : rest.slice(0, dot);
  const column = dot < 0 ? "" : rest.slice(dot + 1);
  if (!GUID_RE.test(node) && !node.startsWith("new-")) return `${func}(...) node '${node}' is not a valid id.`;
  if (func === "count") { if (column) return "count(...) takes no column."; }
  else if (!column) return `${func}(...) needs a column.`;
  return filterKey ? { node, column, filterKey } : { node, column };
}

function tokenize(s: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "(" || c === ")") {
      toks.push({ k: c } as Tok); i++; continue;
    }
    if (c === "{") {
      const close = s.indexOf("}", i + 1);
      if (close < 0) return "expression has an unclosed '{' token.";
      const parsed = parseToken(s.slice(i + 1, close));
      if (typeof parsed === "string") return parsed;
      toks.push({ k: "ref", node: parsed.node, column: parsed.column });
      i = close + 1; continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const lit = s.slice(i, j);
      if (!/^\d+\.?\d*$|^\.\d+$/.test(lit)) return `'${lit}' is not a valid number.`;
      toks.push({ k: "num" }); i = j; continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      const name = s.slice(i, j).toLowerCase();
      if (!["sum", "avg", "min", "max", "count"].includes(name)) return `unknown function '${name}'.`;
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] !== "(") return `'${name}' must be followed by '('.`;
      const close = s.indexOf(")", k + 1);
      if (close < 0) return `'${name}(' has no closing ')'.`;
      const arg = s.slice(k + 1, close).trim();
      const parsed = parseAggArg(arg, name as MathRef["agg"]);
      if (typeof parsed === "string") return parsed;
      toks.push({ k: "agg", node: parsed.node, column: parsed.column, func: name as MathRef["agg"], filterKey: parsed.filterKey });
      i = close + 1; continue;
    }
    return `unexpected character '${c}'.`;
  }
  return toks;
}

// Recursive descent mirroring the engine grammar; collects refs as a side effect.
export function parseMathExpr(expr: string): MathParseResult {
  const toks = tokenize(expr ?? "");
  if (typeof toks === "string") return { ok: false, error: toks };
  const refs: MathRef[] = [];
  let p = 0;

  const factor = (): string | null => {
    if (p >= toks.length) return "expression ended unexpectedly.";
    const t = toks[p];
    if (t.k === "-") { p++; return factor(); }
    if (t.k === "(") {
      p++;
      const err = expr2();
      if (err) return err;
      if (p >= toks.length || toks[p].k !== ")") return "expression has an unbalanced '('.";
      p++; return null;
    }
    if (t.k === "num") { p++; return null; }
    if (t.k === "ref") { refs.push({ node: t.node, column: t.column }); p++; return null; }
    if (t.k === "agg") {
      const ref: MathRef = { node: t.node, column: t.column, agg: t.func };
      if (t.filterKey) ref.filterKey = t.filterKey;
      refs.push(ref); p++; return null;
    }
    return "expected a number, field, or '(' in expression.";
  };
  const term = (): string | null => {
    let err = factor(); if (err) return err;
    while (p < toks.length && (toks[p].k === "*" || toks[p].k === "/")) { p++; err = factor(); if (err) return err; }
    return null;
  };
  const expr2 = (): string | null => {
    let err = term(); if (err) return err;
    while (p < toks.length && (toks[p].k === "+" || toks[p].k === "-")) { p++; err = term(); if (err) return err; }
    return null;
  };

  const err = expr2();
  if (err) return { ok: false, error: err };
  if (p !== toks.length) return { ok: false, error: "unexpected trailing input in expression." };
  return { ok: true, refs };
}

// Renders `expr` with every `{root.<col>}` / `{node:<id>.<col>}` token and every aggregate
// call (`sum(node:<id>.<col>)`, `count(node:<id>)`, ...) replaced by `labelFor`'s friendly
// text, leaving operators/numbers/whitespace/parens untouched. Mirrors friendlyTemplate's
// approach: the expression must already parse (grammar-valid), so this rescans it with the
// same per-token parsers instead of re-validating.
export function friendlyMathExpr(
  expr: string,
  labelFor: (ref: MathRef) => string,
  filterSummary?: (key: string) => string
): string {
  if (!parseMathExpr(expr).ok) return expr;
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "{") {
      const close = expr.indexOf("}", i + 1);
      const parsed = parseToken(expr.slice(i + 1, close)) as MathRef;
      out += labelFor({ node: parsed.node, column: parsed.column });
      i = close + 1;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z]/.test(expr[j])) j++;
      const name = expr.slice(i, j).toLowerCase();
      let k = j;
      while (k < expr.length && /\s/.test(expr[k])) k++;
      const close = expr.indexOf(")", k + 1);
      const arg = expr.slice(k + 1, close).trim();
      const parsedArg = parseAggArg(arg, name as MathRef["agg"]) as { node: string; column: string; filterKey?: string };
      const ref: MathRef = { node: parsedArg.node, column: parsedArg.column, agg: name as MathRef["agg"] };
      if (parsedArg.filterKey) ref.filterKey = parsedArg.filterKey;
      let label = labelFor(ref);
      if (ref.filterKey && filterSummary) label += ` where ${filterSummary(ref.filterKey)}`;
      out += label;
      i = close + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
