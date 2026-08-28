import type { Operation, Bind } from "./diff";

export interface BatchOptions {
  clientUrl: string;
  apiVersion: string;
  batchId: string;
  changesetId: string;
}

function recordUrl(opts: BatchOptions, set: string, id: string): string {
  return `${opts.clientUrl}/api/data/${opts.apiVersion}/${set}(${id})`;
}
function collectionUrl(opts: BatchOptions, set: string): string {
  return `${opts.clientUrl}/api/data/${opts.apiVersion}/${set}`;
}

function bindValue(bind: Bind, opts: BatchOptions, contentIdByTemp: Map<string, number>): string {
  if (bind.ref.kind === "new") {
    const cid = contentIdByTemp.get(bind.ref.tempId);
    if (cid == null) {
      throw new Error(`Batch: no Content-ID for new tempId "${bind.ref.tempId}"`);
    }
    return `$${cid}`;
  }
  return recordUrl(opts, bind.targetSet, bind.ref.id);
}

function jsonBody(attrs: Record<string, any>, binds: Bind[], opts: BatchOptions, contentIdByTemp: Map<string, number>): string {
  const obj: Record<string, any> = { ...attrs };
  for (const b of binds) obj[`${b.navProp}@odata.bind`] = bindValue(b, opts, contentIdByTemp);
  return JSON.stringify(obj);
}

export function buildBatch(ops: Operation[], opts: BatchOptions): { boundary: string; body: string } {
  const boundary = `batch_${opts.batchId}`;
  const changeset = `changeset_${opts.changesetId}`;

  // Assign Content-IDs in op order; record temp→id for create refs.
  const contentIdByTemp = new Map<string, number>();
  ops.forEach((op, i) => {
    if (op.kind === "create") contentIdByTemp.set(op.tempId, i + 1);
  });

  const parts: string[] = [];
  ops.forEach((op, i) => {
    const cid = i + 1;
    const lines: string[] = [];
    lines.push(`--${changeset}`);
    lines.push("Content-Type: application/http");
    lines.push("Content-Transfer-Encoding: binary");
    lines.push(`Content-ID: ${cid}`);
    lines.push("");
    if (op.kind === "create") {
      lines.push(`POST ${collectionUrl(opts, op.set)} HTTP/1.1`);
      lines.push("Content-Type: application/json; type=entry");
      lines.push("");
      lines.push(jsonBody(op.attrs, op.binds, opts, contentIdByTemp));
    } else if (op.kind === "update") {
      lines.push(`PATCH ${recordUrl(opts, op.set, op.id)} HTTP/1.1`);
      lines.push("Content-Type: application/json; type=entry");
      if (op.etag) lines.push(`If-Match: ${op.etag}`);
      lines.push("");
      lines.push(jsonBody(op.attrs, op.binds, opts, contentIdByTemp));
    } else {
      lines.push(`DELETE ${recordUrl(opts, op.set, op.id)} HTTP/1.1`);
      lines.push("");
    }
    parts.push(lines.join("\r\n"));
  });

  const body = [
    `--${boundary}`,
    `Content-Type: multipart/mixed; boundary=${changeset}`,
    "",
    parts.join("\r\n"),
    `--${changeset}--`,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return { boundary, body };
}

export function parseBatchOutcome(text: string): { ok: boolean; conflict: boolean; message: string | null } {
  const codes: number[] = [];
  const re = /HTTP\/1\.1 (\d{3})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) codes.push(Number(m[1]));
  const bad = codes.find((c) => c >= 400);
  if (bad == null) return { ok: true, conflict: false, message: null };
  const msgMatch = /"message"\s*:\s*"([^"]*)"/.exec(text);
  const message = msgMatch ? msgMatch[1] : null;
  return { ok: false, conflict: bad === 412, message };
}
