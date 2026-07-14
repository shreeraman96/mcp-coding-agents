import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCheck, type CheckIO } from "../src/check.js";
import type { DetectResult } from "../src/types.js";

const installed = async (): Promise<DetectResult> => ({ installed: true, version: "test" });
const notInstalled = async (): Promise<DetectResult> => ({ installed: false });

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A temp dir at 0700 so it is not group/world-writable — the hardened loader
// refuses a config whose parent directory is loosely permissioned.
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-router-check-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

function writeConfig(dir: string, obj: unknown, mode = 0o600): string {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj), { mode });
  chmodSync(p, mode); // defeat any umask restriction on the initial create
  return p;
}

function io(): { io: CheckIO; out: string[]; err: string[]; text: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { print: (l) => out.push(l), error: (l) => err.push(l) },
    out,
    err,
    text: () => out.concat(err).join("\n"),
  };
}

const VALID = {
  tiers: { light: null, standard: { backend: "opencode", model: "prov/model-a" }, heavy: null },
  capabilities: {},
  fallbacks: {},
  allowCrossProviderFallback: false,
};

describe("runCheck", () => {
  it("returns 0 and reports OK for a valid 0600 config", async () => {
    const cfg = writeConfig(tempDir(), VALID);
    const cap = io();
    const code = await runCheck({ configPath: cfg, env: {}, detect: installed, io: cap.io });
    expect(code).toBe(0);
    expect(cap.text()).toContain("config OK");
    expect(cap.text()).toContain("OK — the server will accept this config.");
    expect(cap.text()).toContain("standard: opencode · prov/model-a");
  });

  it("returns 1 when the config file is absent (zero-config)", async () => {
    const cap = io();
    const code = await runCheck({ configPath: join(tempDir(), "nope.json"), env: {}, detect: installed, io: cap.io });
    expect(code).toBe(1);
    expect(cap.text()).toContain("no config file found");
  });

  it("returns 1 when permissions are too broad (real hardened-loader path)", async () => {
    const cfg = writeConfig(tempDir(), VALID, 0o644);
    const cap = io();
    const code = await runCheck({ configPath: cfg, env: {}, detect: installed, io: cap.io });
    expect(code).toBe(1);
    expect(cap.text()).toContain("INVALID");
    expect(cap.text().toLowerCase()).toContain("permissions");
  });

  it("returns 1 for a schema/provider-derivation failure (opencode model with no provider prefix)", async () => {
    const bad = { ...VALID, tiers: { light: null, standard: { backend: "opencode", model: "nomodel" }, heavy: null } };
    const cfg = writeConfig(tempDir(), bad);
    const cap = io();
    const code = await runCheck({ configPath: cfg, env: {}, detect: installed, io: cap.io });
    expect(code).toBe(1);
    expect(cap.text()).toContain("INVALID");
    expect(cap.text()).toContain("provider/model");
  });

  it("returns 0 but warns when a configured backend's CLI is not installed", async () => {
    const cfg = writeConfig(tempDir(), VALID);
    const cap = io();
    const code = await runCheck({ configPath: cfg, env: {}, detect: notInstalled, io: cap.io });
    expect(code).toBe(0);
    expect(cap.err.join("\n")).toContain("not installed");
    expect(cap.text()).toContain("config is valid, but 1 warning");
  });
});
