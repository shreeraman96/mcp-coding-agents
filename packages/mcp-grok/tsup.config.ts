import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: false,
  clean: true,
  sourcemap: false,
  // core is never a published runtime dependency of this product -- bundle
  // it into dist so the tarball is self-contained. The MCP SDK and zod stay
  // external: they are real runtime dependencies declared in package.json.
  noExternal: ["@mcp-coding-agents/core"],
  external: ["@modelcontextprotocol/sdk", "zod"],
  // tsup auto-detects and preserves the `#!/usr/bin/env node` shebang already
  // present as the first line of src/index.ts (esbuild's own shebang
  // handling) -- no banner needed here; adding one would duplicate it.
});
