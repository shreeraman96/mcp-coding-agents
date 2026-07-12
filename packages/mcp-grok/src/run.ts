/**
 * Thin backward-compat re-export shim. The real implementation moved to
 * packages/core/src/backends/grok.ts (Phase 1 refactor). Kept so tests
 * importing `../src/run.js` by relative path keep working.
 */
export {
  runGrok,
  buildArgs,
  buildGrokArgs,
  cleanupResources,
  newSessionID,
  DEFAULT_PERMISSION_MODE,
  FORCE_FINALIZE_MS,
  type GrokRunMode,
  type SettleReason,
  type BuildArgsOptions,
  type RunGrokOptions,
  type RunGrokOutcome,
} from "../../core/src/backends/grok.js";
