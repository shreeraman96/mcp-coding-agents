/**
 * Thin backward-compat re-export shim. The real implementation moved to
 * packages/core/src/backends/grok.ts (Phase 1 refactor). Kept so tests
 * importing `../src/parse.js` by relative path keep working.
 */
export {
  JsonlParser,
  StreamingJsonParser,
  LineSplitter,
  RingBuffer,
  HEAD_CAP,
  TAIL_CAP,
  TRUNCATE_THRESHOLD,
  MAX_LINE_BYTES,
  STDERR_RING_CAP,
  type ParsedResult,
} from "../../core/src/backends/grok.js";
