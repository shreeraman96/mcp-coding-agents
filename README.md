# mcp-orchestrate

Send every coding task to the right-priced model automatically — cheap models for
the grunt work, your heavy hitter for the hard problems — and never lose work to a
failed backend. `mcp-orchestrate` is one MCP server that maps three tiers
(`light` / `standard` / `heavy`) onto the coding CLIs you already run — opencode,
grok, codex, and claude — with capability filtering, cooldowns, and a fallback that
only retries on a **fast, clean failure with a byte-identical git tree**, so a
half-finished run is never silently redone somewhere else.

Works with **any MCP client** — Claude Code, Codex, Cursor, opencode, or your own.

```bash
mcp-orchestrate --init      # guided setup
```

## Is it for you?

Use it if you run **more than one** coding-agent CLI and want cost/capability
control without hand-picking a model every time — plus safe automatic failover.
If you only use a single backend or a single model, you don't need the router;
install that backend's own MCP (see below) instead.

## One server, or just the individual MCPs

- **`mcp-orchestrate` — the main product.** One MCP server with tier routing,
  cooldowns, and safe fallback built in. Configure once with `--init`, done.
- **Just want the individual MCPs?** If you only need a plain MCP for each coding
  CLI you use — no routing — install them directly and let your assistant call
  whichever it needs:

  ```bash
  # Claude Code (Codex: swap `claude mcp add` for `codex mcp add`)
  claude mcp add opencode -- npx -y mcp-opencode
  claude mcp add grok     -- npx -y mcp-grok
  # codex ships its own MCP via the codex CLI: `codex mcp ...`
  ```

  These are **siblings** of the router over the same CLIs — no tiers, cooldowns,
  or fallback.

## Requirements

The router spawns the backend CLIs you enable, so each must be **installed and
authenticated**:

- `opencode`, `grok`, `codex`, and/or `claude` (the Claude Code CLI) —
  whichever backends your tiers use. For `claude`, run `claude login` once to use
  your **Claude subscription** (no API key needed).
- Node.js >= 20.

## Quick start

Register the stdio server with your MCP client — generic form first, then common
clients:

```bash
# generic: any MCP client spawns this command
npx -y mcp-orchestrate

# Claude Code
claude mcp add orchestrate -- npx -y mcp-orchestrate
# Codex
codex mcp add orchestrate -- npx -y mcp-orchestrate
```

Registering it in more than one client is fine — each spawns its own server
process, and by default they share `~/.config/mcp-router/config.json`. To make each
client route to a *different* model (e.g. Codex → Claude Opus, Claude Code →
codex/grok), give each its own config via `MCP_ROUTER_CONFIG` — see
[Running orchestrate in multiple clients](./packages/mcp-router/README.md#running-orchestrate-in-multiple-clients).

Then configure your tiers (you choose every model — nothing is baked in):

```bash
mcp-orchestrate --init      # interactive wizard; writes ~/.config/mcp-router/config.json
mcp-orchestrate --check     # validate an existing config
```

A minimal config:

```jsonc
{
  "tiers": {
    "light":    { "backend": "grok",     "model": "grok-4.5" },
    "standard": { "backend": "opencode", "model": "<provider>/<model>" },
    "heavy":    { "backend": "claude",   "model": "opus", "permissionMode": "acceptEdits" }
  },
  "fallbacks": { "heavy": "standard", "standard": "light" }
}
```

Now a `route(tier: "heavy", …)` call runs claude. If it fails fast and cleanly and
your git tree is untouched, the router retries the next configured entry
(cross-provider hops require an explicit opt-in) — so a half-finished run is never
silently redone on another backend.

## How it works — it spawns CLIs, not MCPs

```
  your MCP client ──calls──▶ mcp-orchestrate ──spawns──▶ opencode / grok / codex / claude   (CLI binaries)

  mcp-opencode, mcp-grok ── siblings: separate MCP servers over the same CLIs
                            (the router never calls them)
```

The router is *only* an MCP server — it has no MCP client inside it, so it never
calls `mcp-opencode`, `mcp-grok`, or the codex/claude MCPs. Whether those are
installed has no effect on whether a route works.

**Backends vs. models.** A *backend* is the CLI program that runs the task
(`opencode` / `grok` / `codex` / `claude`); a *model* is the AI it runs (e.g.
`grok-4.5`, `glm-5p2`, `gpt-5.6-terra`, `opus`). One backend can front many models —
which ones you can route to depends on how *you've* configured that CLI (your
opencode install might front Anthropic, OpenAI, Fireworks, or a local provider).
The router never adds models; it routes to whatever your installed CLIs already
expose. `claude` is spawned; it runs Claude Code headless (`claude -p`) on your
**Claude subscription** (no API key), provider `anthropic`, model `opus` / `sonnet`
/ `haiku` or a full concrete id. `codex` entries take a per-entry `sandbox`:
`read-only` | `workspace-write` (default) | `danger-full-access`.
`danger-full-access` removes the OS sandbox entirely (risk-flagged by `--init`);
`read-only` can't write files.

### Claude backend: safety & scope

- **No OS sandbox** — unlike codex's `workspace-write` sandbox, `claude` runs at
  the same unsandboxed posture as `grok`/`opencode` today (OS-level sandboxing is
  deferred future work).
- Default `permissionMode: "acceptEdits"` lets it edit files but denies Bash in
  headless mode (a headless denial no longer reads as success — the router treats
  it as a failure). Set `"permissionMode": "bypassPermissions"` per entry for full
  autonomy; `--init` flags this as a risk because it means **no sandbox + full host
  access** for that slot.
- `allowedTools` (claude-only) pre-approves scoped tools headless without a full
  bypass, e.g. `"allowedTools": ["WebFetch", "Read(./docs/**)"]`. **`Bash(...)`
  allow-rules are NOT a sandbox** — they're escapable via command chaining (an
  untrusted prompt can append arbitrary commands), so a Bash rule grants
  effectively full shell to an untrusted prompt, the same risk as
  `bypassPermissions`; `--init` flags it accordingly. Non-shell rules are
  genuinely scoped.
- The router isolates the spawned `claude` process from your own MCP servers,
  hooks, and `CLAUDE.md` (`--strict-mcp-config` + an empty `--mcp-config` +
  `--setting-sources ''`), so a routed task cannot recurse into `mcp-orchestrate`
  itself or trigger your local hooks.
- This uses `claude -p` via Anthropic's official CLI under your logged-in
  subscription — confirm that fits your plan's terms before enabling it.

## Packages

- [`mcp-orchestrate`](./packages/mcp-router) — the tier router (main product);
  spawns the opencode/grok/codex/claude CLIs.
  Published: [`mcp-orchestrate`](https://www.npmjs.com/package/mcp-orchestrate).
- [`mcp-opencode`](./packages/mcp-opencode) — single-backend MCP over the opencode CLI.
  Published: [`mcp-opencode`](https://www.npmjs.com/package/mcp-opencode).
- [`mcp-grok`](./packages/mcp-grok) — single-backend MCP over the Grok Build CLI.
  Published: [`mcp-grok`](https://www.npmjs.com/package/mcp-grok).

Per-package READMEs carry the full tool schemas, config format, environment
variables, and security limitations:

- [mcp-orchestrate tiers, fallback, init, and config](./packages/mcp-router/README.md)
- [mcp-opencode setup and tools](./packages/mcp-opencode/README.md)
- [mcp-grok setup and tools](./packages/mcp-grok/README.md)

`@mcp-coding-agents/core` is a private, never-published package holding the shared
run/parse/classify/redact/validateCwd runtime; it is bundled into each product's
`dist` at build, so it is never a runtime npm dependency.

## Develop

Clone and build from source (contributor setup — end users don't need this):

```bash
npm install
npm run build
npm test
```

Iterate on one package in isolation:

```bash
npm run build --workspace mcp-orchestrate
npm test --workspace mcp-orchestrate
```

The root package is private and has no `bin`, `files`, or publishable behavior.

## License

MIT. Each publishable package contains its own copy of [`LICENSE`](./LICENSE).
