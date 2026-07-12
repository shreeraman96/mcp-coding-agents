import type { StructuredError } from "./errors.js";

export type RunReason = "exit" | "abort" | "timeout" | "cost-cap";

/** Shared shape of a completed backend run, generic over the backend-specific
 * parsed-output type (opencode's ParsedResult vs grok's ParsedResult differ
 * in fields beyond the common text/error bookkeeping). */
export interface RunOutcome<TParsed> {
  reason: RunReason;
  exitCode: number | null;
  parsed: TParsed;
  /** Redacted tail of stderr. */
  stderrTail: string;
  elapsedSec: number;
  sessionID?: string;
  structuredErrors: StructuredError[];
}

/**
 * Result emptiness decision
 * ----------------
 * On a clean (exit 0) run, decide whether the result is genuinely empty. A
 * build run can legitimately edit files and emit no final text event (a known
 * missing-step_finish upstream bug in opencode), so on-disk changes count as
 * a real result. Identical logic in both products today.
 */
export function isEmptyResult(args: {
  hasText: boolean;
  hasError: boolean;
  hasChanges: boolean;
}): boolean {
  return !args.hasText && !args.hasError && !args.hasChanges;
}
