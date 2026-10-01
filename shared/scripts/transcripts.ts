// Transcript cross-check (D-W4-6, D-W4-14). The lead writes a wave's records;
// this check ties each recorded result to the transcript the harness itself wrote.
//
// For every member of .claude/swarm/<wave-id>/results.json (an array; each entry's
// `agentId` names the member as the harness named it to the lead, `result` is its
// final message as a string), with `session` taken from the registry.json member
// whose `agent_id` equals that agentId (optional: the lead's session or thread id,
// or a headless run's own id, recorded per harness.md § Transcripts; W4 invariant 32):
//   - locator.locate(agentId, env, session) must return exactly one path (zero: the
//     member never ran here; several: the id is ambiguous — Kimi's `agent-0` and
//     Codex's `/root/one` repeat across sessions — and the verdict detail says to
//     record the session);
//   - locator.finalMessage(<that file's text>) must not be null;
//   - the recorded `result`, trimmed, must equal that final message, trimmed (an
//     exact match: on Codex a child's transcript holds its siblings' markers too,
//     W4 invariant 34);
//   - locator.model(<that text>) gives the model the harness says the member ran on
//     (W4 invariant 36), written to the verdict; null when the transcript has none.
// An agentId that repeats an earlier entry's fails the later entry, naming the repeat:
// one transcript cannot back two members. A results.json holding more than MEMBERS_MAX
// members is a fail verdict too, every member failed for the bound and nothing located.
// The verdict is pass only when every member passes and results.json holds at
// least one member. checkTranscripts reads and never writes; writeVerdict writes
// only <root>/.claude/swarm/<wave-id>/transcripts.json.
//
// Seam S3 consumer (checkTranscripts) and S4 producer (writeVerdict): the verdict
// carries results_sha256, the sha256 of the exact results.json bytes checked, and
// one member entry per results.json member, in results.json order. The gate takes
// each adversarial lens member's model from the verdict, not from the lead-written
// registry.json (contract lens A3). W4 gate track.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Harness = "claude" | "kimi" | "codex" | "opencode";

/** The build's per-harness transcript locator: scripts/locate.ts (D-W4-10). */
export type Locator = {
  HARNESS: Harness;
  /**
   * Absolute paths of existing transcript files for member `id`, narrowed to
   * `session` when it is given; [] when none. Never throws.
   */
  locate(id: string, env: Record<string, string | undefined>, session?: string): string[];
  /**
   * The member's answer as it reached the lead — the last assistant text in a
   * transcript, or Claude's last SubagentHandback message when it made one — or null
   * when there is none. Never throws.
   */
  finalMessage(transcript: string): string | null;
  /** The model the harness recorded the member as running on, or null. Never throws. */
  model(transcript: string): string | null;
};

export type MemberVerdict = {
  agentId: string;
  ok: boolean;
  transcript_sha256: string | null;
  model: string | null;
  detail: string;
};

/** The committed transcripts.json shape. */
export type Verdict = {
  schema: 1;
  harness: Harness;
  wave_id: string;
  result: "pass" | "fail";
  results_sha256: string;
  members: MemberVerdict[];
};

export const VERDICT_FILE = "transcripts.json";
/**
 * The most members one results.json may hold. Kimi's AgentSwarm takes up to 128
 * members in one call, the largest spawn ceiling of the four harnesses (W4
 * invariant 16; OpenCode's `subagent` caps nothing, W5 invariant 22), so a longer
 * file is a broken record rather than a wave: it fails here without a locate or a
 * sha256 per member.
 */
export const MEMBERS_MAX = 128;
const RESULTS_FILE = "results.json";
const REGISTRY_FILE = "registry.json";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HARNESSES: Harness[] = ["claude", "kimi", "codex", "opencode"];

/** A violated pre- or postcondition is a bug in this check, not a wave's records. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** A wave id is one path segment: not empty, no separator, never a directory step. */
export function isWaveId(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}

/** A file's exact bytes; null when it cannot be read. */
function readBytes(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** sha256, hex, of a file's exact bytes; null when the file cannot be read. */
export function sha256File(path: string): string | null {
  const bytes = readBytes(path);
  return bytes === null ? null : sha256(bytes);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function waveDir(root: string, waveId: string): string {
  return join(root, ".claude", "swarm", waveId);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The wave's registry members, or [] when registry.json is missing or malformed. */
function readRegistry(dir: string): Array<Record<string, unknown>> {
  const registry = readJson(join(dir, REGISTRY_FILE)) as { members?: unknown } | undefined;
  return Array.isArray(registry?.members) ? (registry.members as Array<Record<string, unknown>>) : [];
}

/**
 * The registry member's recorded `session` for this id, or undefined (amended
 * D-W4-14). Exported for src/probe/wave.ts's childrenCheck, which reads the same
 * field: one copy, not two (T7).
 */
export function recordedSession(registry: Array<Record<string, unknown>>, agentId: string): string | undefined {
  const session = registry.find((m) => m?.["agent_id"] === agentId)?.["session"];
  return typeof session === "string" && session !== "" ? session : undefined;
}

/** The entry's `agentId`, as the harness named the member to the lead; "" when it has none. */
function entryAgentId(entry: unknown): string {
  const record = (entry ?? {}) as Record<string, unknown>;
  return typeof record["agentId"] === "string" ? record["agentId"] : "";
}

/** The first results.json index each agentId appears at, so a later repeat can name it. */
function firstIndexes(entries: unknown[]): Map<string, number> {
  const first = new Map<string, number>();
  entries.forEach((entry, index) => {
    const agentId = entryAgentId(entry);
    if (agentId !== "" && !first.has(agentId)) first.set(agentId, index);
  });
  return first;
}

function fail(agentId: string, detail: string, transcriptSha256: string | null = null, model: string | null = null): MemberVerdict {
  return { agentId, ok: false, transcript_sha256: transcriptSha256, model, detail };
}

/**
 * One results.json entry against the transcript the harness wrote for it. `first`
 * holds each agentId's first index, from firstIndexes.
 */
function checkMember(
  entry: unknown,
  index: number,
  first: ReadonlyMap<string, number>,
  registry: Array<Record<string, unknown>>,
  locator: Locator,
  env: Record<string, string | undefined>,
): MemberVerdict {
  const record = (entry ?? {}) as Record<string, unknown>;
  const agentId = entryAgentId(entry);
  if (agentId === "") return fail("", `results.json[${index}] has no agentId`);
  const repeated = first.get(agentId);
  if (repeated !== undefined && repeated < index)
    return fail(agentId, `results.json[${index}] repeats agentId "${agentId}" of results.json[${repeated}]`);
  const session = recordedSession(registry, agentId);
  const where = session === undefined ? "" : ` in session ${session}`;

  // A locator that throws fails its member, never the whole check (seam S3).
  let found: unknown = null;
  try {
    found = locator.locate(agentId, env, session);
  } catch (e) {
    return fail(agentId, `locator.locate threw: ${message(e)}`);
  }
  const paths = Array.isArray(found) ? found : [];
  if (paths.length === 0) return fail(agentId, `0 transcripts for ${agentId}${where}`);
  if (paths.length > 1)
    return fail(agentId, `${paths.length} transcripts for ${agentId}${where}: record its session in ${REGISTRY_FILE} (${paths.join(", ")})`);

  const path = String(paths[0]);
  const bytes = readBytes(path);
  if (bytes === null) return fail(agentId, `cannot read the transcript ${path}`);
  const text = bytes.toString("utf8");
  const transcriptSha256 = sha256(bytes);
  let model: string | null = null;
  let final: unknown = null;
  try {
    const recorded = locator.model(text);
    model = typeof recorded === "string" && recorded !== "" ? recorded : null;
    final = locator.finalMessage(text);
  } catch (e) {
    return fail(agentId, `locator threw on ${path}: ${message(e)}`, transcriptSha256);
  }
  if (typeof final !== "string") return fail(agentId, `no final message in ${path}`, transcriptSha256, model);
  if (typeof record["result"] !== "string")
    return fail(agentId, `results.json result for ${agentId} is not a string`, transcriptSha256, model);
  if (record["result"].trim() !== final.trim())
    return fail(agentId, `recorded result for ${agentId} is not the final message in ${path}`, transcriptSha256, model);
  return { agentId, ok: true, transcript_sha256: transcriptSha256, model, detail: `final message is ${path}` };
}

/** Check one wave's records against the harness's transcripts; reads only. */
export function checkTranscripts(
  root: string,
  waveId: string,
  locator: Locator,
  env: Record<string, string | undefined>,
): Verdict {
  assert(isWaveId(waveId), `wave id "${waveId}" is not one path segment`);
  assert(HARNESSES.includes(locator.HARNESS), `locator.HARNESS "${String(locator.HARNESS)}" is one of ${HARNESSES.join(", ")}`);

  const dir = waveDir(root, waveId);
  const bytes = readBytes(join(dir, RESULTS_FILE));
  let parsed: unknown;
  try {
    parsed = bytes === null ? undefined : JSON.parse(bytes.toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [];
  const resultsSha256 = bytes === null ? "" : sha256(bytes);

  // Past the bound this is a broken record, not a wave: fail every member naming the
  // bound, and locate nothing (MEMBERS_MAX says why).
  if (entries.length > MEMBERS_MAX) {
    const detail = `results.json holds ${entries.length} members, over MEMBERS_MAX ${MEMBERS_MAX}`;
    return {
      schema: 1,
      harness: locator.HARNESS,
      wave_id: waveId,
      result: "fail",
      results_sha256: resultsSha256,
      members: entries.map((entry) => fail(entryAgentId(entry), detail)),
    };
  }

  const registry = readRegistry(dir);
  const first = firstIndexes(entries);
  const members = entries.map((entry, i) => checkMember(entry, i, first, registry, locator, env));

  return {
    schema: 1,
    harness: locator.HARNESS,
    wave_id: waveId,
    result: members.length > 0 && members.every((m) => m.ok) ? "pass" : "fail",
    results_sha256: resultsSha256,
    members,
  };
}

/** Write <root>/.claude/swarm/<waveId>/transcripts.json. */
export function writeVerdict(root: string, waveId: string, verdict: Verdict): void {
  assert(isWaveId(waveId), `wave id "${waveId}" is not one path segment`);
  assert(verdict.schema === 1, `verdict schema ${String(verdict.schema)} is 1`);
  assert(verdict.wave_id === waveId, `verdict wave_id "${String(verdict.wave_id)}" is the wave written ("${waveId}")`);
  assert(HARNESSES.includes(verdict.harness), `verdict harness "${String(verdict.harness)}" is one of ${HARNESSES.join(", ")}`);
  assert(verdict.result === "pass" || verdict.result === "fail", `verdict result "${String(verdict.result)}" is pass or fail`);
  assert(
    verdict.results_sha256 === "" || SHA256_HEX.test(verdict.results_sha256),
    `results_sha256 "${String(verdict.results_sha256)}" is a sha256 hex digest, or empty when there was no results.json`,
  );
  assert(Array.isArray(verdict.members), "verdict members is an array, one entry per results.json member");

  const dir = waveDir(root, waveId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, VERDICT_FILE), `${JSON.stringify(verdict, null, 2)}\n`);
}
