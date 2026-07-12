/**
 * Thin backward-compat re-export shim. The real implementation moved to
 * packages/core/src/queue.ts (Phase 1 refactor, identical between both
 * products). Kept so tests importing `../src/queue.js` by relative path
 * keep working.
 */
export { CwdQueue } from "../../core/src/queue.js";
