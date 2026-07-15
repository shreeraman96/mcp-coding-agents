import { OpencodeBackend } from "./opencode.js";
import { GrokBackend } from "./grok.js";
import { CodexBackend } from "./codex.js";
import { ClaudeBackend } from "./claude.js";

// Spawnable backend adapters, shared by the server (index.ts) and the `--check`
// CLI (check.ts) so the set of known backends is defined once. codex is
// spawnable (a non-advisory codex entry routes to CodexBackend); an entry may
// still opt into `advisory: true` to keep the router from spawning it and
// instead return a hint to use codex's own MCP.
export const SPAWNABLE = {
  opencode: new OpencodeBackend(),
  grok: new GrokBackend(),
  codex: new CodexBackend(),
  claude: new ClaudeBackend(),
} as const;

export type SpawnableName = keyof typeof SPAWNABLE;
