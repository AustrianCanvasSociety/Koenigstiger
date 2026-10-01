// Claude Code transcript locator (D-W4-6, D-W4-10): built as scripts/locate.ts in
// the Claude build only. W4 claude track.
//
// Where Claude Code 2.1.285 writes transcripts (W4 invariants 13, 31), under
// <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/:
//   - a subagent (a wave member, id as the Agent tool gave it, e.g.
//     `a9c43d21dd9b997d3`):  <session>/subagents/agent-<id>.jsonl
//   - a headless run (a lens, D-W4-5, id = its session_id):  <id>.jsonl
// Subagent ids are unique across sessions (invariant 32), so the Claude sheet has
// the lead record no `session` (a probe-launched lead may see the caller's
// inherited CLAUDE_CODE_SESSION_ID, invariant 35); when one is given it only
// narrows the search to that <session> dir.
// locate: every existing file of either shape whose name carries `id` exactly
// (never a prefix match), as absolute paths; [] when the home or projects dir is
// missing. finalMessage: the message of the last SubagentHandback call in the JSONL (an
// interactive member's answer) when there is one; else the text of the last assistant
// message — every text block of the lines sharing its `message.id`, in order, joined
// with nothing (see the function) — or null when there is none or no line parses.
// model: the `message.model` of the last assistant line (invariant 36), or null. Seam
// S3 producer: none of them throws.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Harness } from "./transcripts";

export const HARNESS: Harness = "claude";

/**
 * The Claude home: `CLAUDE_CONFIG_DIR` when it names one, else `~/.claude`. Resolved,
 * so every path locate answers with is absolute even for a relative variable (seam S3).
 */
function claudeHome(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return resolve(dir !== undefined && dir.trim() !== "" ? dir : join(homedir(), ".claude"));
}

/**
 * Whether `value` is usable as one whole path segment of a transcript path. Claude's
 * ids are hex strings and UUIDs, so an id holding a separator (Codex's `/root/one`),
 * a NUL byte, or `.`/`..` names no Claude transcript: such a value is never searched
 * for, because locate answers [] rather than walking out of the home (seam S3: none of
 * these functions throws).
 */
function segment(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !/[/\\\0]/.test(value);
}

/** The subdirectory names under `dir`, or [] when it is missing or unreadable. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Whether `path` is an existing regular file: a directory of that name is not a transcript. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether `dir` lists an entry spelled exactly `name`. On a case-insensitive filesystem
 * a joined path finds `agent-A1.jsonl` for `agent-a1`, so the path existing is not the
 * id matching: the directory's own spelling decides (seam S3, W4 stress F2).
 */
function hasEntry(dir: string, name: string): boolean {
  try {
    return readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}

export function locate(id: string, env: Record<string, string | undefined>, session?: string): string[] {
  if (!segment(id)) return [];
  // A session that cannot name a session directory narrows the search to nothing:
  // answering with an unnarrowed match would be the ambiguity the caller asked to avoid.
  if (session !== undefined && !segment(session)) return [];
  const projects = join(claudeHome(env), "projects");
  const found: string[] = [];
  for (const project of subdirs(projects)) {
    const dir = join(projects, project);
    // A headless run (a lens): the file's own name is its session id, at the project level.
    const headless = join(dir, `${id}.jsonl`);
    if (isFile(headless) && hasEntry(dir, `${id}.jsonl`)) found.push(headless);
    // A subagent (a wave member): the file lies in its session's subagents dir.
    // Names from subdirs() are the directory's own spelling; only a caller's session needs checking.
    const names = session === undefined ? subdirs(dir) : hasEntry(dir, session) ? [session] : [];
    for (const name of names) {
      const subagents = join(dir, name, "subagents");
      const transcript = join(subagents, `agent-${id}.jsonl`);
      if (isFile(transcript) && hasEntry(subagents, `agent-${id}.jsonl`)) found.push(transcript);
    }
  }
  return found;
}

/**
 * A transcript's JSONL lines. A line that does not parse — a run killed mid-write
 * leaves a partial last line — is skipped, never thrown on.
 */
function lines(transcript: string): any[] {
  const parsed: any[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return parsed;
}

/** One assistant line's text blocks, joined; "" when it carries none (a thinking-only line). */
function textOf(line: any): string {
  const content = line?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

/** The message of one assistant line's last SubagentHandback call; null when it makes none with a non-empty string message. */
function handbackOf(line: any): string | null {
  const content = line?.message?.content;
  if (!Array.isArray(content)) return null;
  let message: string | null = null;
  for (const c of content) {
    const m = c?.type === "tool_use" && c.name === "SubagentHandback" ? c.input?.message : undefined;
    if (typeof m === "string" && m !== "") message = m;
  }
  return message;
}

/** An assistant line's message id, or null when it names none: such a line stands alone. */
function messageId(line: any): string | null {
  const id = line?.message?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

export function finalMessage(transcript: string): string | null {
  const parsed = lines(transcript);
  // An interactive member answers through a SubagentHandback call, and only that call
  // reaches its caller: text beside it is not delivered (the M3 walkthrough,
  // plans/m3-probe/walkthrough/). So the last handback's message wins over any text.
  let handback: string | null = null;
  for (const line of parsed) {
    if (line?.type === "assistant") handback = handbackOf(line) ?? handback;
  }
  if (handback !== null) return handback;
  // Otherwise the last assistant line that says anything names the member's final
  // message: a message is written one line per content block, and a run's last line
  // may be thinking or a tool call only (the spike's stream, plans/w4-probe/spike/).
  let said = -1;
  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i];
    if (line?.type === "assistant" && textOf(line) !== "") said = i;
  }
  if (said < 0) return null;
  const id = messageId(parsed[said]);
  if (id === null) return textOf(parsed[said]); // no id: the line is its own message, as before
  // Every block of that message, in the order the harness wrote them. The blocks are
  // joined with nothing: each recorded run's own headless `result` (plans/w4-probe/spike/
  // claude.json's "DONE" against its session transcript, plans/w3-probe/live/
  // fence-claude.stream.jsonl and plans/w3-probe/lc1-claude-expansion.jsonl) ended on a
  // message holding one text block, so no separator between blocks is observable, and the
  // harness takes each block's text as it arrives without inserting one.
  const blocks: string[] = [];
  for (const line of parsed) {
    if (line?.type !== "assistant" || messageId(line) !== id) continue;
    const text = textOf(line);
    if (text !== "") blocks.push(text);
  }
  return blocks.join("");
}

export function model(transcript: string): string | null {
  // The resolved model, not the requested alias: `message.model` is what the harness
  // ran (invariant 36); the sibling `agent-<id>.meta.json` holds the requested name.
  let last: string | null = null;
  for (const line of lines(transcript)) {
    if (line?.type !== "assistant") continue;
    if (typeof line?.message?.model === "string" && line.message.model !== "") last = line.message.model;
  }
  return last;
}
