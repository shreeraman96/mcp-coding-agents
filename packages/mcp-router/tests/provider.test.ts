import { describe, it, expect } from "vitest";

import { deriveProvider, crossesProvider, isAggregatorProvider } from "../src/provider.js";

describe("deriveProvider", () => {
  it("claude always derives to anthropic, regardless of model", () => {
    expect(deriveProvider("claude", undefined)).toBe("anthropic");
    expect(deriveProvider("claude", "opus")).toBe("anthropic");
    expect(deriveProvider("claude", "claude-opus-4-1-20250805")).toBe("anthropic");
  });

  it("grok always derives to xai; codex always derives to openai (unchanged)", () => {
    expect(deriveProvider("grok", undefined)).toBe("xai");
    expect(deriveProvider("codex", undefined)).toBe("openai");
  });

  it("anthropic is not treated as an aggregator provider", () => {
    expect(isAggregatorProvider("anthropic")).toBe(false);
  });

  it("crossesProvider treats anthropic like any other concrete provider", () => {
    expect(crossesProvider("anthropic", "anthropic")).toBe(false);
    expect(crossesProvider("anthropic", "openai")).toBe(true);
    expect(crossesProvider("anthropic", "xai")).toBe(true);
  });
});
