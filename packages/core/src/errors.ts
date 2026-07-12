/**
 * Structured error contract shared by every backend and consumed by the
 * mcp-router (Phase 2) for fallback/cooldown decisions. See
 * docs/phase0-capacity-signals.md for the classification rationale.
 */

export type ErrorCategory =
  | "transport"
  | "capacity"
  | "auth"
  | "model"
  | "timeout"
  | "task"
  | "empty"
  | "unknown";

/**
 * Where the classification signal came from. The router should trust
 * `stream` / `spawn` / `timeout` over `inferred` (free-text keyword match).
 */
export type Provenance = "spawn" | "exit" | "stream" | "timeout" | "inferred";

export interface StructuredError {
  category: ErrorCategory;
  provenance: Provenance;
  message: string;
  statusCode?: number;
}
