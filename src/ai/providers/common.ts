export type SseHandler = (event: string, data: string) => void;

/** Minimal SSE reader that tolerates proxies which split or merge chunks. */
export class SseReader {
  private buffer = '';

  constructor(private readonly handler: SseHandler) {}

  push(chunk: string): void {
    // Append first, then normalise CRLF over the whole buffer: a chunk may end
    // between `\r` and `\n`, and normalising each chunk on its own would leave
    // a stray `\r` behind.
    this.buffer += chunk;
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r(?=[^\n])/g, '\n');
    let index = this.buffer.indexOf('\n\n');
    while (index >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.dispatch(raw);
      index = this.buffer.indexOf('\n\n');
    }
  }

  end(): void {
    if (this.buffer.trim().length > 0) {
      this.dispatch(this.buffer);
      this.buffer = '';
    }
  }

  private dispatch(raw: string): void {
    const lines = raw.split('\n');
    let event = 'message';
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length === 0) return;
    this.handler(event, data.join('\n'));
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function joinUrl(base: string, path: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  const suffix = path.trim();
  const withSlash = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (!trimmed) return withSlash;
  return `${trimmed}${withSlash}`;
}

export function parseExtraHeaders(raw: string): Record<string, string> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record) return {};
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' || typeof value === 'number') headers[key] = String(value);
    }
    return headers;
  } catch {
    return {};
  }
}
