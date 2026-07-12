/**
 * Thin backward-compat re-export shim.
 *
 * The real implementations moved to packages/core (Phase 1 refactor); this
 * file exists only so tests that import `../src/policy.js` by relative path
 * keep working, and to preserve the pre-refactor single-argument
 * `validateCwd(cwd)` / `getConfiguredRoots()` signatures for this product by
 * binding in OPENCODE_MCP_ROOTS. Production code (index.ts) imports directly
 * from core.
 *
 * Uses a relative import into core's TypeScript source (not the
 * "@mcp-coding-agents/core" package specifier) so these tests never require
 * core to be pre-built -- vitest transforms .ts on the fly regardless of
 * package boundaries. index.ts, the real runtime entry point, uses the
 * package specifier per the Phase 1 plan.
 */
import { homedir } from "node:os";
import path from "node:path";
import { validateCwd as coreValidateCwd, getConfiguredRoots as coreGetConfiguredRoots } from "../../core/src/cwd.js";
import { stripAnsi, boundText } from "../../core/src/text.js";
import { isEmptyResult } from "../../core/src/types.js";
import {
  MODEL_RE,
  SESSION_RE,
  extraPermissionArgs,
  classifyError,
  redact,
} from "../../core/src/backends/opencode.js";

export { stripAnsi, boundText, isEmptyResult, MODEL_RE, SESSION_RE, extraPermissionArgs, classifyError, redact };

const ROOTS_ENV_VAR = "OPENCODE_MCP_ROOTS";
const DEFAULT_ROOTS = [path.join(homedir(), "Projects")];

export function getConfiguredRoots(): string[] {
  return coreGetConfiguredRoots(ROOTS_ENV_VAR, DEFAULT_ROOTS);
}

export interface CwdValidationResult {
  ok: boolean;
  resolved?: string;
  error?: string;
}

export async function validateCwd(cwd: string): Promise<CwdValidationResult> {
  return coreValidateCwd(cwd, { rootsEnvVar: ROOTS_ENV_VAR, requireRootIsDirectory: false });
}
