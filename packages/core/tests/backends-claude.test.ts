import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildArgs,
  buildClaudeArgs,
  classifyClaude,
  StreamingJsonParser,
  JsonlParser,
  LineSplitter,
  RingBuffer,
  runClaude,
  redact,
  validateTimeoutSec,
  validateMaxTurns,
  MODEL_RE,
  PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  MAX_LINE_BYTES,
  STDERR_RING_CAP,
  MIN_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  MAX_TURNS,
} from "../src/backends/claude.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const treeFixture = path.join(here, "fixtures", "tree.mjs");

// ---------------------------------------------------------------------------
// Verified real `claude -p` stream-json event fixtures
// ---------------------------------------------------------------------------

const EVENTS = {
  systemInit: {
    type: "system",
    subtype: "init",
    session_id: "sess-abc123",
    model: "claude-opus-4-1-20250805",
    permissionMode: "acceptEdits",
  },
  thinkingTokens: { type: "system", subtype: "thinking_tokens", tokens: 128 },
  assistantText: {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "PONG" },
      ],
    },
  },
  userToolResult: { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
  rateLimitAllowed: { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "requests" } },
  rateLimitBlocked: { type: "rate_limit_event", rate_limit_info: { status: "rate_limited", rateLimitType: "requests" } },
  resultSuccess: {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "FINAL ANSWER",
    session_id: "sess-abc123",
    permission_denials: [],
    num_turns: 3,
  },
  resultMaxTurns: {
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    result: "Reached max turns",
    session_id: "sess-abc123",
    permission_denials: [],
    num_turns: 30,
  },
  resultPermissionDenied: {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "sess-abc123",
    permission_denials: [{ tool_name: "Bash" }, { tool_name: "Write" }],
    num_turns: 1,
  },
  unknown: { type: "totally.unknown" },
} as const;

function feedAll(parser: StreamingJsonParser, lines: unknown[]) {
  for (const line of lines) parser.feedLine(JSON.stringify(line));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function baseRunOptions(overrides: Partial<Parameters<typeof runClaude>[0]> = {}) {
  return {
    model: "sonnet",
    cwd: process.cwd(),
    prompt: "say pong",
    timeoutSec: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildArgs / MODEL_RE / PERMISSION_MODES
// ---------------------------------------------------------------------------

describe("Claude buildArgs / buildClaudeArgs", () => {
  it("builds the exact argv order, with NO positional prompt", () => {
    const args = buildArgs({ model: "opus", permissionMode: "acceptEdits", maxTurns: 30 });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
      "--permission-mode",
      "acceptEdits",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--max-turns",
      "30",
    ]);
  });

  it("buildClaudeArgs is an alias of buildArgs", () => {
    const opts = { model: "haiku", permissionMode: "bypassPermissions" as const, maxTurns: 5 };
    expect(buildClaudeArgs(opts)).toEqual(buildArgs(opts));
  });

  it("throws RangeError for an invalid (slash-containing) model", () => {
    expect(() => buildArgs({ model: "anthropic/claude-opus", permissionMode: "acceptEdits", maxTurns: 30 })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError for an invalid permissionMode", () => {
    expect(() =>
      buildArgs({ model: "opus", permissionMode: "default" as any, maxTurns: 30 }),
    ).toThrow(RangeError);
    expect(() => buildArgs({ model: "opus", permissionMode: "plan" as any, maxTurns: 30 })).toThrow(RangeError);
  });

  it("throws RangeError for maxTurns out of range", () => {
    expect(() => buildArgs({ model: "opus", permissionMode: "acceptEdits", maxTurns: 0 })).toThrow(RangeError);
    expect(() => buildArgs({ model: "opus", permissionMode: "acceptEdits", maxTurns: MAX_TURNS + 1 })).toThrow(
      RangeError,
    );
  });

  it("MODEL_RE accepts aliases and concrete ids, rejects a slash", () => {
    expect(MODEL_RE.test("opus")).toBe(true);
    expect(MODEL_RE.test("sonnet")).toBe(true);
    expect(MODEL_RE.test("claude-opus-4-1-20250805")).toBe(true);
    expect(MODEL_RE.test("anthropic/claude-opus")).toBe(false);
    expect(MODEL_RE.test("")).toBe(false);
  });

  it("PERMISSION_MODES / DEFAULT_PERMISSION_MODE are locked to acceptEdits + bypassPermissions", () => {
    expect(PERMISSION_MODES).toEqual(["acceptEdits", "bypassPermissions"]);
    expect(DEFAULT_PERMISSION_MODE).toBe("acceptEdits");
  });

  it("appends --allowedTools + each rule, one argv item per rule, when provided", () => {
    const args = buildArgs({
      model: "opus",
      permissionMode: "acceptEdits",
      maxTurns: 30,
      allowedTools: ["WebFetch", "Read(./docs/**)"],
    });
    expect(args.slice(-3)).toEqual(["--allowedTools", "WebFetch", "Read(./docs/**)"]);
  });

  it("omits --allowedTools when absent or empty", () => {
    expect(buildArgs({ model: "opus", permissionMode: "acceptEdits", maxTurns: 30 })).not.toContain(
      "--allowedTools",
    );
    expect(
      buildArgs({ model: "opus", permissionMode: "acceptEdits", maxTurns: 30, allowedTools: [] }),
    ).not.toContain("--allowedTools");
  });

  it("throws RangeError for an allowedTools rule containing a newline", () => {
    expect(() =>
      buildArgs({
        model: "opus",
        permissionMode: "acceptEdits",
        maxTurns: 30,
        allowedTools: ["Bash(echo\nhi)"],
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError for an allowedTools rule with a bad charset", () => {
    expect(() =>
      buildArgs({
        model: "opus",
        permissionMode: "acceptEdits",
        maxTurns: 30,
        allowedTools: ["../etc/passwd"],
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError for more than 32 allowedTools rules", () => {
    expect(() =>
      buildArgs({
        model: "opus",
        permissionMode: "acceptEdits",
        maxTurns: 30,
        allowedTools: Array.from({ length: 33 }, (_, i) => `Tool${i}`),
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// StreamingJsonParser (verified real event shapes)
// ---------------------------------------------------------------------------

describe("Claude StreamingJsonParser / JsonlParser", () => {
  it("captures sessionID and resolvedModel from system/init", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.systemInit));
    const result = parser.getResult();
    expect(result.sessionID).toBe("sess-abc123");
    expect(result.resolvedModel).toBe("claude-opus-4-1-20250805");
  });

  it("ignores thinking_tokens and other non-init system subtypes", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.thinkingTokens));
    const result = parser.getResult();
    expect(result.sessionID).toBeUndefined();
    expect(result.malformedLines).toBe(0);
    expect(result.unknownEvents).toBe(0);
  });

  it("appends only type:text assistant blocks, ignoring thinking blocks", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.assistantText));
    const result = parser.getResult();
    expect(result.text).toBe("PONG");
    expect(result.text).not.toContain("let me think");
  });

  it("ignores user (tool result) events", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.userToolResult));
    const result = parser.getResult();
    expect(result.text).toBe("");
    expect(result.unknownEvents).toBe(0);
  });

  it("rate_limit_event with status allowed does NOT set rateLimited", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.rateLimitAllowed));
    expect(parser.getResult().rateLimited).toBe(false);
  });

  it("rate_limit_event with a non-allowed status sets rateLimited", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.rateLimitBlocked));
    expect(parser.getResult().rateLimited).toBe(true);
  });

  it("result event: text wins over assistant text as resultText, captures subtype/is_error/permission_denials", () => {
    const parser = new StreamingJsonParser();
    feedAll(parser, [EVENTS.systemInit, EVENTS.assistantText, EVENTS.resultSuccess]);
    const result = parser.getResult();
    expect(result.resultText).toBe("FINAL ANSWER");
    expect(result.text).toBe("PONG"); // streamed fallback text is untouched
    expect(result.subtype).toBe("success");
    expect(result.isError).toBe(false);
    expect(result.permissionDenialCount).toBe(0);
    expect(result.sessionID).toBe("sess-abc123");
  });

  it("assistant-text fallback when no result event is ever seen", () => {
    const parser = new StreamingJsonParser();
    feedAll(parser, [EVENTS.systemInit, EVENTS.assistantText]);
    const result = parser.getResult();
    expect(result.resultText).toBeUndefined();
    expect(result.text).toBe("PONG");
  });

  it("captures permission_denials count from the result event", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.resultPermissionDenied));
    expect(parser.getResult().permissionDenialCount).toBe(2);
  });

  it("error_max_turns result sets subtype/is_error and collects an error message", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.resultMaxTurns));
    const result = parser.getResult();
    expect(result.subtype).toBe("error_max_turns");
    expect(result.isError).toBe(true);
    expect(result.errorMessages).toContain("Reached max turns");
  });

  it("increments malformedLines on non-JSON without throwing", () => {
    const parser = new StreamingJsonParser();
    expect(() => parser.feedLine("not json{")).not.toThrow();
    expect(parser.getResult().malformedLines).toBe(1);
  });

  it("increments unknownEvents for an unrecognized top-level type", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.unknown));
    expect(parser.getResult().unknownEvents).toBe(1);
  });

  it("counts an oversized line without throwing", () => {
    const parser = new StreamingJsonParser();
    const huge = "x".repeat(MAX_LINE_BYTES + 10);
    expect(() => parser.feedLine(huge)).not.toThrow();
    expect(parser.getResult().oversizedLines).toBe(1);
  });

  it("JsonlParser is an alias of StreamingJsonParser", () => {
    expect(JsonlParser).toBe(StreamingJsonParser);
  });

  it("only the FIRST session id observed (init) wins over a later result session id mismatch", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.systemInit));
    parser.feedLine(JSON.stringify({ ...EVENTS.resultSuccess, session_id: "different-session" }));
    expect(parser.getResult().sessionID).toBe("sess-abc123");
  });
});

// ---------------------------------------------------------------------------
// classifyClaude
// ---------------------------------------------------------------------------

describe("Claude classifyClaude", () => {
  it("classifies spawn claude ENOENT as transport/spawn and returns early", () => {
    const result = classifyClaude("spawn claude ENOENT");
    expect(result).toEqual([
      { category: "transport", provenance: "spawn", message: expect.stringContaining("not found") },
    ]);
    expect(result).toHaveLength(1);
  });

  it("classifies command not found: claude as transport/spawn", () => {
    const result = classifyClaude("command not found: claude");
    expect(result.some((e) => e.category === "transport" && e.provenance === "spawn")).toBe(true);
  });

  it("classifies /login prompts as auth (inferred)", () => {
    const result = classifyClaude("Please run /login to authenticate");
    expect(result.some((e) => e.category === "auth" && e.provenance === "inferred")).toBe(true);
  });

  it("opts.rateLimited=true sets capacity even with no matching text", () => {
    const result = classifyClaude("nothing interesting here", { rateLimited: true });
    expect(result.some((e) => e.category === "capacity")).toBe(true);
  });

  it("classifies rate-limit / overloaded text as capacity (inferred)", () => {
    expect(classifyClaude("429 too many requests").some((e) => e.category === "capacity")).toBe(true);
    expect(classifyClaude("overloaded").some((e) => e.category === "capacity")).toBe(true);
  });

  it("returns [] for a benign ENOENT in agent text (regression guard)", () => {
    expect(classifyClaude("could not open file: ENOENT ./missing.txt")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LineSplitter / RingBuffer / redact / validateTimeoutSec / validateMaxTurns
// ---------------------------------------------------------------------------

describe("Claude LineSplitter", () => {
  function collect() {
    const lines: string[] = [];
    let oversized = 0;
    const splitter = new LineSplitter(
      (line) => lines.push(line),
      () => oversized++,
    );
    return { lines, splitter, oversizedCount: () => oversized };
  }

  it("reassembles lines split across chunk boundaries and strips CR", () => {
    const { lines, splitter } = collect();
    splitter.push("he");
    splitter.push("llo\r\nwor");
    splitter.push("ld\n");
    expect(lines).toEqual(["hello", "world"]);
  });

  it("drops a newline-less flood without unbounded buffering", () => {
    const { lines, splitter, oversizedCount } = collect();
    const chunk = "x".repeat(100_000);
    for (let fed = 0; fed <= MAX_LINE_BYTES + 500_000; fed += chunk.length) {
      splitter.push(chunk);
    }
    splitter.push("\n" + JSON.stringify({ type: "text" }) + "\n");
    expect(oversizedCount()).toBe(1);
    expect(lines).toEqual([JSON.stringify({ type: "text" })]);
  });
});

describe("Claude RingBuffer", () => {
  it("retains the most recent bytes within the cap", () => {
    const ring = new RingBuffer(10);
    ring.push("abcdefghij");
    ring.push("XYZ");
    expect(ring.toString()).toBe("defghijXYZ");
  });
});

describe("Claude redact / validateTimeoutSec / validateMaxTurns", () => {
  it("redacts sk-ant- keys and ~/.claude session paths", () => {
    expect(redact("token sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX leaked")).not.toContain(
      "ABCDEFGHIJKLMNOPQRSTUVWX",
    );
    expect(redact("see /Users/me/.claude/sessions/abc123.json")).toContain(
      "~/.claude/sessions/[REDACTED]",
    );
    expect(redact("see /Users/me/.claude/settings.json")).toContain("~/.claude/[REDACTED]");
  });

  it("validateTimeoutSec accepts the documented range and rejects out-of-range", () => {
    expect(() => validateTimeoutSec(MIN_TIMEOUT_SEC)).not.toThrow();
    expect(() => validateTimeoutSec(MAX_TIMEOUT_SEC)).not.toThrow();
    expect(() => validateTimeoutSec(MIN_TIMEOUT_SEC - 1)).toThrow(RangeError);
    expect(() => validateTimeoutSec(MAX_TIMEOUT_SEC + 1)).toThrow(RangeError);
  });

  it("validateMaxTurns accepts 1..MAX_TURNS and rejects out-of-range", () => {
    expect(() => validateMaxTurns(1)).not.toThrow();
    expect(() => validateMaxTurns(MAX_TURNS)).not.toThrow();
    expect(() => validateMaxTurns(0)).toThrow(RangeError);
    expect(() => validateMaxTurns(MAX_TURNS + 1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// runClaude lifecycle via _spawnOverride (mirrors backends-codex.test.ts)
// ---------------------------------------------------------------------------

describe("runClaude lifecycle (fake child process)", () => {
  it("happy path: prompt delivered on stdin + JSONL stdout + exit 0 -> result text authoritative", async () => {
    const script = [
      `let input = "";`,
      `process.stdin.on("data", (c) => { input += c; });`,
      `process.stdin.on("end", () => {`,
      `  const lines = [`,
      `    ${JSON.stringify(JSON.stringify(EVENTS.systemInit))},`,
      `    ${JSON.stringify(JSON.stringify(EVENTS.assistantText))},`,
      `    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "echo:" + input.trim(), session_id: "sess-abc123", permission_denials: [] }),`,
      `  ];`,
      `  for (const line of lines) process.stdout.write(line + "\\n");`,
      `  process.exit(0);`,
      `});`,
    ].join("");

    const outcome = await runClaude(
      baseRunOptions({
        prompt: "say pong",
        _spawnOverride: { command: process.execPath, args: ["-e", script] },
      }),
    );

    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.sessionID).toBe("sess-abc123");
    expect(outcome.parsed.resultText).toBe("echo:say pong");
    expect(outcome.parsed.subtype).toBe("success");
    expect(outcome.parsed.isError).toBe(false);
  });

  it("returns abort immediately when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runClaude(baseRunOptions({ signal: controller.signal }));
    expect(outcome.reason).toBe("abort");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.parsed.text).toBe("");
  });

  it("timeout kills the detached process group and grandchild", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "claude-tree-"));
    const pidFile = path.join(directory, "grandchild.pid");
    try {
      const outcome = await runClaude(
        baseRunOptions({
          _timeoutMsOverride: 1_000,
          _spawnOverride: { command: process.execPath, args: [treeFixture, pidFile] },
        }),
      );
      expect(outcome.reason).toBe("timeout");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(await waitUntilDead(pid)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("settles a normal child exit once", async () => {
    const outcome = await runClaude(
      baseRunOptions({
        _spawnOverride: { command: process.execPath, args: ["-e", "process.stdin.resume(); process.exit(0);"] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
  });

  it("reports spawn ENOENT without hanging", async () => {
    const outcome = await runClaude(
      baseRunOptions({
        _spawnOverride: { command: "/private/tmp/mcp-claude-command-does-not-exist", args: [] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderrTail).toMatch(/ENOENT/);
  });

  it("does not throw/crash on EPIPE when the child exits before reading stdin", async () => {
    const outcome = await runClaude(
      baseRunOptions({
        prompt: "x".repeat(50_000),
        _spawnOverride: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
  });
});
