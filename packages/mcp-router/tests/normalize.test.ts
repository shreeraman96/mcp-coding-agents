import { describe, it, expect } from "vitest";

import { normalizeOutcome, type CoreRunOutcome } from "../src/normalize.js";

function core(partial: Partial<CoreRunOutcome>): CoreRunOutcome {
  return {
    reason: "exit",
    exitCode: 0,
    elapsedSec: 1,
    parsedText: "",
    errorMessages: [],
    ...partial,
  };
}

describe("normalizeOutcome", () => {
  it("exit 0 with assistant text is ok", () => {
    const out = normalizeOutcome(core({ parsedText: "the answer" }), [], "grok");
    expect(out.ok).toBe(true);
    expect(out.errors).toHaveLength(0);
  });

  it("exit 0 with error messages but NO text is a task failure, not an empty success (finding #4)", () => {
    const out = normalizeOutcome(core({ parsedText: "", errorMessages: ["boom"] }), [], "codex");
    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.category)).toContain("task");
  });

  it("exit 0 with neither text nor errors is an empty failure", () => {
    const out = normalizeOutcome(core({ parsedText: "" }), [], "opencode");
    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.category)).toContain("empty");
  });

  it("a timeout emits a timeout error even when the classifier produced none (finding #3)", () => {
    // classifyGrok/classifyCodex cannot emit a timeout category; simulate their
    // empty classification on a timed-out run.
    const out = normalizeOutcome(core({ reason: "timeout", exitCode: null, elapsedSec: 42 }), [], "grok");
    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.category)).toContain("timeout");
  });

  it("does not duplicate a timeout error the classifier already emitted", () => {
    const out = normalizeOutcome(
      core({ reason: "timeout", exitCode: null }),
      [{ category: "timeout", provenance: "timeout", message: "opencode timed out" }],
      "opencode",
    );
    expect(out.errors.filter((e) => e.category === "timeout")).toHaveLength(1);
  });
});
