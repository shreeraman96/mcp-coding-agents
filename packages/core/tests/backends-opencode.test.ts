import { describe, it, expect } from "vitest";
import {
  JsonlParser,
  classifyErrorEvent,
  classifyOpencode,
  describeOpencodeFailure,
} from "../src/backends/opencode.js";

describe("bug fix 1: structured type:\"error\" event (opencode parse.ts ~265-272)", () => {
  it("extracts name/statusCode/responseBody instead of stringifying the object to [object Object]", () => {
    const parser = new JsonlParser();
    parser.feedLine(
      JSON.stringify({
        type: "error",
        sessionID: "ses_x",
        error: {
          name: "APIError",
          data: {
            statusCode: 529,
            isRetryable: true,
            responseBody: JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
          },
        },
      }),
    );
    const result = parser.getResult();

    expect(result.errorMessages).toHaveLength(1);
    expect(result.errorMessages[0]).not.toContain("[object Object]");
    expect(result.structuredErrors).toHaveLength(1);
    const structured = result.structuredErrors[0];
    expect(structured.category).toBe("capacity");
    expect(structured.provenance).toBe("stream");
    expect(structured.statusCode).toBe(529);
  });

  it("still handles the pre-existing string-message shape unchanged (part.message)", () => {
    const parser = new JsonlParser();
    parser.feedLine(
      JSON.stringify({
        type: "error",
        sessionID: "ses_x",
        part: { message: "ProviderModelNotFoundError: nope" },
      }),
    );
    const result = parser.getResult();
    expect(result.errorMessages).toHaveLength(1);
    expect(result.errorMessages[0]).toContain("ProviderModelNotFoundError");
    // No structured error is derived from a bare string message -- only from
    // an object-shaped error field (the opencode NamedError envelope).
    expect(result.structuredErrors).toHaveLength(0);
  });
});

describe("bug fix 2: AI-SDK retry-exhaustion wrapper unwrap", () => {
  it("classifies a retry-exhausted capacity failure (429/rate-limit in the trailing 'Last error')", () => {
    const structured = classifyErrorEvent({
      name: "Unknown",
      data: { message: "Failed after 3 attempts. Last error: APICallError: 429 you are being rate limited" },
    });
    expect(structured.category).toBe("capacity");
    expect(structured.provenance).toBe("inferred");
  });

  it("classifies a retry-exhausted non-capacity failure as transport (inferred)", () => {
    const structured = classifyErrorEvent({
      name: "Unknown",
      data: { message: "Failed after 3 attempts. Last error: getaddrinfo ENOTFOUND api.example.com" },
    });
    expect(structured.category).toBe("transport");
    expect(structured.provenance).toBe("inferred");
  });

  it("end to end via the parser: a retry-exhausted error event on stdout", () => {
    const parser = new JsonlParser();
    parser.feedLine(
      JSON.stringify({
        type: "error",
        error: { name: "Unknown", data: { message: "Failed after 5 attempts. Last error: 529 Overloaded" } },
      }),
    );
    const result = parser.getResult();
    expect(result.structuredErrors).toHaveLength(1);
    expect(result.structuredErrors[0].category).toBe("capacity");
    expect(result.errorMessages[0]).toContain("Failed after 5 attempts");
  });
});

describe("structured classification: known categories (docs/phase0-capacity-signals.md)", () => {
  it("429 -> capacity", () => {
    const s = classifyErrorEvent({ name: "APIError", data: { statusCode: 429, isRetryable: true } });
    expect(s.category).toBe("capacity");
  });

  it("529 (Anthropic overloaded_error) -> capacity", () => {
    const s = classifyErrorEvent({ name: "APIError", data: { statusCode: 529 } });
    expect(s.category).toBe("capacity");
  });

  it("insufficient_quota (responseBody.error.type) -> capacity", () => {
    const s = classifyErrorEvent({
      name: "APIError",
      data: {
        statusCode: 429,
        isRetryable: false,
        responseBody: JSON.stringify({ error: { type: "insufficient_quota" } }),
      },
    });
    expect(s.category).toBe("capacity");
  });

  it("rate_limit_error provider type -> capacity", () => {
    const s = classifyErrorEvent({
      name: "APIError",
      data: { responseBody: JSON.stringify({ error: { type: "rate_limit_error" } }) },
    });
    expect(s.category).toBe("capacity");
  });

  it("ProviderModelNotFoundError -> model", () => {
    const s = classifyErrorEvent({ name: "ProviderModelNotFoundError", data: { message: "not found" } });
    expect(s.category).toBe("model");
  });

  it("ProviderAuthError -> auth", () => {
    const s = classifyErrorEvent({ name: "ProviderAuthError", data: { message: "unauthorized" } });
    expect(s.category).toBe("auth");
  });

  it("401 statusCode -> auth", () => {
    const s = classifyErrorEvent({ name: "APIError", data: { statusCode: 401, message: "unauthorized" } });
    expect(s.category).toBe("auth");
  });

  it("ContextOverflowError -> task (never capacity)", () => {
    const s = classifyErrorEvent({ name: "ContextOverflowError", data: { message: "too long" } });
    expect(s.category).toBe("task");
  });

  it("plain 500 APIError with no provider capacity signal -> transport, not capacity", () => {
    const s = classifyErrorEvent({ name: "APIError", data: { statusCode: 500, isRetryable: true } });
    expect(s.category).toBe("transport");
  });

  it("classifyOpencode adds timeout (provenance timeout) when reason is timeout", () => {
    const errors = classifyOpencode({
      reason: "timeout",
      stderrTail: "",
      parsed: { structuredErrors: [] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ category: "timeout", provenance: "timeout" });
  });

  it("classifyOpencode adds transport (provenance spawn) on spawn ENOENT", () => {
    const errors = classifyOpencode({
      reason: "exit",
      stderrTail: "\n[spawn error] Error: spawn opencode ENOENT",
      parsed: { structuredErrors: [] },
    });
    expect(errors.some((e) => e.category === "transport" && e.provenance === "spawn")).toBe(true);
  });

  it("describeOpencodeFailure prioritizes model > auth > capacity > transport", () => {
    expect(
      describeOpencodeFailure([{ category: "model", provenance: "stream", message: "x" }], "anthropic/claude"),
    ).toContain("Model not found");
    expect(
      describeOpencodeFailure([{ category: "auth", provenance: "stream", message: "x" }], "anthropic/claude"),
    ).toMatch(/not authenticated/);
    expect(
      describeOpencodeFailure(
        [{ category: "capacity", provenance: "stream", message: "overloaded", statusCode: 529 }],
        "anthropic/claude",
      ),
    ).toMatch(/capacity/i);
    expect(describeOpencodeFailure([], "anthropic/claude")).toBeUndefined();
  });
});
