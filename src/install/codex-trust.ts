// Codex hook trust: the `sha256:` identity Codex 0.159.0 computes for one hook
// handler, and the byte-preserving config.toml edit that records it.
//
// Ported from the 0.159.0 tree: hooks/src/engine/discovery.rs (hook_hash and the
// Command handler normalization at ~505-570, timeout normalization at ~742-764)
// and config/src/fingerprint.rs (version_for_toml). The identity is a *normalized*
// definition — event key, matcher, handler — so it excludes script bytes, the
// plugin version and the install path: trust survives a ktx update (invariant 6).
import { createHash } from "node:crypto";
import { PLUGIN_ID } from "../translators/common";

/** The config.toml state key Codex derives for ktx's single hook: `<plugin id>:<hooks path>:<event>:<group>:<handler>`. */
export const HOOK_STATE_KEY = `${PLUGIN_ID}:hooks/hooks.json:user_prompt_submit:0:0`;

const EVENT_JSON = "UserPromptSubmit";
const EVENT_LABEL = "user_prompt_submit";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_OUTPUT_TOKEN_LIMIT = 2500;
/** `hooks.state."<key>"` and the same path plus `.trusted_hash`. */
const TABLE_PATH = ["hooks", "state", HOOK_STATE_KEY];
const KEY_PATH = [...TABLE_PATH, "trusted_hash"];

export type HookState = { trustedHash?: string; enabled?: boolean };

/**
 * Codex's own trust hash for the ktx hook in `hooksJson` (the plugin's
 * hooks/hooks.json), or undefined when it declares no command handler there.
 * `sha256:<hex>` over the canonical JSON of the normalized identity, exactly as
 * `hook_hash` -> `version_for_toml` computes it. ktx ships one handler, the
 * group 0 / handler 0 of HOOK_STATE_KEY.
 */
export function hookHash(hooksJson: unknown): string | undefined {
  const handler = handlerAt(hooksJson);
  if (!handler || handler.type !== "command" || typeof handler.command !== "string" || !handler.command.trim()) {
    return undefined;
  }
  // The hash covers the definition as read from hooks.json: Codex substitutes
  // ${VAR} only in the command it runs, after the hash is taken.
  const normalized: Record<string, unknown> = {
    type: "command",
    command: handler.command,
    async: handler.async === true,
    timeout: normalizeTimeout(handler.timeout),
  };
  if (typeof handler.statusMessage === "string") normalized.statusMessage = handler.statusMessage;
  const limit = handler.additionalContextLimit;
  if (typeof limit === "number" && limit !== DEFAULT_OUTPUT_TOKEN_LIMIT) normalized.additionalContextLimit = limit;
  // matcher_pattern_for_event drops UserPromptSubmit's matcher, and the
  // normalized handler never carries commandWindows.
  const identity = { event_name: EVENT_LABEL, hooks: [normalized] };
  return `sha256:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

/** The ktx hook's persisted state in config.toml text, or undefined when it has none. */
export function hookStateFromConfig(configToml: string): HookState | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(Bun.TOML.parse(configToml)) ?? {};
  } catch {
    return undefined; // a config Codex itself would reject: report untrusted, never throw
  }
  const state = asRecord(asRecord(parsed.hooks)?.state)?.[HOOK_STATE_KEY];
  const record = asRecord(state);
  if (!record) return undefined;
  const out: HookState = {};
  if (typeof record.trusted_hash === "string") out.trustedHash = record.trusted_hash;
  if (typeof record.enabled === "boolean") out.enabled = record.enabled;
  return out;
}

/**
 * The config.toml text Codex would read back with `hash` recorded for ktx's hook,
 * or undefined when no edit ktx can make reads back correctly — the caller must
 * then write nothing at all (Codex writes this key as a dotted path, under
 * `[hooks]` or `[hooks.state]`, and as an inline table, so guessing wrong would
 * leave a config.toml that no longer parses).
 */
export function trustConfigEdit(configToml: string, hash: string): string | undefined {
  const next = upsertTrustBlock(configToml, hash);
  return hookStateFromConfig(next)?.trustedHash === hash ? next : undefined;
}

/**
 * Best-effort edit of config.toml text recording `trusted_hash = "<hash>"` for
 * ktx's hook, preserving every other byte: an existing definition of the key is
 * edited in place (whatever quoting, comment or table scope it uses), a dotted
 * sibling is extended next to itself, and only a file with no definition at all
 * gets a new `[hooks.state."<key>"]` table. Callers must verify with
 * `trustConfigEdit` before writing.
 */
export function upsertTrustBlock(configToml: string, hash: string): string {
  const value = JSON.stringify(hash);
  const hashLine = `trusted_hash = ${value}`;
  const lines = configToml.split("\n");
  const eol = configToml.includes("\r\n") ? "\r" : "";
  let scope: string[] = [];
  let inArrayTable = false;
  let header: { line: number } | undefined; // a [<our table>] header
  let inline: { line: number; key: string; indent: string; value: string } | undefined; // <key> = { … }
  let sibling: { line: number; key: string; indent: string } | undefined; // <key>.enabled = …

  for (let i = 0; i < lines.length; i++) {
    const { indent, text } = content(lines[i]!);
    if (!text) continue;
    if (text.startsWith("[")) {
      const array = text.startsWith("[[");
      const body = array ? text.slice(2, text.lastIndexOf("]]")) : text.slice(1, text.lastIndexOf("]"));
      scope = keyPath(body) ?? [];
      inArrayTable = array;
      if (!array && samePath(scope, TABLE_PATH)) header = { line: i };
      continue;
    }
    if (inArrayTable) continue; // an array of tables can hold several of these; never edit one
    const kv = assignment(text);
    if (!kv) continue;
    const key = keyPath(kv.key.trim());
    if (!key) continue;
    const full = [...scope, ...key];
    if (samePath(full, KEY_PATH)) {
      // Keep the key spelling the file used (it may be relative to a table header).
      lines[i] = `${indent}${kv.key.trim()} = ${value}${eol}`;
      return lines.join("\n");
    }
    if (samePath(full, TABLE_PATH) && kv.value.trim().startsWith("{")) {
      inline = { line: i, key: kv.key.trim(), indent, value: kv.value };
      continue;
    }
    if (siblingPath(full)) sibling = { line: i, key: [...key.slice(0, -1), "trusted_hash"].map(quoteKey).join("."), indent };
  }

  if (sibling) {
    lines.splice(sibling.line + 1, 0, `${sibling.indent}${sibling.key} = ${value}${eol}`);
    return lines.join("\n");
  }
  if (inline) {
    lines[inline.line] = `${inline.indent}${inline.key} = ${inlineTable(inline.value, hash)}${eol}`;
    return lines.join("\n");
  }
  if (header) {
    lines.splice(header.line + 1, 0, `${hashLine}${eol}`);
    return lines.join("\n");
  }
  const separator = configToml === "" ? "" : configToml.endsWith("\n") ? "\n" : "\n\n";
  return `${configToml}${separator}[hooks.state."${HOOK_STATE_KEY}"]\n${hashLine}\n`;
}

/** `{ enabled = false }` -> `{ enabled = false, trusted_hash = "…" }`, replacing one already there. */
function inlineTable(value: string, hash: string): string {
  const inner = value.slice(value.indexOf("{") + 1, value.lastIndexOf("}")).trim().replace(/,+$/, "").trim();
  const entry = `trusted_hash = ${JSON.stringify(hash)}`;
  const existing = /trusted_hash\s*=\s*(?:"[^"]*"|'[^']*'|[^,}]+)/.exec(inner);
  const body = existing
    ? inner.slice(0, existing.index) + entry + inner.slice(existing.index + existing[0].length)
    : inner
      ? `${inner}, ${entry}`
      : entry;
  return `{ ${body.trim()} }`;
}

/** Whether an assignment defines a field of our table rather than the hash itself (e.g. `<key>.enabled`). */
function siblingPath(full: string[]): boolean {
  return full.length === KEY_PATH.length && samePath(full.slice(0, -1), TABLE_PATH);
}

/**
 * discovery.rs:742-764: a UserPromptSubmit command hook defaults to 600s and is
 * never below 1s. (SessionEnd and Interrupt clamp to 3s; ktx's key is not one.)
 */
function normalizeTimeout(timeout: unknown): number {
  return Math.max(typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT_SEC, 1);
}

function handlerAt(hooksJson: unknown): Record<string, unknown> | undefined {
  const groups = asRecord(asRecord(hooksJson)?.hooks)?.[EVENT_JSON];
  const handlers = asRecord(asArray(groups)?.[0])?.hooks;
  return asRecord(asArray(handlers)?.[0]);
}

/** fingerprint.rs canonical_json: object keys sorted, arrays in order, then compact JSON. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------------------------
// A small line scanner: enough TOML to find which namespace a line assigns in,
// so an edit lands in the table a definition actually created.

/** A line's leading indent and content, with any trailing `# comment` removed. */
function content(line: string): { indent: string; text: string } {
  const body = stripComment(line);
  return { indent: body.slice(0, body.length - body.trimStart().length), text: body.trim() };
}

/** Drop a `# comment` that is not inside a basic or literal string. */
function stripComment(line: string): string {
  let position = 0;
  for (const { char, quoted } of characters(line)) {
    if (!quoted && char === "#") return line.slice(0, position);
    position += char.length;
  }
  return line;
}

/** Split `key = value` on the first `=` outside quotes; undefined when the line has none. */
function assignment(text: string): { key: string; value: string } | undefined {
  let position = 0;
  for (const { char, quoted } of characters(text)) {
    if (!quoted && char === "=") return { key: text.slice(0, position), value: text.slice(position + 1) };
    position += char.length;
  }
  return undefined;
}

/** Iterate characters with whether each sits inside a quoted string (escapes honoured in "…"). */
function* characters(text: string): Generator<{ char: string; quoted: boolean }> {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const quoted = quote !== undefined;
    if (quote === '"' && char === "\\") {
      yield { char, quoted };
      if (i + 1 < text.length) yield { char: text[i + 1]!, quoted };
      i++;
      continue;
    }
    if (quote === char) quote = undefined;
    else if (!quoted && (char === '"' || char === "'")) quote = char;
    yield { char, quoted };
  }
}

/** Parse a TOML key or table-header body into segments, unquoting `"…"` and `'…'` keys. */
function keyPath(text: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === " " || text[i] === "\t") i++;
    if (i >= text.length) break;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      let segment = "";
      i++;
      let closed = false;
      while (i < text.length) {
        if (quote === '"' && text[i] === "\\") {
          segment += text[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          closed = true;
          i++;
          break;
        }
        segment += text[i];
        i++;
      }
      if (!closed) return undefined;
      parts.push(segment);
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!bare) return undefined;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    while (text[i] === " " || text[i] === "\t") i++;
    if (i < text.length) {
      if (text[i] !== ".") return undefined;
      i++;
    }
  }
  return parts.length ? parts : undefined;
}

/** Quote a key segment only when TOML's bare-key grammar cannot carry it. */
function quoteKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
