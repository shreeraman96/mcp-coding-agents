/**
 * OpenCode CLI backend: argv construction, process lifecycle, streaming JSONL
 * parsing, and error classification. Moved (not merged) from
 * packages/mcp-opencode/src/{run,parse,policy}.ts.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { createRedactor } from "../text.js";
import type { StructuredError, ErrorCategory } from "../errors.js";
import type { RunReason } from "../types.js";

/**
 * provider/model — the model path may itself contain slashes, e.g.
 * `fireworks-ai/accounts/fireworks/models/glm-5p2`. Shape guard only; real
 * validation is the runtime ProviderModelNotFoundError.
 */
export const MODEL_RE = /^[\w.-]+\/[\w./@:+-]+$/;
export const SESSION_RE = /^ses_[A-Za-z0-9]+$/;

/**
 * Redaction
 * ----------------
 * Strip obvious secrets out of any text we might echo back (stderr tails,
 * error messages, etc). Provider-agnostic: this server passes an arbitrary
 * provider/model string through to opencode, so the patterns below cover
 * generic credential shapes (PEM keys, AWS/GitHub tokens, bearer/auth headers,
 * key=value assignments) rather than any single provider's key format.
 */
const OPENCODE_REDACTION_PATTERNS: RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/etc.) -- redact the whole block.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  // Bearer/base64 tokens include + / = ~; stopping short of them leaks the tail.
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // AWS access key IDs (AKIA/ASIA/AGPA/...) and GitHub tokens.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi,
  // Assignment forms; the value may be quoted and contain spaces.
  /\b(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
];

export const redact = createRedactor({ patterns: OPENCODE_REDACTION_PATTERNS });

/**
 * Permissions
 * ----------------
 * SPEC DEVIATION (documented, per the spec's own contingency clause):
 *
 * The spec's primary plan was to generate a temp opencode config JSON with a
 * `permission` block and pass it via the OPENCODE_CONFIG env var. Live testing
 * (see README "Permission model") showed that supplying *any* custom
 * `permission` config via OPENCODE_CONFIG causes `opencode run` to hang
 * indefinitely in this non-TTY environment — reproduced twice, with both an
 * object-shaped permission block and a bare `"permission": "allow"` action
 * config. This is presumably an `ask` prompt with no TTY to answer it, on some
 * permission category the config implicitly touches.
 *
 * Per the spec's stated CONTINGENCY, we do not use OPENCODE_CONFIG at all.
 * Instead:
 *   - By default (no config, no --auto) we rely on opencode's own built-in
 *     agent-level defaults, which were verified live to behave safely:
 *       - agent=build: edit/bash/webfetch tool calls are allowed and complete
 *         without any prompt or hang.
 *       - agent=plan: edits are refused by the agent itself (it explains it's
 *         in read-only "Plan Mode") -- no permission prompt, no hang.
 *   - Only if the caller explicitly opts in via OPENCODE_MCP_ALLOW_AUTO=1 AND
 *     agent === 'build' do we additionally pass `--auto` (auto-approve
 *     permissions not explicitly denied). This is off by default because
 *     --auto is documented by the CLI itself as "dangerous".
 */
export function extraPermissionArgs(agent: "build" | "plan"): string[] {
  if (agent === "build" && process.env.OPENCODE_MCP_ALLOW_AUTO === "1") {
    return ["--auto"];
  }
  return [];
}

/**
 * Error classification (legacy, stderr-text based)
 * ----------------
 * Best-effort decoration of failures based on stderr content. Never the sole
 * mechanism for detecting failure -- exit code is authoritative. Kept as a
 * fallback: some named errors (e.g. ProviderModelNotFoundError) can surface
 * on stdout masked as a generic UnknownError but still appear verbatim in the
 * stderr log line (see docs/phase0-capacity-signals.md A4).
 */
export function classifyError(stderr: string, model: string): string | undefined {
  if (/ProviderModelNotFoundError/.test(stderr)) {
    return `Model not found: ${model}. Run opencode_models to list available models.`;
  }
  if (/unauthorized|401|credential|auth/i.test(stderr)) {
    return "Provider not authenticated. Run `opencode auth login` for this provider.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Streaming JSONL parser
// ---------------------------------------------------------------------------

const HEAD_CAP = 40_000;
const TAIL_CAP = 10_000;
const TRUNCATE_THRESHOLD = 50_000;
export const MAX_LINE_BYTES = 1_000_000;
const STDERR_RING_CAP = 16 * 1024;
const MAX_ERROR_MESSAGES = 8;
const MAX_ERROR_CHARS = 4_000;

export interface StepFinishInfo {
  reason?: string;
  tokens?: unknown;
  cost?: number;
}

export interface ParsedResult {
  sessionID?: string;
  text: string;
  totalTextChars: number;
  lastStepFinish?: StepFinishInfo;
  totalCost: number;
  errorMessages: string[];
  malformedLines: number;
  oversizedLines: number;
  costCapExceeded: boolean;
  /** Structured classification of any `type:"error"` stdout events observed
   * during the run (bug fix: previously discarded when `.error` was an
   * object -- see classifyErrorEvent below). */
  structuredErrors: StructuredError[];
}

/** Accumulates text keeping only head(40k) + tail(10k) once total exceeds 50k. */
class TextAccumulator {
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

/** Fixed-capacity ring buffer for stderr; keeps only the last N bytes/chars. */
export class RingBuffer {
  private buf = "";
  constructor(private readonly cap: number = STDERR_RING_CAP) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.cap) {
      this.buf = this.buf.slice(this.buf.length - this.cap);
    }
  }

  toString(): string {
    return this.buf;
  }
}

function trimTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function trimLeadingLowSurrogate(text: string): string {
  if (text.length === 0) return text;
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/**
 * Assembles complete lines from arbitrary decoded chunks while enforcing a hard
 * byte ceiling *during* accumulation -- unlike node:readline, which buffers a
 * newline-less line to unbounded heap before any consumer sees it. Once the
 * in-progress line crosses `maxLineBytes` with no newline, its bytes are dropped
 * and everything up to the next newline is discarded; the line is reported as
 * oversized. Peak memory is therefore ~maxLineBytes + one chunk.
 */
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

/**
 * Classify a `type:"error"` event's `.error` object (the opencode NamedError
 * envelope `{name, data}`) into a StructuredError.
 *
 * Bug fix 1 (parse.ts ~265-272): the object was previously passed through
 * `String()`, yielding "[object Object]" and discarding `error.name` /
 * `error.data.statusCode` / `error.data.responseBody`. This reads them
 * directly instead.
 *
 * Bug fix 2 (AI-SDK retry-exhaustion wrapper): errors that fall through
 * opencode's `fromError` as `{"name":"Unknown","data":{"message":"Failed
 * after N attempts. Last error: ..."}}` are unwrapped and the trailing
 * "Last error" text is keyword-matched to capacity/transport.
 *
 * See docs/phase0-capacity-signals.md section (b) for the full rule table.
 */
export function classifyErrorEvent(errorObj: unknown): StructuredError {
  const obj = (errorObj ?? {}) as { name?: unknown; data?: unknown };
  const name = typeof obj.name === "string" ? obj.name : "Unknown";
  const data = (obj.data ?? {}) as {
    statusCode?: unknown;
    message?: unknown;
    responseBody?: unknown;
    isRetryable?: unknown;
  };
  const statusCode = typeof data.statusCode === "number" ? data.statusCode : undefined;
  const dataMessage = typeof data.message === "string" ? data.message : undefined;
  const message = dataMessage ?? name;

  let providerErrorType: string | undefined;
  if (typeof data.responseBody === "string") {
    try {
      const parsedBody = JSON.parse(data.responseBody);
      const errType = parsedBody?.error?.type ?? parsedBody?.error?.code;
      if (typeof errType === "string") providerErrorType = errType;
    } catch {
      // responseBody is not JSON; no provider error.type to extract.
    }
  }

  if (name === "ProviderModelNotFoundError") {
    return { category: "model", provenance: "stream", message, statusCode };
  }
  if (name === "ProviderAuthError") {
    return { category: "auth", provenance: "stream", message, statusCode };
  }
  if (name === "ContextOverflowError") {
    // Explicitly excluded from capacity per docs/phase0-capacity-signals.md.
    return { category: "task", provenance: "stream", message, statusCode };
  }

  if (name === "APIError") {
    const isCapacityStatus = statusCode === 429 || statusCode === 529 || statusCode === 503;
    const isCapacityProviderType =
      providerErrorType === "rate_limit_error" ||
      providerErrorType === "rate_limit_exceeded" ||
      providerErrorType === "overloaded_error" ||
      providerErrorType === "insufficient_quota";
    const isQuotaExhausted =
      providerErrorType === "insufficient_quota" || (statusCode === 429 && data.isRetryable === false);
    if (isCapacityStatus || isCapacityProviderType || isQuotaExhausted) {
      return { category: "capacity", provenance: "stream", message, statusCode };
    }
    if (statusCode === 401 || /unauthoriz/i.test(message)) {
      return { category: "auth", provenance: "stream", message, statusCode };
    }
    return { category: "transport", provenance: "stream", message, statusCode };
  }

  if (name === "Unknown" && dataMessage !== undefined) {
    // Bug fix 2: AI SDK retry-exhaustion wrapper -- no statusCode, but a
    // stable "Failed after N attempts. Last error: ..." prefix on the error
    // channel (see docs/phase0-capacity-signals.md A3).
    const retryMatch = /^Failed after \d+ attempts\.\s*Last error:\s*([\s\S]*)$/.exec(dataMessage);
    if (retryMatch) {
      const lastError = retryMatch[1] ?? "";
      if (/rate.?limit|too many requests|\b429\b|\b529\b|\b503\b|overloaded|quota|capacity/i.test(lastError)) {
        return { category: "capacity", provenance: "inferred", message: dataMessage };
      }
      return { category: "transport", provenance: "inferred", message: dataMessage };
    }
  }

  return { category: "unknown", provenance: "stream", message, statusCode };
}

export interface JsonlParserOptions {
  maxCostUsd?: number;
  /** Invoked exactly once, the first time accumulated cost exceeds maxCostUsd. */
  onCostCapExceeded?: () => void;
}

export class JsonlParser {
  private sessionID: string | undefined;
  private readonly textAcc = new TextAccumulator();
  private lastStepFinish: StepFinishInfo | undefined;
  private totalCost = 0;
  private readonly errorMessages: string[] = [];
  private readonly structuredErrors: StructuredError[] = [];
  private malformedLines = 0;
  private oversizedLines = 0;
  private costCapExceeded = false;
  private costCapFired = false;

  constructor(private readonly opts: JsonlParserOptions = {}) {}

  noteOversizedLine(): void {
    this.oversizedLines++;
  }

  feedLine(rawLine: string): void {
    if (rawLine.length === 0) return;
    if (Buffer.byteLength(rawLine, "utf8") > MAX_LINE_BYTES) {
      this.oversizedLines++;
      return;
    }

    let event: any;
    try {
      event = JSON.parse(rawLine);
    } catch {
      this.malformedLines++;
      return;
    }

    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      this.malformedLines++;
      return;
    }

    if (this.sessionID === undefined && typeof event.sessionID === "string") {
      this.sessionID = event.sessionID;
    }

    const type = event.type;
    const part = event.part;

    if (type === "text" && part && typeof part.text === "string") {
      this.textAcc.append(part.text);
    } else if (type === "step_finish" && part) {
      this.lastStepFinish = {
        reason: part.reason,
        tokens: part.tokens,
        cost: typeof part.cost === "number" ? part.cost : undefined,
      };
      if (typeof part.cost === "number") {
        this.totalCost += part.cost;
      }
      if (
        !this.costCapFired &&
        this.opts.maxCostUsd !== undefined &&
        this.totalCost > this.opts.maxCostUsd
      ) {
        this.costCapFired = true;
        this.costCapExceeded = true;
        this.opts.onCostCapExceeded?.();
      }
    } else if (type === "error") {
      // Same priority order as the original: part.message, then part.error,
      // then event.message, then event.error, then a JSON.stringify fallback.
      // The difference (bug fix): if the resolved candidate is an object
      // (opencode's real envelope: event.error = {name, data}), extract it
      // into a StructuredError instead of coercing it with String().
      const rawCandidate: unknown =
        (part && (part.message || part.error)) || event.message || event.error;

      let message: string;
      if (rawCandidate && typeof rawCandidate === "object") {
        const structured = classifyErrorEvent(rawCandidate);
        this.structuredErrors.push(structured);
        message = structured.message;
      } else if (rawCandidate) {
        message = String(rawCandidate);
      } else {
        message = JSON.stringify(event);
      }

      if (this.errorMessages.length < MAX_ERROR_MESSAGES) {
        this.errorMessages.push(redact(String(message).slice(0, MAX_ERROR_CHARS)));
      }
    }
    // Other event types (step_start, tool_use/tool, etc.) are intentionally ignored.
  }

  getResult(): ParsedResult {
    return {
      sessionID: this.sessionID,
      text: this.textAcc.toString(),
      totalTextChars: this.textAcc.totalChars,
      lastStepFinish: this.lastStepFinish,
      totalCost: this.totalCost,
      errorMessages: this.errorMessages,
      malformedLines: this.malformedLines,
      oversizedLines: this.oversizedLines,
      costCapExceeded: this.costCapExceeded,
      structuredErrors: [...this.structuredErrors],
    };
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

export type Agent = "build" | "plan";
export type SettleReason = RunReason;

const FORCE_FINALIZE_MS = 8_000;

export interface RunOpencodeOptions {
  model: string;
  cwd: string;
  agent: Agent;
  prompt: string;
  variant?: string;
  sessionID?: string;
  timeoutSec: number;
  maxCostUsd?: number;
  signal?: AbortSignal;
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
  _spawnOverride?: { command: string; args: string[] };
  _timeoutMsOverride?: number;
  _forceFinalizeMsOverride?: number;
}

export interface RunOpencodeOutcome {
  reason: SettleReason;
  exitCode: number | null;
  parsed: ParsedResult;
  stderrTail: string;
  elapsedSec: number;
}

export function buildArgs(opts: RunOpencodeOptions): string[] {
  const args = [
    "run",
    "-m",
    opts.model,
    "--dir",
    opts.cwd,
    "--agent",
    opts.agent,
    "--format",
    "json",
    "--print-logs",
    "--log-level",
    "ERROR",
  ];
  args.push(...extraPermissionArgs(opts.agent));
  if (opts.variant) {
    args.push("--variant", opts.variant);
  }
  if (opts.sessionID) {
    args.push("-s", opts.sessionID);
  }
  args.push(opts.prompt);
  return args;
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        // Best effort; finalization still has a force timer.
      }
    }
  }
}

function killProcessGroup(pid: number): Promise<void> {
  return new Promise((resolveKill) => {
    signalTree(pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      signalTree(pid, "SIGKILL");
      resolveKill();
    }, 5000);
    killTimer.unref?.();
  });
}

/**
 * Spawn `opencode run ...` and resolve once the child has fully exited and
 * both stdout/stderr streams have drained. Exactly one of
 * {exit, abort, timeout, cost-cap} determines the settled `reason`; whichever
 * happens first wins and later triggers are no-ops. Streams are drained to
 * completion regardless of when the reason settles, to avoid the child
 * deadlocking on a full pipe buffer.
 */
export function runOpencode(opts: RunOpencodeOptions): Promise<RunOpencodeOutcome> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    if (opts.signal?.aborted) {
      resolve({
        reason: "abort",
        exitCode: null,
        parsed: new JsonlParser().getResult(),
        stderrTail: "",
        elapsedSec: (Date.now() - startTime) / 1000,
      });
      return;
    }

    const command = opts._spawnOverride?.command ?? "opencode";
    const args = opts._spawnOverride?.args ?? buildArgs(opts);
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrRing = new RingBuffer();
    let reason: SettleReason | undefined;
    let exitCode: number | null = null;
    let killTriggered = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatCounter = 0;
    let childExited = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let finalized = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceFinalizeTimer: NodeJS.Timeout | undefined;
    let hardFinalizeTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const parser = new JsonlParser({
      maxCostUsd: opts.maxCostUsd,
      onCostCapExceeded: () => settle("cost-cap"),
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stdoutSplitter = new LineSplitter(
      (line) => parser.feedLine(line),
      () => parser.noteOversizedLine(),
    );
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutDrained = false;
    let stderrDrained = false;
    function drainStdout() {
      if (stdoutDrained) return;
      stdoutDrained = true;
      stdoutSplitter.push(stdoutDecoder.end());
      stdoutSplitter.flush();
    }
    function drainStderr() {
      if (stderrDrained) return;
      stderrDrained = true;
      stderrRing.push(stderrDecoder.end());
    }

    function clearHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    }

    function triggerKill() {
      if (killTriggered) return;
      killTriggered = true;
      if (typeof child.pid === "number") {
        void killProcessGroup(child.pid);
      }
    }

    function settle(newReason: SettleReason) {
      if (reason !== undefined) return;
      reason = newReason;
      clearHeartbeat();
      if (newReason !== "exit") {
        triggerKill();
        hardFinalizeTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          drainStdout();
          drainStderr();
          childExited = true;
          stdoutClosed = true;
          stderrClosed = true;
          maybeFinalize();
        }, opts._forceFinalizeMsOverride ?? FORCE_FINALIZE_MS);
        hardFinalizeTimer.unref?.();
      }
      maybeFinalize();
    }

    function maybeFinalize() {
      if (finalized) return;
      if (reason === undefined) return;
      if (!childExited || !stdoutClosed || !stderrClosed) return;
      finalized = true;
      clearHeartbeat();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceFinalizeTimer) clearTimeout(forceFinalizeTimer);
      if (hardFinalizeTimer) clearTimeout(hardFinalizeTimer);
      if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
      const elapsedSec = (Date.now() - startTime) / 1000;
      resolve({
        reason,
        exitCode,
        parsed: parser.getResult(),
        stderrTail: redact(stderrRing.toString()),
        elapsedSec,
      });
    }

    if (opts.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        heartbeatCounter++;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        opts.onHeartbeat!(elapsed, heartbeatCounter);
      }, 15000);
      heartbeatTimer.unref?.();
    }

    timeoutTimer = setTimeout(
      () => settle("timeout"),
      opts._timeoutMsOverride ?? opts.timeoutSec * 1000,
    );
    timeoutTimer.unref?.();

    if (opts.signal) {
      abortListener = () => settle("abort");
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutSplitter.push(typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk));
      });
      child.stdout.on("close", () => {
        drainStdout();
        stdoutClosed = true;
        maybeFinalize();
      });
    } else {
      stdoutClosed = true;
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) =>
        stderrRing.push(typeof chunk === "string" ? chunk : stderrDecoder.write(chunk)),
      );
      child.stderr.on("close", () => {
        drainStderr();
        stderrClosed = true;
        maybeFinalize();
      });
    } else {
      stderrClosed = true;
    }

    child.on("exit", (code) => {
      exitCode = code;
      childExited = true;
      settle("exit");
      if (!finalized) {
        forceFinalizeTimer = setTimeout(() => {
          drainStdout();
          drainStderr();
          stdoutClosed = true;
          stderrClosed = true;
          maybeFinalize();
        }, 3000);
        forceFinalizeTimer.unref?.();
      }
      maybeFinalize();
    });

    child.on("error", (err) => {
      stderrRing.push(`\n[spawn error] ${String(err)}`);
      exitCode = exitCode ?? null;
      childExited = true;
      settle("exit");
      if (!finalized) {
        forceFinalizeTimer = setTimeout(() => {
          drainStdout();
          drainStderr();
          stdoutClosed = true;
          stderrClosed = true;
          maybeFinalize();
        }, 3000);
        forceFinalizeTimer.unref?.();
      }
      maybeFinalize();
    });
  });
}

// ---------------------------------------------------------------------------
// Structured classification (router-facing)
// ---------------------------------------------------------------------------

/**
 * Full structured classification for a completed run, combining the
 * stream-derived signals captured during parsing with spawn/timeout signals
 * only visible at the process-lifecycle layer. See
 * docs/phase0-capacity-signals.md section (b) "OpenCode" rule table.
 */
export function classifyOpencode(outcome: {
  reason: SettleReason;
  stderrTail: string;
  parsed: Pick<ParsedResult, "structuredErrors">;
}): StructuredError[] {
  const result: StructuredError[] = [...outcome.parsed.structuredErrors];

  if (outcome.reason === "timeout") {
    result.push({
      category: "timeout",
      provenance: "timeout",
      message: "run exceeded the configured timeout",
    });
  }

  if (/\[spawn error\][^\n]*ENOENT/i.test(outcome.stderrTail)) {
    result.push({
      category: "transport",
      provenance: "spawn",
      message: "opencode CLI not found on PATH (spawn ENOENT)",
    });
  }

  return result;
}

/**
 * Human-readable message for the highest-priority structured classification,
 * or undefined if nothing actionable was found (callers should fall back to
 * classifyError(stderrTail, model) and then a generic exit-code message, in
 * that order, matching the pre-refactor behavior).
 */
export function describeOpencodeFailure(
  errors: StructuredError[],
  model: string,
): string | undefined {
  const byCategory = (cat: ErrorCategory) => errors.find((e) => e.category === cat);

  const modelErr = byCategory("model");
  if (modelErr) {
    return `Model not found: ${model}. Run opencode_models to list available models.`;
  }
  const authErr = byCategory("auth");
  if (authErr) {
    return "Provider not authenticated. Run `opencode auth login` for this provider.";
  }
  const capacityErr = byCategory("capacity");
  if (capacityErr) {
    const statusSuffix = capacityErr.statusCode ? ` [HTTP ${capacityErr.statusCode}]` : "";
    return `Provider capacity error (rate limited or overloaded)${statusSuffix}: ${capacityErr.message}`;
  }
  const transportErr = byCategory("transport");
  if (transportErr && transportErr.provenance === "spawn") {
    return "opencode CLI not found on PATH. Ensure `opencode` is installed and available.";
  }
  return undefined;
}
