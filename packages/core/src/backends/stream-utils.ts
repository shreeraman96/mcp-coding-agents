/**
 * Streaming JSONL parsing primitives shared byte-for-byte between backends/
 * codex.ts and backends/grok.ts: bounded text accumulation, line splitting on
 * a byte cap, and a bounded stderr ring buffer, plus the UTF-16 surrogate
 * trimming helpers that keep truncation from splitting a surrogate pair.
 */

export const HEAD_CAP = 40_000;
export const TAIL_CAP = 10_000;
export const TRUNCATE_THRESHOLD = 50_000;
export const MAX_LINE_BYTES = 1_000_000;
export const STDERR_RING_CAP = 16 * 1024;

export function trimTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function trimLeadingLowSurrogate(text: string): string {
  if (text.length === 0) return text;
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

export class TextAccumulator {
  private head = "";
  private tail = "";
  private total = 0;
  private headFull = false;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;

    if (!this.headFull) {
      const room = HEAD_CAP - this.head.length;
      if (chunk.length <= room) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, room);
      this.headFull = true;
      this.tail += chunk.slice(room);
    } else {
      this.tail += chunk;
    }

    if (this.tail.length > TAIL_CAP) {
      this.tail = this.tail.slice(this.tail.length - TAIL_CAP);
    }
  }

  get totalChars(): number {
    return this.total;
  }

  toString(): string {
    if (this.total <= TRUNCATE_THRESHOLD) {
      return this.head + this.tail;
    }
    const head = trimTrailingHighSurrogate(this.head);
    const tail = trimLeadingLowSurrogate(this.tail);
    const omitted = this.total - head.length - tail.length;
    return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
  }
}

export class RingBuffer {
  private buf = "";

  constructor(private readonly cap: number = STDERR_RING_CAP) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.buf += chunk;
    if (this.buf.length > this.cap) {
      this.buf = this.buf.slice(this.buf.length - this.cap);
    }
  }

  toString(): string {
    return this.buf;
  }
}

export class LineSplitter {
  private partial = "";
  private partialBytes = 0;
  private dropping = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOversized: () => void,
    private readonly maxLineBytes: number = MAX_LINE_BYTES,
  ) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl === -1) {
        this.buffer(chunk.slice(start));
        return;
      }
      let segment = chunk.slice(start, nl);
      if (segment.endsWith("\r")) segment = segment.slice(0, -1);
      if (this.dropping) {
        this.onOversized();
        this.reset();
      } else {
        this.onLine(this.partial + segment);
        this.reset();
      }
      start = nl + 1;
    }
  }

  flush(): void {
    if (this.dropping) {
      this.onOversized();
      this.reset();
      return;
    }
    if (this.partial.length > 0) {
      this.onLine(this.partial);
      this.reset();
    }
  }

  private buffer(rest: string): void {
    if (this.dropping || rest.length === 0) return;
    const bytes = Buffer.byteLength(rest, "utf8");
    if (this.partialBytes + bytes > this.maxLineBytes) {
      this.dropping = true;
      this.partial = "";
      this.partialBytes = 0;
      return;
    }
    this.partial += rest;
    this.partialBytes += bytes;
  }

  private reset(): void {
    this.partial = "";
    this.partialBytes = 0;
    this.dropping = false;
  }
}
