// The single place a backend RunOutcome becomes a NormalizedOutcome -- i.e.
// where the fallback-eligibility category is born. Both adapters call this so
// the decision cannot drift between backends (previously copy-pasted).

import type { RunReason } from "@mcp-coding-agents/core";
import type { StructuredError } from "@mcp-coding-agents/core/errors.js";
import type { NormalizedOutcome } from "./types.js";

export interface CoreRunOutcome {
  reason: RunReason; // "exit" | "abort" | "timeout" | "cost-cap"
  exitCode: number | null;
  elapsedSec: number;
  /** Already redacted assistant text. */
  parsedText: string;
  /** Non-fatal errors observed on the run's error channel. */
  errorMessages: string[];
  sessionId?: string;
}

export function normalizeOutcome(
  core: CoreRunOutcome,
  classified: StructuredError[],
  backendLabel: string,
): NormalizedOutcome {
  const errors: StructuredError[] = [...classified];
  const text = core.parsedText;
  let ok: boolean;

  if (core.reason === "exit" && core.exitCode === 0) {
    const hasText = text.trim().length > 0;
    if (hasText) {
      ok = true;
    } else {
      // Exit 0 but no assistant text: there is no answer to hand back, so do NOT
      // report an empty body as success (that returned blank successes to the
      // caller). Error-channel messages present but no text is a stronger signal
      // the run failed despite the 0 exit, so bucket it as a task failure;
      // otherwise it is a genuine empty result.
      ok = false;
      const hasError = core.errorMessages.length > 0;
      errors.push(
        hasError
          ? { category: "task", provenance: "exit", message: `${backendLabel} exited 0 with errors but produced no result` }
          : { category: "empty", provenance: "exit", message: `${backendLabel} returned an empty result` },
      );
    }
  } else if (core.reason === "exit") {
    ok = false;
    if (errors.length === 0) {
      errors.push({ category: "task", provenance: "exit", message: `${backendLabel} exited with code ${core.exitCode}` });
    }
  } else if (core.reason === "timeout") {
    // Not every classifier emits a timeout error (only classifyOpencode, which
    // sees `reason`; classifyGrok/classifyCodex take a plain diagnostic string
    // and cannot). Ensure a timeout category is present so the route trace and
    // cooldown logic never mislabel a timed-out attempt as `ok`.
    ok = false;
    if (!errors.some((error) => error.category === "timeout")) {
      errors.push({ category: "timeout", provenance: "timeout", message: `${backendLabel} timed out after ${Math.round(core.elapsedSec)}s` });
    }
  } else if (core.reason === "abort") {
    ok = false; // the router detects client abort via the AbortSignal
  } else {
    ok = false;
    errors.push({ category: "task", provenance: "exit", message: "cost cap exceeded" });
  }

  return { ok, errors, text, sessionId: core.sessionId, elapsedSec: core.elapsedSec, exitCode: core.exitCode };
}
