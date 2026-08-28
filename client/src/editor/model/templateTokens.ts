// Client-side mirror of the engine template tokenizer (Core/Execution/TemplateRenderer.cs):
// literal text with {root.<column>} and {node:<guid>.<column>} tokens; {{ and }} escape braces.
// Kept in lockstep with the engine: same accepted forms, same rejections.

export interface TemplateToken {
  node: string | null; // tableconfig id; null = the rule's root record
  column: string;
}

export type TokensResult =
  | { ok: true; tokens: TemplateToken[] }
  | { ok: false; error: string };

function parseToken(token: string): TemplateToken | string {
  if (token.startsWith("root.")) {
    const column = token.slice("root.".length);
    return column ? { node: null, column } : `token '{${token}}' is missing a column name.`;
  }
  if (token.startsWith("node:")) {
    const rest = token.slice("node:".length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return `token '{${token}}' must be '{node:<id>.<column>}'.`;
    return { node: rest.slice(0, dot), column: rest.slice(dot + 1) };
  }
  return `unknown token '{${token}}'. Expected '{root.<column>}' or '{node:<id>.<column>}'.`;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTemplateTokens(template: string): TokensResult {
  const tokens: TemplateToken[] = [];
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "{") {
      if (template[i + 1] === "{") { i++; continue; }
      const close = template.indexOf("}", i + 1);
      if (close < 0) return { ok: false, error: "template has an unclosed '{' token." };
      const parsed = parseToken(template.slice(i + 1, close));
      if (typeof parsed === "string") return { ok: false, error: parsed };
      if (parsed.node !== null && !GUID_RE.test(parsed.node) && !parsed.node.startsWith("new-")) {
        return { ok: false, error: `token node '${parsed.node}' is not a valid id.` };
      }
      tokens.push(parsed);
      i = close;
    } else if (c === "}") {
      if (template[i + 1] === "}") { i++; continue; }
      return { ok: false, error: "template has a stray '}' (use '}}' for a literal brace)." };
    }
  }
  return { ok: true, tokens };
}

export function makeToken(node: string | null, column: string): string {
  return node === null ? `{root.${column}}` : `{node:${node}.${column}}`;
}

export function insertAt(text: string, pos: number, insert: string): string {
  return text.slice(0, pos) + insert + text.slice(pos);
}

export function friendlyTemplate(
  template: string,
  labelFor: (node: string | null, column: string) => string,
): string {
  if (!parseTemplateTokens(template).ok) return template;
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === "{") {
      if (template[i + 1] === "{") { out += "{"; i++; continue; }
      const close = template.indexOf("}", i + 1);
      const parsed = parseToken(template.slice(i + 1, close)) as TemplateToken;
      out += `{${labelFor(parsed.node, parsed.column)}}`;
      i = close;
    } else if (c === "}") {
      out += "}"; i++; // parse succeeded, so this must be an escape
    } else {
      out += c;
    }
  }
  return out;
}
