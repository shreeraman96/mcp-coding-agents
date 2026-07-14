export interface Deadline {
  readonly startMs: number;
  readonly totalSec: number;
  remainingSec(nowMs: number): number;
  expired(nowMs: number): boolean;
}

export function createDeadline(totalSec: number, startMs: number): Deadline {
  return {
    startMs,
    totalSec,
    remainingSec(nowMs: number): number {
      return Math.max(0, totalSec - (nowMs - startMs) / 1000);
    },
    expired(nowMs: number): boolean {
      return totalSec - (nowMs - startMs) / 1000 <= 0;
    },
  };
}

export function attemptBudgetSec(args: {
  remainingSec: number;
  hasNextEntry: boolean;
  backendMinSec: number;
  cleanupReserveSec: number;
  minViableNextSec: number;
}): number | null {
  // Reserve the post-failure cleanup (fingerprint settle) plus the next
  // attempt's minimum ONLY when a next candidate exists. A terminal/only
  // attempt runs no settle (see fallback.ts's gate: it skips settling when
  // there is nothing to fall back to), so it owes no reserve and may use the
  // full remaining budget. Without this, a schema-legal short timeout (min 30s)
  // on a single-entry tier would reserve 30s of cleanup it never uses and
  // refuse to run anything. Floor before comparing: runners need an integer.
  let base = args.remainingSec;
  if (args.hasNextEntry) base -= args.cleanupReserveSec + args.minViableNextSec;
  const budget = Math.floor(base);
  return budget < args.backendMinSec ? null : budget;
}
