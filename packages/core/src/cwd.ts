import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Roots allowlist
 * ----------------
 * `envVar` is a colon-separated list of directories. A cwd passed to a tool
 * call must resolve (via fs.realpath, so symlinks are followed) to a path
 * inside one of these roots (also realpath'd). This is the security
 * boundary; the only difference between the two wrappers' original copies
 * was the env var name (OPENCODE_MCP_ROOTS vs GROK_MCP_ROOTS) -- parameterized
 * here so mcp-router (Phase 2) can reuse it with MCP_ROUTER_ROOTS.
 */
export function getConfiguredRoots(envVar: string, defaultRoots: string[]): string[] {
  const raw = process.env[envVar];
  if (raw && raw.trim().length > 0) {
    return raw
      .split(":")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  return defaultRoots;
}

export interface CwdValidationResult {
  ok: boolean;
  resolved?: string;
  error?: string;
}

export interface ValidateCwdOptions {
  rootsEnvVar: string;
  /** Defaults to $HOME/Projects, matching both products' original default. */
  defaultRoots?: string[];
  /**
   * grok's original validateCwd stat'd each configured root and required it
   * to be a directory *before* realpath'ing it into the allowlist; opencode's
   * original realpath'd every configured root directly, skipping only on a
   * realpath error. This is a real, pre-existing behavior difference between
   * the two products (not merely a naming difference), so it is preserved
   * here as an explicit option rather than silently unified. opencode passes
   * false (its original behavior); grok passes true.
   */
  requireRootIsDirectory: boolean;
}

/**
 * Validate that `cwd` is inside one of the allowed roots. Both the roots and
 * the candidate cwd are resolved with fs.realpath so that symlink escapes are
 * caught (e.g. a symlink inside an allowed root pointing outside of it). A
 * cwd must also be a directory because it will be passed as the child process
 * cwd.
 *
 * Residual TOCTOU: the realpath'd string is handed to spawn, so a path component
 * swapped to an out-of-root symlink between this check and spawn could escape.
 * That requires write access to a component of an allowed root, i.e. a same-user
 * local actor -- the same trust boundary that could invoke this MCP server
 * directly -- so it is an accepted limitation rather than a closed hole.
 */
export async function validateCwd(
  cwd: string,
  opts: ValidateCwdOptions,
): Promise<CwdValidationResult> {
  const defaultRoots = opts.defaultRoots ?? [path.join(homedir(), "Projects")];
  const roots = getConfiguredRoots(opts.rootsEnvVar, defaultRoots);

  let resolvedCwd: string;
  try {
    resolvedCwd = await realpath(cwd);
    if (!(await stat(resolvedCwd)).isDirectory()) {
      return { ok: false, error: `cwd is not a directory: ${cwd}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `cwd does not exist or is not accessible: ${cwd} (${(err as Error).message})`,
    };
  }

  const resolvedRoots: string[] = [];
  for (const root of roots) {
    try {
      if (opts.requireRootIsDirectory) {
        if ((await stat(root)).isDirectory()) {
          resolvedRoots.push(await realpath(root));
        }
      } else {
        resolvedRoots.push(await realpath(root));
      }
    } catch {
      // Root itself doesn't exist on disk (or a missing configured root
      // cannot authorize a request); skip it as a valid allowlist entry.
    }
  }

  if (resolvedRoots.length === 0) {
    return {
      ok: false,
      error: `no configured root directories exist on disk (${opts.rootsEnvVar}=${roots.join(":")})`,
    };
  }

  const inside = resolvedRoots.some((root) => {
    if (resolvedCwd === root) return true;
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolvedCwd.startsWith(withSep);
  });

  if (!inside) {
    return {
      ok: false,
      error: `cwd "${cwd}" (resolved: ${resolvedCwd}) is outside the allowed roots: ${resolvedRoots.join(", ")}. Set ${opts.rootsEnvVar} to widen access.`,
    };
  }

  return { ok: true, resolved: resolvedCwd };
}
