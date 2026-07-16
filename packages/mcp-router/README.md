# mcp-orchestrate

Send every coding task to the right-priced model automatically — cheap models for
the grunt work, your heavy hitter for the hard problems — and never lose work to a
failed backend. `mcp-orchestrate` is one MCP server that maps three tiers
(`light` / `standard` / `heavy`) onto the coding CLIs you already run — opencode,
grok, codex, and claude — with capability filtering, cooldowns, and a fallback that
only retries on a **fast, clean failure with a byte-identical git tree**.

Works with **any MCP client** — Claude Code, Codex, Cursor, opencode, or your own.
The calling assistant routes by *intent* (it picks a tier with full task context);
the router owns *reliability* (the tier→model mapping, capability filtering,
cooldowns, and a safety-gated fallback). It never invents a model — **nothing about
any author's setup is baked in**; every mapping is yours, supplied in config.

```bash
mcp-orchestrate --init      # guided setup
```

## It spawns CLIs, not MCPs

```
  your MCP client ──calls──▶ mcp-orchestrate ──spawns──▶ opencode / grok / codex / claude   (CLI binaries)

  mcp-opencode, mcp-grok ── siblings: separate MCP servers over the same CLIs
                            (the router never calls them)
```

The router is *only* an MCP server — it has no MCP client inside it, so it never
calls `mcp-opencode`, `mcp-grok`, or the codex/claude MCPs. Whether those are
installed has no effect on routing. Prefer plain single-backend MCPs with no routing at all?
Install them directly (`npx -y mcp-opencode`, `npx -y mcp-grok`) and let your
assistant call whichever it needs — they're siblings over the same CLIs, not layers
beneath the router.

## Is it for you?

Use it if you run **more than one** coding-agent CLI and want cost/capability
control without hand-picking a model every time, plus safe automatic failover. If
you only use a single backend or a single model, you don't need the router —
install that backend's own MCP instead.

## Requirements

The router spawns the backend CLIs you enable, so each must be **installed and
authenticated**: `opencode`, `grok`, `codex`, and/or `claude` (whichever your
tiers use), plus Node.js >= 20. The `claude` backend authenticates via the Claude
Code CLI's own login — run `claude login` once to use your **Claude subscription**
(no API key needed).

## Install

Register the stdio server with your MCP client — generic form first, then examples:

```bash
npx -y mcp-orchestrate                                  # any MCP client spawns this
claude mcp add orchestrate -- npx -y mcp-orchestrate    # Claude Code
codex  mcp add orchestrate -- npx -y mcp-orchestrate    # Codex
```

> The published package is **`mcp-orchestrate`** and its CLI command is
> `mcp-orchestrate`. The config directory (`~/.config/mcp-router/`) and the
> `MCP_ROUTER_*` environment variables keep the `mcp-router` prefix for
> backward compatibility.

## Backends vs. models

A *backend* is the CLI program that runs the task (`opencode` / `grok` / `codex` /
`claude`); a *model* is the AI it runs (e.g. `grok-4.5`, `glm-5p2`, `gpt-5.6-terra`,
`opus`). One backend can front many models — which ones you can route to depends on
how *you've* configured that CLI. The router never adds models; it routes to
whatever your installed CLIs already expose. Per backend:

- **opencode** — spawned; any provider/model your OpenCode install exposes.
- **grok** — spawned; the Grok Build CLI (always provider `xai`).
- **codex** — spawned by default, or set `"advisory": true` on the entry to have
  the router return a "use the Codex MCP directly" hint instead of spawning it
  (an advisory entry needs no model and never sends your prompt anywhere). Per-entry
  `sandbox`: `"read-only"` | `"workspace-write"` (default) | `"danger-full-access"`.
  `"danger-full-access"` removes the OS sandbox entirely (risk-flagged by `--init`);
  `"read-only"` can't write files.
- **claude** — spawned; runs Claude Code headless (`claude -p`) on your **Claude
  subscription** (no API key needed); provider `anthropic`; model is `opus` /
  `sonnet` / `haiku` or a full concrete id.

### Claude backend: safety & scope

- **No OS sandbox** — unlike codex's `--sandbox workspace-write`, `claude` runs at
  the same unsandboxed posture as `grok`/`opencode` today (`containment: "none"`).
  OS-level sandboxing (`sandbox-exec`/`bwrap`) is deferred future work.
- Default `permissionMode: "acceptEdits"` lets it edit files but Bash is denied in
  headless mode — set `"permissionMode": "bypassPermissions"` per entry for full
  autonomy (`--init` flags this as a risk: it means **no sandbox + full host
  access**, so an untrusted prompt can act as you).
- `allowedTools` (claude-only) is a pass-through to claude's `--allowedTools`,
  pre-approving scoped tools without prompting and without a full bypass, e.g.
  `"allowedTools": ["WebFetch", "Read(./docs/**)"]`. **`Bash(...)` allow-rules are
  NOT a sandbox** — they're escapable via command chaining (an untrusted prompt can
  append arbitrary commands), so a Bash rule grants effectively full shell to an
  untrusted prompt, the same risk as `bypassPermissions`; `--init` flags it the
  same way. Non-shell rules are genuinely scoped.
- The router isolates the spawned `claude` from your own MCP servers, hooks, and
  `CLAUDE.md` on every spawn (`--strict-mcp-config` with an empty `--mcp-config`,
  plus `--setting-sources ''`).
- This is subscription use of `claude -p` via Anthropic's official CLI — confirm
  it fits your plan's terms before enabling it.

> **Honest scope (v1 fallback).** Fallback fires only for **fast, clean failures**
> — a backend that isn't installed, is rate-limited/overloaded immediately, or
> fails auth at launch, with a byte-identical git tree. A run that edited files,
> timed out, or exhausted the budget is **terminal** and returned as-is. This is
> graceful fallback on fast/clean failure, not a mid-task rescue.

## Configuration

`~/.config/mcp-router/config.json` (or `$XDG_CONFIG_HOME/mcp-router/config.json`,
or `$MCP_ROUTER_CONFIG`). The file **must be mode `0600`** and owned by you, or
the server refuses to read it.

```jsonc
{
  "tiers": {
    "light":    null,
    "standard": { "backend": "opencode", "model": "<provider>/<model>" },
    "heavy":    { "backend": "claude", "model": "opus", "permissionMode": "acceptEdits" }
  },
  "capabilities": {
    "vision": { "backend": "opencode", "model": "<provider>/<vision-model>", "capabilities": ["vision"] }
  },
  "fallbacks": { "light": "standard", "heavy": "standard" },
  "allowCrossProviderFallback": false
}
// All ids are placeholders. Supply your own backend/provider/model per slot.
```

- **Tier names are fixed** (`light`/`standard`/`heavy`); you only choose which
  model fills each slot. A tier name denotes *your intent for the slot*, not a
  model's size.
- **Provider is derived** from the opencode model prefix (`<provider>/...`) and a
  declared `provider` that disagrees is rejected. grok is always `xai`, codex is
  always `openai`, claude is always `anthropic`.
- **`permissionMode`** is claude-only (`"acceptEdits"` default or
  `"bypassPermissions"`); declaring it on any other backend is rejected.
- **`allowedTools`** is claude-only (a string array, e.g. `["WebFetch",
  "Read(./docs/**)"]`); declaring it on any other backend is rejected.
- **`sandbox`** is codex-only (`"read-only"` | `"workspace-write"` default |
  `"danger-full-access"`); declaring it on any other backend is rejected.
- **`allowCrossProviderFallback`** (default `false`): a fallback that would ship
  your prompt + repo content to a *different* provider requires this opt-in.
  Aggregator prefixes (`openrouter`, `github-copilot`) are always treated as
  cross-provider.
- **No config file?** The server still runs (zero-config), but every tier is
  unconfigured until you write one — it never fabricates a model.

### Environment

- `MCP_ROUTER_ROOTS` — colon-separated allowlist of directories a `cwd` must be
  inside (default `$HOME/Projects`). This is the security boundary.
- `MCP_ROUTER_CONFIG` — override the config path.

### Validate your config: `mcp-orchestrate --check`

Run the config doctor in your terminal (this is a CLI command, separate from the
MCP stdio server) to confirm the server will accept your config before wiring it
up:

```bash
mcp-orchestrate --check            # checks the default config path
mcp-orchestrate --check <path>     # or an explicit path
```

It loads the config through the exact same hardened path the server uses
(permissions `0600`, ownership, parent-directory checks, schema, and provider
derivation), prints the configured tiers/capabilities and which backend CLIs are
installed (warning on any configured-but-missing backend), and exits `0` when the
config is valid, `1` when it is invalid or absent.

### Interactive setup: `mcp-orchestrate --init`

Rather than hand-writing the config, run the wizard in your terminal:

```bash
mcp-orchestrate --init            # writes the default config path
mcp-orchestrate --init <path>     # or an explicit path (handy for testing)
```

It detects installed backends, discovers each backend's models (best-effort — the
list is untrusted, you confirm every pick), walks each tier, shows the **diff +
risks**, asks to confirm, then writes a `0600` config and self-runs `--check`. It
**requires a TTY** and **replaces** the config (it starts blank, not a merge). The
parent directory must not be group/world-writable (so `/tmp` is refused by design).

### Conversational setup from an MCP client (opt-in)

You can also drive setup from inside an MCP client (Claude Code, codex, opencode).
Because config is the router's trust boundary, these tools are registered **only
when `MCP_ROUTER_ALLOW_INIT=1`** is set in the server's environment — never on by
default:

- **`init_status()`** — installed backends, discovered models (untrusted), and
  which tiers/capabilities are configured (presence only). Writes nothing.
- **`init_preview(spec)`** — validates a proposed config through the exact server
  path and returns the diff + server-computed risks. Writes nothing.
- **`init_apply(spec)`** — stages the config as `<config>.pending`. It **can never
  write the live config**; promotion requires a human running the accept step.

```bash
mcp-orchestrate --accept-pending [path]   # review the staged diff + risks, confirm, commit
```

`--accept-pending` **requires a TTY** and has no non-interactive bypass: the human
review at a real terminal is the attestation that a prompt-injected assistant
cannot forge. Enable `MCP_ROUTER_ALLOW_INIT=1` only during setup.

## Tools

- **`route(prompt, cwd, tier, caps?, timeoutSec?)`** — dispatch to the tier (with
  safe fallback). Returns served-by, the full attempt trace, any cross-provider
  notice, then the assistant text (redacted).
- **`list_tiers()`** — minimal discovery: which tiers/capabilities are configured
  (presence only — never model ids, candidate counts, or the config path), which
  are cooling, and which CLIs are installed. Sends no prompt, probes no provider.
- **`router_dry_run(cwd, tier, caps?, timeoutSec?)`** — the explicit recipient
  preview: the exact ordered recipients (backend/model), authorization decisions,
  cross-provider crossings, and budget split, **without** sending the prompt.

## Safety limitations

- The fallback fingerprint is **cwd-scoped**: it proves the git working tree in
  `cwd` is unchanged, not that the machine is unchanged (an agent's shell can
  write to `$HOME`, sibling repos, or git config). "cwd tree unchanged" ≠
  "nothing happened".
- A non-git `cwd` cannot be fingerprinted, so any post-spawn failure there is
  terminal (never falls back).
- Cooldowns and traces surface a **coarse** reason (`unavailable`), never `auth`
  vs `capacity`, to avoid leaking per-provider credential health.

## License

MIT.
