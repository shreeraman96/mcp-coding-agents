/**
 * Claude Code CLI (`claude -p`) backend: argv construction, process lifecycle,
 * streaming JSONL parsing, and error classification. Structure mirrors
 * backends/codex.ts and backends/grok.ts (byte-cap / truncation / line-
 * splitting / process-group infra shared via ./stream-utils.js and
 * ./process-group.js); the event interpretation and process-lifecycle
 * details specific to `claude -p` (stdin-delivered prompt, no lastMessageFile,
 * headless permission-denial false-success) live here.
 */

import { spawn, type ChildProcess } from "node:child_process";
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
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 3600;
export const DEFAULT_MAX_TURNS = 30;
export const MAX_TURNS = 100;

/** Claude model IDs/aliases are simple names (e.g. "opus", "sonnet", "haiku",
 * or a full concrete id like "claude-opus-4-1-20250805"). No slash -- a slash
 * means a mislabeled opencode/anthropic id. */
export const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

/** Headless permission handling for `claude -p`. `default`/`plan` are NOT
 * offered: they false-succeed (stdin EOF auto-denies every tool call but the
 * run still reports exit 0 / subtype "success"). */
export const PERMISSION_MODES = ["acceptEdits", "bypassPermissions"] as const;
export type ClaudePermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: ClaudePermissionMode = "acceptEdits";

/**
 * Redact credentials and sensitive local paths before returning diagnostics.
 * The secret-shaped patterns cover the generic credential forms any CLI passes
 * through, plus Anthropic `sk-ant-...` keys; path folding targets
 * ~/.claude/sessions/ and ~/.claude/.
 */
const CLAUDE_REDACTION_PATTERNS: RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/etc.) -- redact the whole block.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
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
  patterns: CLAUDE_REDACTION_PATTERNS,
  pathRedactors: [
    {
      pattern: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.claude\/sessions\/[^\s"')]+/g,
      replacement: "~/.claude/sessions/[REDACTED]",
    },
    {
      pattern: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.claude\/(?!sessions\/)[^\s"')]+/g,
      replacement: "~/.claude/[REDACTED]",
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

/**
 * Structured classification (router-facing), restricted to the error-event
 * channel (stderr tail + the parser's collected error messages, which include
 * the `result` field text on a non-success/error terminal event). `claude -p`
 * exits 0 even on a headless permission-denial or `error_max_turns`, so this
 * classifier is deliberately advisory (provenance "inferred") except for the
 * spawn-ENOENT case -- the router's failure-override (see the mcp-router
 * adapter) is what makes exitCode/ok trustworthy, not this text match.
 */
export function classifyClaude(diagnostic: string, opts?: { rateLimited?: boolean }): StructuredError[] {
  const result: StructuredError[] = [];

  // Only a spawn-level ENOENT means the `claude` binary is missing. A bare
  // ENOENT in the diagnostic is usually a file the agent's own tooling could
  // not open, which must not be reported as "CLI not found".
  if (/spawn\s+claude\s+ENOENT|\bcommand not found:\s*claude\b|claude(?: cli)?[^\n]*not found/i.test(diagnostic)) {
    result.push({
      category: "transport",
      provenance: "spawn",
      message: "Claude CLI not found on PATH.",
    });
    return result;
  }

  if (
    /invalid api key|not logged in|please run \/login|\/login|session expired|invalid_grant|token (refresh|expired)|oauth|credit balance|unauthoriz|authentication_error|\b401\b|\b403\b/i.test(
      diagnostic,
    )
  ) {
    result.push({
      category: "auth",
      provenance: "inferred",
      message: "Claude authentication is unavailable.",
    });
  }

  if (
    opts?.rateLimited === true ||
    /rate.?limit|too many requests|\b429\b|\b529\b|quota|usage limit|overloaded|capacity|reached your .*limit/i.test(
      diagnostic,
    )
  ) {
    result.push({
      category: "capacity",
      provenance: opts?.rateLimited === true ? "stream" : "inferred",
      message: "Possible capacity/rate-limit failure.",
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
  /** Concrete resolved model id from `system/init`, even when an alias
   * (e.g. "haiku") was requested. */
  resolvedModel?: string;
  /** `result` event subtype: "success" | "error_max_turns" |
   * "error_during_execution" (observed values; treated as opaque text). */
  subtype?: string;
  isError?: boolean;
  /** AUTHORITATIVE final text from the terminal `result` event, when seen. */
  resultText?: string;
  /** Count of `permission_denials` entries on the terminal `result` event. */
  permissionDenialCount: number;
  /** Set when a `rate_limit_event` reports a non-"allowed" status. */
  rateLimited: boolean;
  /** Fallback text accumulated from streamed assistant `text` blocks. */
  text: string;
  totalTextChars: number;
  errorMessages: string[];
  malformedLines: number;
  oversizedLines: number;
  unknownEvents: number;
}

/**
 * Incrementally parses `claude -p --output-format stream-json --verbose`
 * JSONL events.
 *
 * Observed top-level `type`s: `system` (subtype `init` captures session_id +
 * resolved `model`; subtype `thinking_tokens` and others are ignored),
 * `assistant` (message.content[] blocks; only `type:"text"` blocks are
 * appended -- `thinking` blocks are discarded), `user` (tool results;
 * ignored), `rate_limit_event` (structured capacity signal), and the
 * terminal `result` event (subtype/is_error/result text/permission_denials/
 * session_id).
 */
export class StreamingJsonParser {
  private sessionID: string | undefined;
  private resolvedModel: string | undefined;
  private subtype: string | undefined;
  private isError: boolean | undefined;
  private resultText: string | undefined;
  private permissionDenialCount = 0;
  private rateLimited = false;
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
      case "system": {
        if (record.subtype === "init") {
          const sessionID = record.session_id;
          if (this.sessionID === undefined && typeof sessionID === "string") {
            this.sessionID = sessionID;
          }
          const model = record.model;
          if (typeof model === "string") {
            this.resolvedModel = model;
          }
        }
        // Other system subtypes (e.g. "thinking_tokens") carry no result data.
        return;
      }
      case "assistant": {
        const message = record.message;
        if (message !== null && typeof message === "object" && !Array.isArray(message)) {
          const content = (message as Record<string, unknown>).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
              const b = block as Record<string, unknown>;
              if (b.type === "text" && typeof b.text === "string") {
                this.textAcc.append(b.text);
              }
              // "thinking" and any other block type are deliberately ignored.
            }
          }
        }
        return;
      }
      case "user":
        // Tool results; not part of the assistant's final answer.
        return;
      case "rate_limit_event": {
        const info = record.rate_limit_info;
        if (info !== null && typeof info === "object" && !Array.isArray(info)) {
          const status = (info as Record<string, unknown>).status;
          if (typeof status === "string" && status !== "allowed") {
            this.rateLimited = true;
          }
        }
        return;
      }
      case "result": {
        if (typeof record.subtype === "string") this.subtype = record.subtype;
        if (typeof record.is_error === "boolean") this.isError = record.is_error;
        if (typeof record.result === "string") this.resultText = record.result;
        const denials = record.permission_denials;
        if (Array.isArray(denials)) this.permissionDenialCount = denials.length;
        const sessionID = record.session_id;
        if (this.sessionID === undefined && typeof sessionID === "string") {
          this.sessionID = sessionID;
        }
        const failed = this.isError === true || (this.subtype !== undefined && this.subtype !== "success");
        if (failed && typeof record.result === "string" && record.result.length > 0) {
          this.addErrorMessage(record.result);
        }
        return;
      }
      default:
        this.unknownEvents++;
    }
  }

  private addErrorMessage(raw: string): void {
    if (this.errorMessages.length >= MAX_ERROR_MESSAGES) return;
    if (raw.length === 0) return;
    const sliced = trimTrailingHighSurrogate(raw.slice(0, MAX_ERROR_CHARS));
    this.errorMessages.push(redact(sliced));
  }

  getResult(): ParsedResult {
    return {
      sessionID: this.sessionID,
      resolvedModel: this.resolvedModel,
      subtype: this.subtype,
      isError: this.isError,
      resultText: this.resultText,
      permissionDenialCount: this.permissionDenialCount,
      rateLimited: this.rateLimited,
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

export type SettleReason = Exclude<RunReason, "cost-cap">;

export interface BuildArgsOptions {
  model: string;
  permissionMode: ClaudePermissionMode;
  maxTurns: number;
  allowedTools?: string[];
}

export interface RunClaudeOptions {
  model: string;
  cwd: string;
  prompt: string;
  permissionMode?: ClaudePermissionMode;
  maxTurns?: number;
  /** Pass-through to `--allowedTools <rule> ...` (variadic). Pre-approves
   * scoped tools headless. A `Bash(...)` rule is escapable via command
   * chaining and is NOT a sandbox boundary -- it grants effectively full
   * shell to an untrusted prompt, same risk class as bypassPermissions. */
  allowedTools?: string[];
  timeoutSec?: number;
  signal?: AbortSignal;
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
  _spawnOverride?: { command: string; args?: string[]; prefixArgs?: string[] };
  _timeoutMsOverride?: number;
  _forceFinalizeMsOverride?: number;
}

export interface RunClaudeOutcome {
  reason: SettleReason;
  exitCode: number | null;
  parsed: ParsedResult;
  stderrTail: string;
  elapsedSec: number;
  /** Claude session id observed from `system/init` or the terminal `result`
   * event, if any. */
  sessionID?: string;
}

export const FORCE_FINALIZE_MS = 8_000;

/** A tool name, optionally followed by a `(...)` arg spec, e.g. "WebFetch" or
 * "Read(./docs/**)". No newlines inside the arg spec. */
export const ALLOWED_TOOL_RULE_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\([^)\n\r]*\))?$/;
export const MAX_ALLOWED_TOOLS = 32;
export const MAX_ALLOWED_TOOL_LEN = 200;

function validateAllowedTools(allowedTools: string[] | undefined): void {
  if (allowedTools === undefined) return;
  if (allowedTools.length > MAX_ALLOWED_TOOLS) {
    throw new RangeError(`allowedTools accepts at most ${MAX_ALLOWED_TOOLS} rules; got ${allowedTools.length}`);
  }
  for (const rule of allowedTools) {
    if (rule.length > MAX_ALLOWED_TOOL_LEN || !ALLOWED_TOOL_RULE_RE.test(rule)) {
      throw new RangeError(`invalid allowedTools rule: ${rule}`);
    }
  }
}

function validateBuildArgs(opts: BuildArgsOptions): void {
  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Claude model: ${opts.model}`);
  }
  if (!(PERMISSION_MODES as readonly string[]).includes(opts.permissionMode)) {
    throw new RangeError(`invalid Claude permissionMode: ${opts.permissionMode}`);
  }
  validateMaxTurns(opts.maxTurns);
  validateAllowedTools(opts.allowedTools);
}

function emptyParsed(): ParsedResult {
  return {
    permissionDenialCount: 0,
    rateLimited: false,
    text: "",
    totalTextChars: 0,
    errorMessages: [],
    malformedLines: 0,
    oversizedLines: 0,
    unknownEvents: 0,
  };
}

/**
 * Build the argv for
 * `claude -p --output-format stream-json --verbose --model <m>
 *  --permission-mode <mode> --strict-mcp-config --mcp-config '{"mcpServers":{}}'
 *  --setting-sources '' --max-turns <N>`.
 * The prompt is delivered on the child's STDIN, never as a positional/argv
 * value (see runClaude). `--strict-mcp-config` + an empty `--mcp-config`
 * disables every inherited MCP server; `--setting-sources ''` disables
 * inherited settings/CLAUDE.md/hooks/skills. Both are REQUIRED on every spawn.
 */
export function buildArgs(opts: BuildArgsOptions): string[] {
  validateBuildArgs(opts);

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--permission-mode",
    opts.permissionMode,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--max-turns",
    String(opts.maxTurns),
  ];

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", ...opts.allowedTools);
  }

  return args;
}

/**
 * Run one independent `claude -p` process with detached process-group
 * cleanup. Exit/abort/timeout use first-settlement-wins semantics; stdout and
 * stderr continue draining before the promise settles. There is no
 * lastMessageFile (unlike codex): the AUTHORITATIVE final text is
 * `parsed.resultText` from the terminal `result` event when present and
 * non-empty; the accumulated streamed assistant `text` is the fallback for
 * runs that never reach a result event (kill / abort / timeout).
 */
export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeOutcome> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  validateTimeoutSec(timeoutSec);
  validateMaxTurns(maxTurns);

  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Claude model: ${opts.model}`);
  }
  if (!(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    throw new RangeError(`invalid Claude permissionMode: ${permissionMode}`);
  }

  const startTime = Date.now();

  if (opts.signal?.aborted) {
    return {
      reason: "abort",
      exitCode: null,
      parsed: emptyParsed(),
      stderrTail: "",
      elapsedSec: (Date.now() - startTime) / 1000,
    };
  }

  let generatedArgs: string[];
  try {
    generatedArgs = buildArgs({ model: opts.model, permissionMode, maxTurns, allowedTools: opts.allowedTools });
  } catch (err) {
    throw err;
  }
  const args =
    opts._spawnOverride?.args ?? [...(opts._spawnOverride?.prefixArgs ?? []), ...generatedArgs];
  const command = opts._spawnOverride?.command ?? "claude";

  return new Promise<RunClaudeOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        reason: "exit",
        exitCode: null,
        parsed: emptyParsed(),
        stderrTail: redact(`[spawn error] ${String(err)}`),
        elapsedSec: (Date.now() - startTime) / 1000,
      });
      return;
    }

    // The prompt is delivered on stdin ONLY, never argv. Ignore EPIPE/write
    // errors (a fast-failing child that never reads stdin must not crash the
    // caller); the child's own exit code / result event carries the failure.
    try {
      child.stdin?.on("error", () => undefined);
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } catch {
      // best effort
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

    const finalizeBody = (finalReason: SettleReason): void => {
      const parsed = parser.getResult();
      const outcome: RunClaudeOutcome = {
        reason: finalReason,
        exitCode,
        parsed,
        stderrTail: boundText(redact(stderrRing.toString()), STDERR_RING_CAP),
        elapsedSec: (Date.now() - startTime) / 1000,
        sessionID: parsed.sessionID,
      };
      resolve(outcome);
    };

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimers();
      finalizeBody(reason ?? "exit");
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
export { buildArgs as buildClaudeArgs };
