export class DataverseError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'DataverseError';
  }
}

type FetchImpl = typeof fetch;

const MAX_RETRIES = 5;
const RETRYABLE = new Set([429, 503]);

export class Dataverse {
  private readonly base: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchImpl = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.base = `${url.replace(/\/+$/, '')}/api/data/v9.2/`;
  }

  async get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  /** Reads every page of a collection by following @odata.nextLink. */
  async getAll<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: { value: T[]; '@odata.nextLink'?: string } = await this.get(next);
      rows.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return rows;
  }

  private resolve(path: string): string {
    return /^https?:\/\//i.test(path) ? path : this.base + path.replace(/^\/+/, '');
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.include-annotations="*"',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(this.resolve(path), init);
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        const seconds = retryDelaySeconds(res.headers.get('Retry-After'), attempt);
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(seconds * 1000);
        continue;
      }
      throw await toError(res);
    }
  }
}

const MAX_RETRY_AFTER_SECONDS = 120;

/** Retry-After as seconds or an HTTP date, capped; falls back to exponential backoff. */
function retryDelaySeconds(header: string | null, attempt: number): number {
  let seconds = NaN;
  if (header) {
    seconds = /^\s*\d+(\.\d+)?\s*$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = Math.min(2 ** attempt, 30);
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

async function toError(res: Response): Promise<DataverseError> {
  let code = '';
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(await res.text()) as { error?: { code?: string; message?: string } };
    if (parsed.error) {
      code = parsed.error.code ?? '';
      message = parsed.error.message ?? message;
    }
  } catch {
    // Not an OData error body: keep the status text.
  }
  return new DataverseError(res.status, code, message);
}
