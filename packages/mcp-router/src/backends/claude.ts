import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  runClaude,
  classifyClaude,
  redact as claudeRedact,
  DEFAULT_MAX_TURNS,
} from "@mcp-coding-agents/core/backends/claude.js";

import { deriveProvider } from "../provider.js";
import { normalizeOutcome } from "../normalize.js";
import type { Backend, Capability, DetectResult, Entry, NormalizedOutcome, RunRequest } from "../types.js";
import type { StructuredError } from "@mcp-coding-agents/core";

const execFile = promisify(execFileCallback);

export class ClaudeBackend implements Backend {
  readonly name = "claude" as const;
  readonly containment = "none" as const;

  // Provider is fixed for claude; deriveProvider centralizes the rule.
  provider(_entry: Entry): string {
    return deriveProvider("claude", undefined);
  }

  capabilities(entry: Entry): Set<Capability> {
    return new Set(entry.capabilities ?? []);
  }

  async detect(): Promise<DetectResult> {
    try {
      const result = await execFile("claude", ["--version"], { timeout: 5000, encoding: "utf8" });
      return { installed: true, version: result.stdout.trim() };
    } catch {
      return { installed: false };
    }
  }

  async run(req: RunRequest): Promise<NormalizedOutcome> {
    const outcome = await runClaude({
      model: req.model,
      cwd: req.cwd,
      prompt: req.prompt,
      permissionMode: req.permissionMode,
      allowedTools: req.allowedTools,
      timeoutSec: req.timeoutSec,
      signal: req.signal,
      onHeartbeat: req.onHeartbeat,
    });
    const p = outcome.parsed;

    // AUTHORITATIVE final text: the terminal `result` event's text when
    // present and non-empty; otherwise the streamed assistant text fallback
    // (kill / abort / timeout, or a run that never reached a result event).
    const text = p.resultText && p.resultText.trim().length > 0 ? p.resultText : p.text;

    const diagnostic = [
      outcome.stderrTail,
      ...p.errorMessages,
      p.isError === true || (p.subtype !== undefined && p.subtype !== "success") ? (p.resultText ?? "") : "",
    ].join("\n");
    const classified = classifyClaude(diagnostic, { rateLimited: p.rateLimited });

    // FAILURE OVERRIDE: `claude -p` exits 0 even on a headless permission
    // denial, error_max_turns, or is_error -- none of those are a real
    // success, so exitCode/errorMessages passed to normalizeOutcome must be
    // corrected here rather than trusting the process exit code.
    const okSignalBad =
      p.isError === true || (p.subtype !== undefined && p.subtype !== "success") || p.permissionDenialCount > 0;

    let effectiveExitCode = outcome.exitCode;
    const effectiveErrorMessages = [...p.errorMessages];
    const effectiveClassified: StructuredError[] = [...classified];

    if (outcome.reason === "exit" && okSignalBad) {
      effectiveExitCode = (outcome.exitCode ?? 1) === 0 ? 1 : outcome.exitCode;
      let overrideMessage: string | undefined;
      if (p.permissionDenialCount > 0) {
        overrideMessage =
          `Claude blocked ${p.permissionDenialCount} tool call(s) needing permission in headless mode; ` +
          `set permissionMode to bypassPermissions for this entry or route Bash-heavy tasks to a different backend.`;
      } else if (p.subtype === "error_max_turns") {
        overrideMessage = `Claude hit the ${DEFAULT_MAX_TURNS}-turn limit before completing.`;
      }
      if (overrideMessage !== undefined) {
        effectiveErrorMessages.push(overrideMessage);
        // normalizeOutcome only appends its own generic "exited with code N"
        // task error when `errors` (classified) is empty; push the specific
        // message directly so it surfaces instead of that generic text.
        effectiveClassified.push({ category: "task", provenance: "exit", message: overrideMessage });
      }
    }

    return normalizeOutcome(
      {
        reason: outcome.reason,
        exitCode: effectiveExitCode,
        elapsedSec: outcome.elapsedSec,
        parsedText: claudeRedact(text),
        errorMessages: effectiveErrorMessages,
        sessionId: outcome.sessionID,
      },
      effectiveClassified,
      "claude",
    );
  }
}
