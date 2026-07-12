import { homedir } from "node:os";

/**
 * Text utilities shared by every backend: ANSI stripping, output bounding,
 * and a redaction *engine* (the loop + homedir-folding logic, which was
 * byte-identical between mcp-opencode and mcp-grok). The actual
 * REDACTION_PATTERNS arrays differ between the two products today (grok adds
 * xAI key shapes and ~/.grok path folding on top of the generic set), so
 * each backend module builds its own `redact()` via createRedactor() rather
 * than sharing one hardcoded pattern list here.
 */

// Built via RegExp(string) with explicit char codes (rather than a regex
// literal containing raw control bytes, which do not survive file writes
// reliably) so the ESC / CSI-terminator / BEL bytes are unambiguous. Pattern
// is otherwise identical to both products' original ANSI_RE.
const ESC = String.fromCharCode(0x1b);
const CSI_TERMINATOR = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);
const ANSI_RE = new RegExp(
  "[" + ESC + CSI_TERMINATOR + "][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?" +
    BEL + ")|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function boundText(text: string, cap = 12_000): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}\n…[diagnostic truncated]…\n${text.slice(-tail)}`;
}

export interface PathRedactor {
  pattern: RegExp;
  replacement: string;
}

export interface RedactorOptions {
  /** Secret-shaped patterns. A pattern whose source starts with "(" is
   * treated as having a leading capture group to preserve (replaced with
   * "$1[REDACTED]"), matching the convention used by both products'
   * original redact(). */
  patterns: RegExp[];
  /** Extra path-shaped replacements applied after homedir folding (e.g.
   * grok's ~/.grok/sessions/... handling). Applied in array order. */
  pathRedactors?: PathRedactor[];
}

/** Builds a redact() function from a product-specific pattern set. */
export function createRedactor(opts: RedactorOptions): (text: string) => string {
  const { patterns, pathRedactors = [] } = opts;
  return (text: string): string => {
    let out = stripAnsi(text);
    for (const pattern of patterns) {
      if (pattern.source.startsWith("(")) {
        out = out.replace(pattern, "$1[REDACTED]");
      } else {
        out = out.replace(pattern, "[REDACTED]");
      }
    }

    const home = homedir();
    if (home.length > 1) {
      out = out.replace(new RegExp(escapeRegExp(home), "g"), "~");
    }

    for (const { pattern, replacement } of pathRedactors) {
      out = out.replace(pattern, replacement);
    }

    return out;
  };
}
