// Kimi Code transcript locator (D-W4-6, D-W4-10): built as scripts/locate.ts in
// the Kimi build only. W4 kimi track.
//
// Where Kimi Code 2.1.1 writes transcripts (W4 invariants 19, 31), under
// <KIMI_CODE_HOME or ~/.kimi-code>/sessions/<workspaceKey>/session_<uuid>/:
//   - a subagent (a wave member, Agent or AgentSwarm; id as the tool gave it, e.g.
//     `agent-0`):  agents/<id>/wire.jsonl
//   - a headless run (a lens, D-W4-5): that run's own session's
//     agents/main/wire.jsonl, found by its session id
// A subagent id repeats in every session (invariant 32), so `session` (the lead's
// session id, found and recorded as the sheet's Transcripts section says)
// narrows the search to that session's dir; without it, the same id in two
// sessions is two paths, which the check fails as ambiguous.
// locate: every existing file of either shape matching `id` (and `session` when
// given) exactly as whole path segments, as absolute paths; [] when the home or
// sessions dir is missing. finalMessage: the last assistant text in the wire, or
// null when there is none or no line parses. model: the model the wire records for
// the agent's turns (invariant 36), or null. Seam S3 producer: none of them throws.
// Cite Kimi by symbol, not by bundle line (invariant 20).
//
// The two id segments are the run's own: `session_<uuid>` names the session
// directory, `agent-<n>` (or `main` for the run's own agent) names the directory
// under `agents/`, and nothing else in the layout is an id, so `locate("agents")`
// matches nothing. Both are joined into the path as whole segments and nothing else
// is: an id holding a separator or a directory step (`../agents/agent-0`) would walk
// out of the layout onto another run's wire — one real transcript backing a second
// member — so such a value names no run and locate answers [] for it.
//
// What a wire holds (the stage-6 spike's recorded home,
// plans/w4-probe/spike/transcripts/kimi, and the fence's recorded exchange): one
// JSON object per line. The assistant's text is there twice — as a
// `context.append_loop_event` line whose `event` is a `content.part` of
// `type: "text"` (one event per part; a part is the whole part, not a stream
// delta) and as the `agent.message.appended` line whose `message.message.role` is
// "assistant". `finalMessage` reads both, so a run that records only one of them
// still has a final message. `model` reads the `llm.request` lines: `model` is the
// resolved id (`deepseek-flash[1m]`) and `modelAlias` the config's spelling
// (`deepseek/flash-1m`); the resolved id is the one returned.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Harness } from "./transcripts";

export const HARNESS: Harness = "kimi";

/**
 * The Kimi home this env points at: $KIMI_CODE_HOME, else `~/.kimi-code` with `~`
 * read from $HOME when the caller's env carries one — the same variable the
 * harness itself resolves. A relative name is resolved, so every path `locate`
 * returns is absolute (seam S3).
 */
function kimiHome(env: Record<string, string | undefined>): string {
  const named = env.KIMI_CODE_HOME?.trim();
  if (named) return resolve(named);
  const user = env.HOME?.trim();
  return join(user ? resolve(user) : homedir(), ".kimi-code");
}

/**
 * Whether `value` is usable as one whole path segment of a transcript path. Kimi's
 * ids are session UUIDs and `agent-<n>`, so an id holding a separator, a NUL byte or
 * `.`/`..` names no Kimi transcript: such a value is never searched for, because
 * locate answers [] rather than walking out of the sessions tree (seam S3: none of
 * these functions throws).
 */
function segment(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !/[/\\\0]/.test(value);
}

/** The names of the subdirectories of `dir`; [] when it is missing or unreadable. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Whether `path` is an existing regular file: a symlink to one counts, a directory never does. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether `dir` lists an entry spelled exactly `name`. On a case-insensitive filesystem
 * a joined path finds `agent-0/` for `AGENT-0`, so the path existing is not the id
 * matching: the directory's own spelling decides (seam S3, W4 stress F2).
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
  const sessions = join(kimiHome(env), "sessions");
  const found: string[] = [];
  for (const workspace of subdirs(sessions)) {
    const workspaceDir = join(sessions, workspace);
    for (const run of subdirs(workspaceDir)) {
      // The session is itself a whole path segment, so `session` matches the directory.
      if (session !== undefined && run !== session) continue;
      const agents = join(workspaceDir, run, "agents");
      // A member's own wire: the id is the directory its agent was given.
      const member = join(agents, id, "wire.jsonl");
      if (isFile(member) && hasEntry(agents, id)) found.push(member);
      // A headless run is named by the session directory it wrote, and its wire is
      // that session's main agent's — the run's own process is `main`.
      if (run === id) {
        const main = join(agents, "main", "wire.jsonl");
        if (isFile(main)) found.push(main);
      }
    }
  }
  return found.sort();
}

/** The text of an assistant message's content: its `text` parts, in order; [] when it carries none. */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text !== "")
    .map((part: any) => part.text);
}

/** One line's parsed JSON, or undefined for a line that is blank or not JSON (never a throw). */
function line(line: string): any {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function finalMessage(transcript: string): string | null {
  let last: string | null = null;
  // The step a `content.part` belongs to: its parts are the step's message, and a
  // later step replaces them (a run's second turn is not part of its first answer).
  let step: string | null = null;
  let parts: string[] = [];
  for (const raw of transcript.split("\n")) {
    const value = line(raw);
    if (value?.type === "agent.message.appended") {
      const said = textParts(value.message?.message?.content);
      if (value.message?.message?.role === "assistant" && said.length) last = said.join("\n");
      continue;
    }
    if (value?.type !== "context.append_loop_event") continue;
    const event = value.event;
    if (event?.type !== "content.part" || event.part?.type !== "text" || typeof event.part.text !== "string") continue;
    const key = typeof event.stepUuid === "string" ? event.stepUuid : `${event.turnId}.${event.step}`;
    if (key !== step) {
      step = key;
      parts = [];
    }
    if (event.part.text !== "") parts.push(event.part.text);
    last = parts.join("\n");
  }
  return last;
}

export function model(transcript: string): string | null {
  const named = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);
  let resolved: string | null = null;
  let alias: string | null = null;
  for (const raw of transcript.split("\n")) {
    const value = line(raw);
    if (value?.type !== "llm.request") continue;
    resolved = named(value.model) ?? resolved;
    alias = named(value.modelAlias) ?? alias;
  }
  return resolved ?? alias;
}
