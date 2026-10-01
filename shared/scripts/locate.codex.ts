// Codex transcript locator (D-W4-6, D-W4-10): built as scripts/locate.ts in the
// Codex build only. W4 codex track.
//
// Where Codex 0.159.0 writes transcripts (W4 invariants 25, 31-33): one rollout per
// thread, <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<stamp>-<thread_id>.jsonl,
// whose first line is `session_meta` with the thread's `id`, and for a child its
// `parent_thread_id` and `agent_path`.
//   - a wave member: the lead sees the child's `agent_path` (e.g. `/root/one`, from
//     the `task_name` it chose), unique only within the parent thread, so `session`
//     is the lead's thread id (CODEX_THREAD_ID in its shell, invariant 35) and the
//     match is session_meta.parent_thread_id == session and agent_path == id; an
//     id that is a thread id matches that rollout directly.
//   - a headless lens run (D-W4-5): its own thread id, from `codex exec --json`'s
//     thread.started event.
// locate: every existing rollout that matches as above, as absolute paths; [] when
// the home or sessions dir is missing. finalMessage: the last assistant (agent)
// message text in the rollout, or null when there is none or no line parses.
// model: the last turn_context's model (invariant 36), or null. Seam S3 producer:
// none of them throws.
// A home the env names relatively is resolved, so the answer's absoluteness is the
// locator's own doing rather than the glob's (adversarial lens C8). Only a rollout's
// first line is read, and that in bounded chunks: a home holds one rollout per thread
// and locate runs over that whole home once per wave member (TigerStyle T3).

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Harness } from "./transcripts";

export const HARNESS: Harness = "codex";

/**
 * The Codex home this machine's transcripts live in: `CODEX_HOME`, else `~/.codex`.
 * Resolved, so every path locate answers with is absolute even for a relative variable
 * (seam S3), as the sibling locators do.
 */
function codexHome(env: Record<string, string | undefined>): string {
  const dir = env.CODEX_HOME;
  return resolve(dir !== undefined && dir.trim() !== "" ? dir : join(homedir(), ".codex"));
}

/** How much of a rollout one read asks for: the spike's own session_meta lines are ~20 KB. */
export const HEADER_CHUNK_BYTES = 16 * 1024;

/**
 * The longest first line this locator reads. A session_meta line carries the run's whole
 * base instructions — ~20 KB in the stage-6 spike's rollouts — while the rest of a rollout
 * is the thread's entire history, so the bound is far above any header a harness writes
 * and far below the file whose read it saves.
 */
export const HEADER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A rollout's first line, without its newline, or undefined when the file holds none
 * within HEADER_MAX_BYTES — a line that long is not a header, and reading on would cost
 * the whole-file read this exists to avoid. Read in chunks because only that line is
 * wanted: locate runs over every rollout in the home once per wave member (TigerStyle T3).
 */
function firstLine(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const chunk = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
    const held: Buffer[] = [];
    let heldBytes = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) return undefined; // end of file with no newline: no header
      const end = chunk.subarray(0, read).indexOf(0x0a);
      const part = chunk.subarray(0, end === -1 ? read : end);
      held.push(Buffer.from(part)); // the chunk is reused by the next read
      heldBytes += part.length;
      // The bound is on the line itself, so it is checked before the newline that ends
      // it: a first line past the bound is no header, whether or not one arrives later.
      if (heldBytes > HEADER_MAX_BYTES) return undefined;
      if (end !== -1) return Buffer.concat(held).toString("utf8");
    }
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A descriptor that will not close is no reason to throw out of a locator (S3).
    }
  }
}

/**
 * A rollout's own header: its first line, parsed, when that line is a `session_meta`.
 * Only the first line decides, because a child's rollout repeats its parent's header
 * (the fork it started from) further down. Undefined when the line is missing, is not
 * JSON, or is not a header.
 */
function header(path: string): any {
  const line = firstLine(path);
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line);
    return parsed?.type === "session_meta" && parsed.payload !== null && typeof parsed.payload === "object" ? parsed.payload : undefined;
  } catch {
    return undefined;
  }
}

/** This rollout's member id as the lead saw it: the child's `agent_path` (invariant 32), in either spelling the spike's rollouts carry. */
function agentPath(payload: any): string | undefined {
  const path = payload.agent_path ?? payload.source?.subagent?.thread_spawn?.agent_path;
  return typeof path === "string" ? path : undefined;
}

/** Every rollout file this home holds, sorted so a home with two matches reads the same way twice. */
function rollouts(env: Record<string, string | undefined>): string[] {
  const home = codexHome(env);
  if (!existsSync(join(home, "sessions"))) return [];
  return [...new Bun.Glob("sessions/**/rollout-*.jsonl").scanSync({ cwd: home, absolute: true })].sort();
}

export function locate(id: string, env: Record<string, string | undefined>, session?: string): string[] {
  const found: string[] = [];
  for (const file of rollouts(env)) {
    const meta = header(file);
    if (meta === undefined) continue;
    // A thread id names the run's own rollout — a headless lens run records it, and
    // it needs no session: a thread has exactly one rollout.
    if (meta.id === id) {
      found.push(file);
      continue;
    }
    // A member id is the child's agent_path, which repeats across parent threads, so
    // the registry's `session` is what tells this thread's child from another's.
    if (agentPath(meta) !== id) continue;
    const parent = meta.parent_thread_id;
    if (typeof parent !== "string") continue;
    if (session !== undefined && parent !== session) continue;
    found.push(file);
  }
  return found;
}

/** One message's text, whatever shape its content arrived in. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("");
}

/** Every line of a rollout, parsed; a line that does not parse is skipped, as a truncated tail is. */
function lines(transcript: string): any[] {
  return transcript.split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function finalMessage(transcript: string): string | null {
  // The model's own last word is an assistant message. A rollout also carries
  // `agent_message` items (a parent's mailbox, holding its children's answers), and
  // an `event_msg` copy of each turn; neither is the thread's final message.
  const said = lines(transcript).filter((line) => line?.type === "response_item" && line.payload?.type === "message" && line.payload?.role === "assistant");
  if (said.length === 0) return null;
  return contentText(said[said.length - 1].payload.content);
}

export function model(transcript: string): string | null {
  const contexts = lines(transcript).filter((line) => line?.type === "turn_context");
  const name = contexts.length === 0 ? undefined : contexts[contexts.length - 1].payload?.model;
  return typeof name === "string" ? name : null;
}
