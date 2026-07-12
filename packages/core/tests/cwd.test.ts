import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateCwd, getConfiguredRoots } from "../src/cwd.js";

describe("cwd: getConfiguredRoots (env var parameterization)", () => {
  it("uses the given env var name and falls back to defaultRoots when unset", () => {
    delete process.env.MCP_ROUTER_ROOTS;
    expect(getConfiguredRoots("MCP_ROUTER_ROOTS", ["/default/root"])).toEqual(["/default/root"]);
  });

  it("splits a colon-separated list from the given env var", () => {
    process.env.MCP_ROUTER_ROOTS = "/a:/b: /c ";
    try {
      expect(getConfiguredRoots("MCP_ROUTER_ROOTS", ["/default"])).toEqual(["/a", "/b", "/c"]);
    } finally {
      delete process.env.MCP_ROUTER_ROOTS;
    }
  });
});

describe("cwd: validateCwd (parameterized by rootsEnvVar)", () => {
  let root: string;
  let outside: string;
  const ENV_VAR = "MCP_TEST_ROOTS";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "core-root-"));
    outside = mkdtempSync(path.join(tmpdir(), "core-outside-"));
    process.env[ENV_VAR] = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    delete process.env[ENV_VAR];
  });

  it("allows a cwd inside the configured root, using the given env var", async () => {
    const inner = path.join(root, "project");
    mkdirSync(inner);
    const result = await validateCwd(inner, { rootsEnvVar: ENV_VAR, requireRootIsDirectory: false });
    expect(result.ok).toBe(true);
  });

  it("rejects a cwd outside the configured root and mentions the given env var name", async () => {
    const result = await validateCwd(outside, { rootsEnvVar: ENV_VAR, requireRootIsDirectory: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(ENV_VAR);
  });

  it("rejects a symlink escape regardless of requireRootIsDirectory", async () => {
    const linkPath = path.join(root, "escape-link");
    symlinkSync(outside, linkPath);
    for (const requireRootIsDirectory of [false, true]) {
      const result = await validateCwd(linkPath, { rootsEnvVar: ENV_VAR, requireRootIsDirectory });
      expect(result.ok).toBe(false);
    }
  });

  it("requireRootIsDirectory=true (grok's original behavior) skips a root that is a file, not a directory", async () => {
    const fileAsRoot = mkdtempSync(path.join(tmpdir(), "core-fileroot-"));
    const filePath = path.join(fileAsRoot, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env[ENV_VAR] = filePath;
    try {
      const result = await validateCwd(fileAsRoot, { rootsEnvVar: ENV_VAR, requireRootIsDirectory: true });
      // The only configured root is a file; requireRootIsDirectory=true skips
      // it entirely, leaving no valid root, so cwd cannot be authorized.
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no configured root directories exist/);
    } finally {
      rmSync(fileAsRoot, { recursive: true, force: true });
    }
  });

  it("requireRootIsDirectory=false (opencode's original behavior) still realpaths a file-shaped root without crashing", async () => {
    const fileAsRoot = mkdtempSync(path.join(tmpdir(), "core-fileroot2-"));
    const filePath = path.join(fileAsRoot, "not-a-dir");
    writeFileSync(filePath, "x");
    process.env[ENV_VAR] = filePath;
    try {
      // The candidate cwd itself must still be a directory to pass; a root
      // that resolves to a file just can never match (nothing can be "inside"
      // a file path via the prefix check), so this simply rejects.
      const result = await validateCwd(fileAsRoot, { rootsEnvVar: ENV_VAR, requireRootIsDirectory: false });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(fileAsRoot, { recursive: true, force: true });
    }
  });

  it("uses defaultRoots when the env var is unset", async () => {
    delete process.env[ENV_VAR];
    const inner = path.join(outside, "project");
    mkdirSync(inner);
    const result = await validateCwd(inner, {
      rootsEnvVar: ENV_VAR,
      defaultRoots: [outside],
      requireRootIsDirectory: false,
    });
    expect(result.ok).toBe(true);
  });
});
