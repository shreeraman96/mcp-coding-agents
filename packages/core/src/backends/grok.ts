/**
 * Grok Build CLI backend: argv construction, process lifecycle, streaming
 * JSONL parsing, and error classification. Moved (not merged) from
 * packages/mcp-grok/src/{run,parse,policy}.ts.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { createRedactor, boundText } from "../text.js";
import type { StructuredError } from "../errors.js";
import type { RunReason } from "../types.js";
import {
  HEAD_CAP,
  TAIL_CAP,
  TRUNCATE_THRESHOLD,
  MAX_LINE_BYTES,
  STDERR_RING_CAP,
  TextAccumulator,
  RingBuffer,
  LineSplitter,
  trimTrailingHighSurrogate,
} from "./stream-utils.js";
import { signalTree, killProcessGroup } from "./process-group.js";

export { HEAD_CAP, TAIL_CAP, TRUNCATE_THRESHOLD, MAX_LINE_BYTES, STDERR_RING_CAP, RingBuffer, LineSplitter };

export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_MAX_TURNS = 8;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 3600;
export const MAX_TURNS = 100;

/** Grok model IDs are simple names in addition to namespaced IDs. */
export const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:+@/-]*[A-Za-z0-9])?$/;

/** Grok Build session IDs observed in v0.2.93 are canonical UUIDv4 values. */
export const SESSION_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Redact credentials and sensitive local paths before returning diagnostics.
 * The patterns cover xAI/Grok key shapes plus the obvious generic forms used
 * by CLIs. This is intentionally applied to stderr, parser error events, and
 * assistant text returned by the MCP adapter.
 */
const GROK_REDACTION_PATTERNS: RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/etc.) -- redact the whole block.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /\bxai[-_][A-Za-z0-9._-]{8,}\b/gi,
  /\b(?:xai|grok)[-_](?:api[_-]?key|token|secret|key)[-_]?[A-Za-z0-9._-]{8,}\b/gi,
  /\bgrok_[A-Za-z0-9._-]{16,}\b/gi,
  /\b(?:sk|sk-proj)-[A-Za-z0-9_-]{8,}\b/g,
  // AWS access key IDs (AKIA/ASIA/AGPA/...) and GitHub tokens.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi,
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)=)[^&\s]+/gi,
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
];

export const redact = createRedactor({
  patterns: GROK_REDACTION_PATTERNS,
  pathRedactors: [
    {
      pattern: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.grok\/sessions\/[^\s"')]+/g,
      replacement: "~/.grok/sessions/[REDACTED]",
    },
    {
      pattern: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.grok\/(?!sessions\/)[^\s"')]+/g,
      replacement: "~/.grok/[REDACTED]",
    },
  ],
});

export function validateTimeoutSec(timeoutSec: number): void {
  if (!Number.isInteger(timeoutSec) || timeoutSec < MIN_TIMEOUT_SEC || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new RangeError(`timeoutSec must be an integer from ${MIN_TIMEOUT_SEC} to ${MAX_TIMEOUT_SEC}`);
  }
}

export function validateMaxTurns(maxTurns: number): void {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_TURNS) {
    throw new RangeError(`maxTurns must be an integer from 1 to ${MAX_TURNS}`);
  }
}

/** Convert safely observable Grok failures into actionable MCP errors. */
export function classifyError(diagnostic: string, model: string): string | undefined {
  // Only a spawn-level ENOENT means the `grok` binary is missing. A bare ENOENT
  // in the diagnostic is usually a file the agent's own tooling could not open,
  // which must not be reported as "CLI not found".
  if (/spawn\s+grok\s+ENOENT|grok(?: build)? cli[^\n]*not found|\bcommand not found:\s*grok\b/i.test(diagnostic)) {
    return "Grok CLI not found on PATH. Install Grok Build CLI and ensure `grok` is available.";
  }
  if (
    /No auth credentials for cli-chat-proxy|auth\.x\.ai|not logged in|unauthoriz|authentication|credential|\b401\b|api key/i.test(
      diagnostic,
    )
  ) {
    return "Grok authentication is unavailable. Run `grok login` (or configure the CLI credentials), then retry.";
  }
  if (
    /model[^\n]*(?:not found|unknown|unavailable|invalid)|not in available models|no auth-visible selectable model|model_id/i.test(
      diagnostic,
    )
  ) {
    return `Grok model not found or unavailable: ${model}. Run grok_models to list available models.`;
  }
  if (/FS_PERMISSION_DENIED|permission denied|operation not permitted/i.test(diagnostic)) {
    return "Grok could not access its session or working directory; verify filesystem permissions and the configured cwd.";
  }
  return undefined;
}

/**
 * Structured classification (router-facing), restricted to the error-event
 * channel (stdout `type:"error"` message text + stderr tail) per
 * docs/phase0-capacity-signals.md: Grok's only documented error surface is
 * free text, so this is keyword matching with provenance "inferred" --
 * never a sole fallback trigger for the router. `classifyError` above (the
 * pre-existing, directly-tested string classifier) remains the source of
 * truth for the text shown to MCP clients today; this is additive.
 */
export function classifyGrok(diagnostic: string): StructuredError[] {
  const result: StructuredError[] = [];

  if (/spawn\s+grok\s+ENOENT|grok(?: build)? cli[^\n]*not found|\bcommand not found:\s*grok\b/i.test(diagnostic)) {
    result.push({
      category: "transport",
      provenance: "spawn",
      message: "Grok CLI not found on PATH.",
    });
    return result;
  }

  if (
    /No auth credentials for cli-chat-proxy|auth\.x\.ai|not logged in|unauthoriz|authentication|credential|\b401\b|api key/i.test(
      diagnostic,
    )
  ) {
    result.push({
      category: "auth",
      provenance: "inferred",
      message: "Grok authentication is unavailable.",
    });
  }

  if (/rate.?limit|too many requests|\b429\b|quota|usage limit|overloaded|capacity/i.test(diagnostic)) {
    result.push({
      category: "capacity",
      provenance: "inferred",
      message: "Possible capacity/rate-limit failure (advisory; Grok has no structured signal today).",
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Streaming JSONL parser
// ---------------------------------------------------------------------------

const MAX_ERROR_MESSAGES = 8;
const MAX_ERROR_CHARS = 4_000;

export interface ParsedResult {
  sessionID?: string;
  stopReason?: string;
  text: string;
  totalTextChars: number;
  errorMessages: string[];
  malformedLines: number;
  oversizedLines: number;
  unknownEvents: number;
}

function eventSessionID(event: Record<string, unknown>): string | undefined {
  const value = event.sessionId ?? event.sessionID;
  return typeof value === "string" ? value : undefined;
}

function errorText(event: Record<string, unknown>): string | undefined {
  const candidates = [event.message, event.error, event.data];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return trimTrailingHighSurrogate(candidate.slice(0, MAX_ERROR_CHARS));
    }
  }
  return undefined;
}

/**
 * Incrementally parses Grok Build CLI `--output-format streaming-json`.
 *
 * Observed v0.2.93 events are `{type:"thought",data}`,
 * `{type:"text",data}`, and `{type:"end",stopReason,sessionId,requestId}`.
 * Thought and unknown/tool events are deliberately discarded.
 */
export class StreamingJsonParser {
  private sessionID: string | undefined;
  private stopReason: string | undefined;
  private readonly textAcc = new TextAccumulator();
  private readonly errorMessages: string[] = [];
  private malformedLines = 0;
  private oversizedLines = 0;
  private unknownEvents = 0;

  noteOversizedLine(): void {
    this.oversizedLines++;
  }

  feedLine(rawLine: string): void {
    if (rawLine.length === 0) return;
    if (Buffer.byteLength(rawLine, "utf8") > MAX_LINE_BYTES) {
      this.oversizedLines++;
      return;
    }

    let event: unknown;
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

    const record = event as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string") {
      this.unknownEvents++;
      return;
    }

    switch (type) {
      case "thought":
        return;
      case "text":
        if (typeof record.data === "string") {
          this.textAcc.append(record.data);
        }
        return;
      case "end": {
        const sessionID = eventSessionID(record);
        if (this.sessionID === undefined && sessionID !== undefined) {
          this.sessionID = sessionID;
        }
        if (typeof record.stopReason === "string") {
          this.stopReason = record.stopReason;
        }
        return;
      }
      case "error": {
        const message = errorText(record);
        if (message !== undefined && this.errorMessages.length < MAX_ERROR_MESSAGES) {
          this.errorMessages.push(redact(message));
        }
        return;
      }
      default:
        this.unknownEvents++;
    }
  }

  getResult(): ParsedResult {
    return {
      sessionID: this.sessionID,
      stopReason: this.stopReason,
      text: this.textAcc.toString(),
      totalTextChars: this.textAcc.totalChars,
      errorMessages: [...this.errorMessages],
      malformedLines: this.malformedLines,
      oversizedLines: this.oversizedLines,
      unknownEvents: this.unknownEvents,
    };
  }
}

/** Short alias for callers that prefer the CLI's JSONL terminology. */
export { StreamingJsonParser as JsonlParser };

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

export type GrokRunMode = "new" | "reply";
export type SettleReason = Exclude<RunReason, "cost-cap">;

export interface BuildArgsOptions {
  mode: GrokRunMode;
  model: string;
  cwd: string;
  sessionID: string;
  promptFile: string;
  leaderSocket: string;
  maxTurns: number;
  effort?: string;
  allowAuto?: boolean;
}

export interface RunGrokOptions {
  model: string;
  cwd: string;
  prompt: string;
  sessionID?: string;
  mode?: GrokRunMode;
  effort?: string;
  maxTurns?: number;
  timeoutSec?: number;
  signal?: AbortSignal;
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
  _spawnOverride?: { command: string; args?: string[]; prefixArgs?: string[] };
  _timeoutMsOverride?: number;
  _forceFinalizeMsOverride?: number;
}

export interface RunGrokOutcome {
  reason: SettleReason;
  exitCode: number | null;
  parsed: ParsedResult;
  stderrTail: string;
  elapsedSec: number;
  sessionID: string;
}

export const DEFAULT_PERMISSION_MODE = "auto" as const;
export const FORCE_FINALIZE_MS = 8_000;

export function newSessionID(): string {
  return randomUUID();
}

function validateEffort(effort: string | undefined): void {
  if (effort !== undefined && !/^[A-Za-z0-9._-]+$/.test(effort)) {
    throw new RangeError("effort must contain only letters, numbers, dots, underscores, or hyphens");
  }
}

function validateBuildArgs(opts: BuildArgsOptions): void {
  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Grok model: ${opts.model}`);
  }
  if (!SESSION_RE.test(opts.sessionID)) {
    throw new RangeError("sessionID must be a canonical UUIDv4");
  }
  validateMaxTurns(opts.maxTurns);
  validateEffort(opts.effort);
}

export function buildArgs(opts: BuildArgsOptions): string[] {
  validateBuildArgs(opts);

  const args = [
    "--no-auto-update",
    "--cwd",
    opts.cwd,
    "--model",
    opts.model,
    "--output-format",
    "streaming-json",
    opts.mode === "reply" ? "--resume" : "--session-id",
    opts.sessionID,
    "--prompt-file",
    opts.promptFile,
  ];

  if (opts.effort !== undefined) {
    args.push("--effort", opts.effort);
  }

  if (opts.allowAuto ?? process.env.GROK_MCP_ALLOW_AUTO === "1") {
    args.push("--always-approve");
  } else {
    args.push("--permission-mode", DEFAULT_PERMISSION_MODE);
  }

  args.push(
    "--max-turns",
    String(opts.maxTurns),
    "--no-memory",
    "--no-subagents",
    "--verbatim",
    "--leader-socket",
    opts.leaderSocket,
  );
  return args;
}

interface RunResources {
  directory: string;
  promptFile: string;
  leaderSocket: string;
}

async function createResources(prompt: string): Promise<RunResources> {
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-grok-"));
  const promptFile = path.join(directory, "prompt.txt");
  const leaderSocket = path.join(directory, "leader.sock");
  try {
    await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(promptFile, 0o600);
    return { directory, promptFile, leaderSocket };
  } catch (err) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function cleanupResources(resources: RunResources): Promise<void> {
  await rm(resources.directory, { recursive: true, force: true }).catch(() => undefined);
}

function makeParsedWithRequestedSession(parser: StreamingJsonParser, sessionID: string): ParsedResult {
  const parsed = parser.getResult();
  return parsed.sessionID === undefined ? { ...parsed, sessionID } : parsed;
}

/**
 * Run one independent Grok CLI process with detached process-group cleanup.
 * Exit/abort/timeout use first-settlement-wins semantics; stdout and stderr
 * continue draining before the resources are removed and the promise settles.
 */
export async function runGrok(opts: RunGrokOptions): Promise<RunGrokOutcome> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  validateTimeoutSec(timeoutSec);
  validateMaxTurns(maxTurns);
  validateEffort(opts.effort);

  const mode = opts.mode ?? (opts.sessionID === undefined ? "new" : "reply");
  if (mode === "reply" && opts.sessionID === undefined) {
    throw new RangeError("reply mode requires a sessionID");
  }
  const sessionID = opts.sessionID ?? newSessionID();
  if (!SESSION_RE.test(sessionID)) {
    throw new RangeError("sessionID must be a canonical UUIDv4");
  }
  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Grok model: ${opts.model}`);
  }

  const resources = await createResources(opts.prompt);
  const startTime = Date.now();

  if (opts.signal?.aborted) {
    await cleanupResources(resources);
    return {
      reason: "abort",
      exitCode: null,
      parsed: {
        sessionID,
        text: "",
        totalTextChars: 0,
        errorMessages: [],
        malformedLines: 0,
        oversizedLines: 0,
        unknownEvents: 0,
      },
      stderrTail: "",
      elapsedSec: (Date.now() - startTime) / 1000,
      sessionID,
    };
  }

  let generatedArgs: string[];
  try {
    generatedArgs = buildArgs({
      mode,
      model: opts.model,
      cwd: opts.cwd,
      sessionID,
      promptFile: resources.promptFile,
      leaderSocket: resources.leaderSocket,
      maxTurns,
      effort: opts.effort,
    });
  } catch (err) {
    await cleanupResources(resources);
    throw err;
  }
  const args =
    opts._spawnOverride?.args ?? [...(opts._spawnOverride?.prefixArgs ?? []), ...generatedArgs];
  const command = opts._spawnOverride?.command ?? "grok";

  return new Promise<RunGrokOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      void cleanupResources(resources).finally(() => {
        resolve({
          reason: "exit",
          exitCode: null,
          parsed: {
            sessionID,
            text: "",
            totalTextChars: 0,
            errorMessages: [],
            malformedLines: 0,
            oversizedLines: 0,
            unknownEvents: 0,
          },
          stderrTail: redact(`[spawn error] ${String(err)}`),
          elapsedSec: (Date.now() - startTime) / 1000,
          sessionID,
        });
      });
      return;
    }

    const parser = new StreamingJsonParser();
    const stderrRing = new RingBuffer(STDERR_RING_CAP);
    let reason: SettleReason | undefined;
    let exitCode: number | null = null;
    let childExited = false;
    let stdoutClosed = !child.stdout;
    let stderrClosed = !child.stderr;
    let killTriggered = false;
    let finalized = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceFinalizeTimer: NodeJS.Timeout | undefined;
    let hardFinalizeTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let heartbeatCounter = 0;

    const stdoutDecoder = new StringDecoder("utf8");
    const stdoutSplitter = new LineSplitter(
      (line) => parser.feedLine(line),
      () => parser.noteOversizedLine(),
    );
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutDrained = false;
    let stderrDrained = false;
    const drainStdout = () => {
      if (stdoutDrained) return;
      stdoutDrained = true;
      stdoutSplitter.push(stdoutDecoder.end());
      stdoutSplitter.flush();
    };
    const drainStderr = () => {
      if (stderrDrained) return;
      stderrDrained = true;
      stderrRing.push(stderrDecoder.end());
    };

    const clearTimers = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceFinalizeTimer) clearTimeout(forceFinalizeTimer);
      if (hardFinalizeTimer) clearTimeout(hardFinalizeTimer);
      if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
      heartbeatTimer = undefined;
      timeoutTimer = undefined;
      forceFinalizeTimer = undefined;
      hardFinalizeTimer = undefined;
    };

    const triggerKill = () => {
      if (killTriggered || typeof child.pid !== "number") return;
      killTriggered = true;
      void killProcessGroup(child.pid);
    };

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimers();
      const parsed = makeParsedWithRequestedSession(parser, sessionID);
      const finalReason = reason ?? "exit";
      const outcome: RunGrokOutcome = {
        reason: finalReason,
        exitCode,
        parsed,
        stderrTail: boundText(redact(stderrRing.toString()), STDERR_RING_CAP),
        elapsedSec: (Date.now() - startTime) / 1000,
        sessionID,
      };
      void cleanupResources(resources).finally(() => resolve(outcome));
    };

    const maybeFinalize = () => {
      if (childExited && stdoutClosed && stderrClosed) finalize();
    };

    const settle = (next: SettleReason) => {
      if (reason !== undefined) return;
      reason = next;
      if (next !== "exit") {
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
          finalize();
        }, opts._forceFinalizeMsOverride ?? FORCE_FINALIZE_MS);
        hardFinalizeTimer.unref?.();
      }
      maybeFinalize();
    };

    if (opts.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        heartbeatCounter++;
        opts.onHeartbeat?.(Math.round((Date.now() - startTime) / 1000), heartbeatCounter);
      }, 15_000);
      heartbeatTimer.unref?.();
    }

    timeoutTimer = setTimeout(
      () => settle("timeout"),
      opts._timeoutMsOverride ?? timeoutSec * 1000,
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
    }

    const armExitDrainTimer = () => {
      if (finalized) return;
      forceFinalizeTimer = setTimeout(() => {
        drainStdout();
        drainStderr();
        stdoutClosed = true;
        stderrClosed = true;
        maybeFinalize();
      }, 3_000);
      forceFinalizeTimer.unref?.();
    };

    child.on("exit", (code) => {
      exitCode = code;
      childExited = true;
      settle("exit");
      armExitDrainTimer();
      maybeFinalize();
    });

    child.on("error", (err) => {
      stderrRing.push(`\n[spawn error] ${String(err)}`);
      childExited = true;
      settle("exit");
      armExitDrainTimer();
      maybeFinalize();
    });
  });
}

/** Alias with an explicit name for callers/tests. */
export { buildArgs as buildGrokArgs };
