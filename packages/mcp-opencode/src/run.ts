/**
 * Thin backward-compat re-export shim. The real implementation moved to
 * packages/core/src/backends/opencode.ts (Phase 1 refactor). Kept so tests
 * importing `../src/run.js` by relative path keep working.
 */
export {
  runOpencode,
  buildArgs,
  type Agent,
  type SettleReason,
  type RunOpencodeOptions,
  type RunOpencodeOutcome,
} from "../../core/src/backends/opencode.js";
