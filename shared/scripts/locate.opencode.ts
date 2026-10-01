// OpenCode transcript locator (D-W5-7, D-W5-15): built as scripts/locate.ts in
// the OpenCode build only. W5 harness track.
//
// OpenCode v2 keeps every session in one SQLite database (W5 invariant 28), so
// there is no per-member file to find. A member's id is its child session id,
// `ses_` + 26 characters, globally unique (invariant 21): no `session` narrowing.
// locate(id, env): for a `ses_` id, runs
//   opencode session export --standalone <id>
// (cwd env.PWD, else the process cwd) and writes its stdout to
// <TMPDIR>/ktx-opencode-export/<id>.json, returning [that absolute path]; []
// for any other id (without running anything), when the export fails, or when
// that directory is not this user's own 0700 one (SEC-001).
// finalMessage(text): OpenCode's own rule (invariant 30) on the export: the
// newest assistant message with time.completed set and no error, its text
// parts joined with ""; null when there is none or the JSON does not parse.
// model(text): the export's assistant model as provider/id, plus #variant
// unless the variant is "default" (invariant 31); null when absent. The two
// read the same message: the newest assistant message that completed without
// an error, which is the one whose text answers the lead (invariant 30).
// Seam S4 producer: none of them throws. Never read opencode.db (D-W5-7).
//
// The export is fresh on every call — a member whose id is located twice is exported
// twice — because the verdict hashes the file this call wrote, and a member's answer
// may have been continued since. `makeLocate(spawn)` is the seam a test drives with a
// fake spawn; the build's own `locate` is it over `Bun.spawnSync`.
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Harness } from "./transcripts";

export const HARNESS: Harness = "opencode";

/** OpenCode's session ids: `ses_` + 26 characters of [0-9A-Za-z] (invariant 21). */
const SESSION_ID = /^ses_[0-9A-Za-z]{26}$/;
/** Where an export lands, under the temp dir: one file per session id. */
const EXPORT_DIR = "ktx-opencode-export";
/**
 * The export starts a private server and asks it for one session; L6 and L7 came back
 * in about a second. A stall is killed rather than hanging the lead's check (seam S4).
 */
const EXPORT_TIMEOUT_MS = 60_000;

/** One `opencode session export` run: its exit code (null when it was killed) and stdout. */
export type ExportRun = { exitCode: number | null; stdout: string };

/** How this locator runs the harness's own command; `Bun.spawnSync` in the build. */
export type ExportSpawn = (
  argv: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => ExportRun;

const spawnExport: ExportSpawn = (argv, { cwd, env }) => {
  const proc = Bun.spawnSync(argv, { cwd, env, timeout: EXPORT_TIMEOUT_MS, stdin: "ignore", stderr: "ignore" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
};

/**
 * The directory exports land in: `$TMPDIR` when the environment names one, else the
 * OS's own temp dir. Resolved, so every path `locate` answers with is absolute (S4).
 */
function exportDir(env: Record<string, string | undefined>): string {
  const named = env.TMPDIR?.trim();
  return join(named ? resolve(named) : tmpdir(), EXPORT_DIR);
}

/**
 * Whether `dir` is fit to hold exports (SEC-001): created 0700, or an existing real
 * directory this user owns, tightened to 0700. A link, or another user's directory in
 * a shared /tmp, is refused: its owner could read every export, or swap one before the
 * verdict hashes it. Throws only where mkdir does (a file in the way); the caller's
 * catch makes that [].
 */
function privateDir(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) return false;
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return true;
}

/** The directory the export runs in: the wave's project root (`$PWD`), else this process's. */
function waveRoot(env: Record<string, string | undefined>): string {
  const named = env.PWD?.trim();
  return named ? resolve(named) : process.cwd();
}

/**
 * The export's parsed document, or undefined when stdout holds no export. `opencode
 * session export` prints a JSON object; anything else is not an export this locator
 * can answer with (seam S4's "a path it just wrote").
 */
function exported(text: string): any {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How far back OpenCode looks for a member's answer: its newest 20 messages of any
 * type (session/subagent-job.ts:46, the path a wave's own spawn takes; W-T5). Past
 * them it delivers its no-text fallback, so the locator should not find an older one.
 * The export is not that list: it drops unsettled entries (an assistant message not
 * completed, a running shell or compaction; session/transfer.ts:59, :165-169), so
 * when such entries sit among the newest 20 this window reaches further back than
 * OpenCode's and can find an answer OpenCode did not deliver — the check then fails
 * the member, never passes a wrong one. (A child resumed after a server restart is
 * read by execution/restart.ts, unbounded.)
 */
const ANSWER_WINDOW = 20;

/**
 * The message OpenCode answers with: the newest assistant message among the last
 * ANSWER_WINDOW that completed without an error (invariant 30, the rule in its own
 * session/subagent-job.ts), or undefined when those hold none.
 */
function answer(doc: any): any {
  const messages = doc?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - ANSWER_WINDOW); i--) {
    const message = messages[i];
    if (message?.type !== "assistant") continue;
    if (message.time?.completed === undefined) continue;
    if (message.error !== undefined) continue;
    return message;
  }
  return undefined;
}

/**
 * One export run, or null when the spawn itself failed: `Bun.spawnSync` throws when
 * `opencode` is not on PATH (or cannot be started), and a machine without it is a
 * zero-transcript answer, never a throw (seam S4).
 */
function runExport(spawn: ExportSpawn, id: string, env: Record<string, string | undefined>): ExportRun | null {
  try {
    return spawn(["opencode", "session", "export", "--standalone", id], { cwd: waveRoot(env), env });
  } catch {
    return null;
  }
}

/**
 * `locate` over an injected spawn: the seam a test drives with a fake, so no test
 * starts an OpenCode server, and the build's own `locate` is this over `Bun.spawnSync`.
 */
export function makeLocate(spawn: ExportSpawn): (id: string, env: Record<string, string | undefined>, session?: string) => string[] {
  return (id, env) => {
    // An id that is not one OpenCode would mint names no session, so nothing runs:
    // it is also what keeps the id from being a path (`../…`) in the export's name.
    if (!SESSION_ID.test(id)) return [];
    const run = runExport(spawn, id, env);
    if (run === null || run.exitCode !== 0) return [];
    if (exported(run.stdout) === undefined) return [];
    const dir = exportDir(env);
    const path = join(dir, `${id}.json`);
    try {
      if (!privateDir(dir)) return [];
      writeFileSync(path, run.stdout);
    } catch {
      return [];
    }
    return [path];
  };
}

/** A message's text: its `text` parts in order, joined with nothing; "" when it holds none. */
function textOf(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** The build's locator: `makeLocate` over `Bun.spawnSync` (D-W5-15). */
export const locate = makeLocate(spawnExport);

export function finalMessage(transcript: string): string | null {
  const message = answer(exported(transcript));
  return message === undefined ? null : textOf(message);
}

export function model(transcript: string): string | null {
  const message = answer(exported(transcript));
  const record = message?.model;
  const provider = typeof record?.providerID === "string" ? record.providerID.trim() : "";
  const id = typeof record?.id === "string" ? record.id.trim() : "";
  if (provider === "" || id === "") return null;
  // A variant named `default` is what OpenCode fills in when none was asked for
  // (invariant 31), so naming it would put one model under two spellings.
  const variant = typeof record?.variant === "string" ? record.variant.trim() : "";
  return variant === "" || variant === "default" ? `${provider}/${id}` : `${provider}/${id}#${variant}`;
}
