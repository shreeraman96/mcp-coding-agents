/**
 * Thin backward-compat re-export shim. The real implementation moved to
 * packages/core/src/backends/opencode.ts (Phase 1 refactor). Kept so tests
 * importing `../src/parse.js` by relative path keep working.
 */
export {
  JsonlParser,
  LineSplitter,
  RingBuffer,
  MAX_LINE_BYTES,
  classifyErrorEvent,
  type ParsedResult,
  type StepFinishInfo,
  type JsonlParserOptions,
} from "../../core/src/backends/opencode.js";
