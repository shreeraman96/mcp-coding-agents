// `mcp-router --check`: a config doctor. It answers one question — "will the
// running server accept this config?" — by loading the config through the EXACT
// production path (loadConfig -> hardened open + perms/owner/parent checks +
// schema + provider derivation + authorize). It never re-implements any of that
// validation, so it cannot drift from what the server actually enforces.

import { loadConfig, defaultConfigPath } from "./config.js";
import { SPAWNABLE } from "./backends/registry.js";
import { TIER_NAMES, CAPABILITIES } from "./types.js";
import type { BackendName, DetectResult } from "./types.js";

export interface CheckIO {
  /** Human-readable report lines (stdout). */
  print(line: string): void;
  /** Problems and warnings (stderr). */
  error(line: string): void;
}

export interface CheckOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable so tests don't depend on which CLIs are installed. */
  detect?: (name: BackendName) => Promise<DetectResult>;
  io?: CheckIO;
}

const CONSOLE_IO: CheckIO = {
  print: (line) => console.log(line),
  error: (line) => console.error(line),
};

async function defaultDetect(name: BackendName): Promise<DetectResult> {
  return SPAWNABLE[name].detect();
}

/**
 * Validate a config and print a report. Returns the intended process exit code:
 * 0 = a config file exists and the server will accept it; 1 = invalid, or no
 * config file at the resolved path (nothing to route). Warnings (e.g. a
 * configured backend whose CLI is missing) do NOT fail the check — the config
 * is still valid; the backend can be installed later.
 */
export async function runCheck(opts: CheckOptions = {}): Promise<number> {
  const io = opts.io ?? CONSOLE_IO;
  const env = opts.env ?? process.env;
  const detect = opts.detect ?? defaultDetect;
  const configPath = opts.configPath ?? env.MCP_ROUTER_CONFIG ?? defaultConfigPath(env);

  let loaded;
  try {
    loaded = await loadConfig({ configPath, env });
  } catch (err) {
    io.error(`config INVALID: ${configPath}`);
    io.error(`  ${String((err as Error).message ?? err)}`);
    return 1;
  }

  if (loaded.source === "auto-detect") {
    io.print(`no config file found at: ${configPath}`);
    io.print(`the server would start in zero-config mode — every tier unconfigured, so route() has nothing to dispatch to.`);
    io.print(`write one (see the package README for the format) at mode 0600.`);
    return 1;
  }

  const config = loaded.config;
  io.print(`config OK: ${loaded.path}`);
  io.print(`  permissions, ownership, parent directory, schema, and provider derivation all valid.`);

  // Probe installs once, up front: reused for the per-tier missing-backend
  // warnings and the summary section below.
  const backendNames = Object.keys(SPAWNABLE) as BackendName[];
  const installed = new Map<BackendName, DetectResult>();
  for (const name of backendNames) installed.set(name, await detect(name));

  const warnings: string[] = [];
  io.print("");
  io.print("tiers:");
  for (const tier of TIER_NAMES) {
    const list = config.tiers[tier];
    if (list.length === 0) {
      io.print(`  ${tier}: (unconfigured)`);
      continue;
    }
    const parts = list.map((entry) => {
      if (entry.advisory) return `${entry.backend} (advisory)`;
      if (!installed.get(entry.backend)?.installed) {
        warnings.push(`tier '${tier}' routes to '${entry.backend}', but that CLI is not installed`);
      }
      // `model` is the backend-native id the user configured (for opencode it
      // already carries the `provider/` prefix), so print it verbatim rather
      // than re-prefixing the derived provider and doubling it.
      return `${entry.backend} · ${entry.model}`;
    });
    io.print(`  ${tier}: ${parts.join(", ")}`);
  }

  io.print("");
  io.print("capabilities:");
  for (const cap of CAPABILITIES) {
    const entry = config.capabilities[cap];
    if (!entry) {
      io.print(`  ${cap}: (unconfigured)`);
      continue;
    }
    if (!entry.advisory && !installed.get(entry.backend)?.installed) {
      warnings.push(`capability '${cap}' routes to '${entry.backend}', but that CLI is not installed`);
    }
    io.print(`  ${cap}: ${entry.backend} · ${entry.model ?? "(advisory)"}`);
  }

  io.print("");
  io.print("installed backends:");
  for (const name of backendNames) {
    const det = installed.get(name)!;
    io.print(`  ${name}: ${det.installed ? `installed${det.version ? ` (${det.version})` : ""}` : "not found"}`);
  }

  io.print("");
  if (warnings.length > 0) {
    for (const warning of warnings) io.error(`warning: ${warning}`);
    io.print(`config is valid, but ${warnings.length} warning(s) above — routing to a missing backend fails at run time.`);
    return 0;
  }
  io.print("OK — the server will accept this config.");
  return 0;
}
