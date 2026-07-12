import { describe, it, expect } from "vitest";
import { classifyGrok, classifyError } from "../src/backends/grok.js";

describe("Grok structured classification (advisory, provenance inferred)", () => {
  it("classifies a spawn ENOENT as transport with provenance spawn", () => {
    const result = classifyGrok("spawn grok ENOENT");
    expect(result).toEqual([
      { category: "transport", provenance: "spawn", message: expect.stringContaining("not found") },
    ]);
  });

  it("classifies auth-shaped diagnostics as auth (inferred)", () => {
    const result = classifyGrok("No auth credentials for cli-chat-proxy");
    expect(result.some((e) => e.category === "auth" && e.provenance === "inferred")).toBe(true);
  });

  it("classifies rate-limit keywords as capacity (inferred), restricted to the diagnostic text passed in", () => {
    const result = classifyGrok("error: 429 too many requests, please slow down");
    expect(result.some((e) => e.category === "capacity" && e.provenance === "inferred")).toBe(true);
  });

  it("does not classify ordinary diagnostics as anything", () => {
    expect(classifyGrok("some unrelated stderr output")).toEqual([]);
  });

  it("legacy classifyError (directly tested, unchanged text) still works standalone", () => {
    expect(classifyError("spawn grok ENOENT", "grok-4.5")).toMatch(/not found/);
  });
});
