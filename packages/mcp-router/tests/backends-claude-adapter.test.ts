// Focused unit test for the claude adapter's FAILURE OVERRIDE mapping: `claude
// -p` exits 0 even on a headless permission-denial / error_max_turns /
// is_error, so ClaudeBackend#run must force ok:false in those cases rather
// than trusting the process exit code. runClaude is mocked (not spawned) so
// this exercises exactly the adapter's mapping logic.

import { describe, it, expect, vi, beforeEach } from "vitest";

const runClaudeMock = vi.fn();

vi.mock("@mcp-coding-agents/core/backends/claude.js", async () => {
  const actual = await vi.importActual<typeof import("@mcp-coding-agents/core/backends/claude.js")>(
    "@mcp-coding-agents/core/backends/claude.js",
  );
  return {
    ...actual,
    runClaude: (...args: unknown[]) => runClaudeMock(...args),
  };
});

const { ClaudeBackend } = await import("../src/backends/claude.js");

function baseReq() {
  return {
    prompt: "do the thing",
    cwd: process.cwd(),
    model: "opus",
    provider: "anthropic",
    timeoutSec: 60,
    signal: new AbortController().signal,
  };
}

function parsed(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    permissionDenialCount: 0,
    rateLimited: false,
    text: "",
    totalTextChars: 0,
    errorMessages: [],
    malformedLines: 0,
    oversizedLines: 0,
    unknownEvents: 0,
    ...overrides,
  };
}

describe("ClaudeBackend#run failure override", () => {
  beforeEach(() => {
    runClaudeMock.mockReset();
  });

  it("subtype error_max_turns -> ok:false, even though exitCode was 0", async () => {
    runClaudeMock.mockResolvedValue({
      reason: "exit",
      exitCode: 0,
      elapsedSec: 1,
      stderrTail: "",
      sessionID: "sess-1",
      parsed: parsed({
        subtype: "error_max_turns",
        isError: true,
        resultText: "Reached max turns",
        text: "partial progress",
      }),
    });

    const backend = new ClaudeBackend();
    const out = await backend.run(baseReq());
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.message.includes("turn limit"))).toBe(true);
  });

  it("is_error:true -> ok:false", async () => {
    runClaudeMock.mockResolvedValue({
      reason: "exit",
      exitCode: 0,
      elapsedSec: 1,
      stderrTail: "",
      sessionID: "sess-2",
      parsed: parsed({
        subtype: "error_during_execution",
        isError: true,
        resultText: "boom",
      }),
    });

    const backend = new ClaudeBackend();
    const out = await backend.run(baseReq());
    expect(out.ok).toBe(false);
  });

  it("permission_denials > 0 -> ok:false AND the blocked-tools message is present", async () => {
    runClaudeMock.mockResolvedValue({
      reason: "exit",
      exitCode: 0,
      elapsedSec: 1,
      stderrTail: "",
      sessionID: "sess-3",
      parsed: parsed({
        subtype: "success",
        isError: false,
        resultText: "",
        permissionDenialCount: 2,
      }),
    });

    const backend = new ClaudeBackend();
    const out = await backend.run(baseReq());
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.message.includes("blocked 2 tool call"))).toBe(true);
    expect(out.errors.some((e) => e.message.includes("bypassPermissions"))).toBe(true);
  });

  it("clean success (subtype success, no denials, text) -> ok:true", async () => {
    runClaudeMock.mockResolvedValue({
      reason: "exit",
      exitCode: 0,
      elapsedSec: 1,
      stderrTail: "",
      sessionID: "sess-4",
      parsed: parsed({
        subtype: "success",
        isError: false,
        resultText: "the answer is 42",
        permissionDenialCount: 0,
      }),
    });

    const backend = new ClaudeBackend();
    const out = await backend.run(baseReq());
    expect(out.ok).toBe(true);
    expect(out.text).toBe("the answer is 42");
  });

  it("a timeout keeps reason=timeout (no exit-code override) and is still ok:false", async () => {
    runClaudeMock.mockResolvedValue({
      reason: "timeout",
      exitCode: null,
      elapsedSec: 60,
      stderrTail: "",
      sessionID: undefined,
      parsed: parsed({ text: "partial" }),
    });

    const backend = new ClaudeBackend();
    const out = await backend.run(baseReq());
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.category === "timeout")).toBe(true);
  });
});
