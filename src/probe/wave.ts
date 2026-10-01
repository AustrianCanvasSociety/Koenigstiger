// Harness-agnostic checks of a wave probe (D-W4-7): the records the lead wrote in
// the probe project, each child's own transcript, and the transcript verdict.
// Each harness's wave leg (claude-invoke, kimi-invoke, codex-invoke) appends these
// to its own listed / loaded / finished / spawned checks. W4 gate track.
//
//   waveMarkers(n)      — n distinct markers `KTX-<8 lowercase hex>-<i>`, i = 1..n,
//                         sharing one random hex per call, so a marker from an older
//                         run (Claude transcripts outlive the probe) never matches.
//   waveArgs(args, m)   — args with its one MARKERS_PLACEHOLDER replaced by the
//                         markers joined with ", "; asserts exactly one placeholder
//                         before and none after (seam S5).
//   recordsCheck        — `records`: exactly one wave dir under
//                         <project>/.claude/swarm/, holding input.json (description
//                         starting "W0 "), results.json (an array; each marker is in
//                         exactly one member's string `result`, and every member's
//                         status is "completed") and registry.json (members[] with
//                         agent_id and model for each results.json agentId).
//   childrenCheck       — `children`: for each results.json member, locator.locate
//                         (with the registry.json member's `session` when recorded)
//                         finds exactly one transcript, and locator.finalMessage of
//                         it, trimmed, equals one marker, each marker exactly once
//                         across members. Containment is not enough: a Codex child's
//                         transcript holds its siblings' markers (W4 invariant 34).
//   verdictCheck        — `verdict`: the lead's transcripts.json says pass, and the
//                         probe's own checkTranscripts run with the build's
//                         scripts/locate.ts (imported from `plugin`) agrees; the
//                         lead's verdict is never trusted alone.
// Every check is required. None throws on a missing or malformed file: it fails
// with a detail naming the file.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkTranscripts, recordedSession, VERDICT_FILE, type Locator, type Verdict } from "../../shared/scripts/transcripts";
import { assert } from "../assert";
import type { Check } from "../probe";
import { MARKERS_PLACEHOLDER } from "../skill";

/** One check the wave leg adds, always required (src/probe.ts Check). */
function probeCheck(name: string, ok: boolean, detail: string): Check {
  return { name, ok, required: true, detail };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function waveMarkers(n: number): string[] {
  assert(Number.isInteger(n) && n >= 1, `waveMarkers: ${n} is not a positive member count`);
  const hex = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
  return Array.from({ length: n }, (_, i) => `KTX-${hex}-${i + 1}`);
}

export function waveArgs(args: string, markers: string[]): string {
  const parts = args.split(MARKERS_PLACEHOLDER);
  assert(
    parts.length === 2,
    `waveArgs: the args string holds ${parts.length - 1} ${MARKERS_PLACEHOLDER} placeholders, want exactly 1`,
  );
  assert(markers.length > 0, "waveArgs: no markers to substitute");
  return `${parts[0]!}${markers.join(", ")}${parts[1]!}`;
}

type Dispatch = { id: string; dir: string; results: Array<Record<string, unknown>>; registry: Array<Record<string, unknown>> };

/** This probe's one dispatch: the wave dir the lead wrote and the records in it. */
function probeDispatch(project: string): Dispatch | { error: string } {
  const swarm = join(project, ".claude", "swarm");
  const ids = existsSync(swarm)
    ? readdirSync(swarm, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  if (ids.length !== 1) return { error: `${ids.length} wave dirs under .claude/swarm, want exactly 1` };
  const id = ids[0]!;
  const dir = join(swarm, id);
  const found = readJson(join(dir, "results.json"));
  if (!Array.isArray(found)) return { error: `results.json is missing or not an array in .claude/swarm/${id}` };
  const registryJson = readJson(join(dir, "registry.json")) as { members?: unknown } | undefined;
  const registry = Array.isArray(registryJson?.members) ? (registryJson.members as Array<Record<string, unknown>>) : [];
  return { id, dir, results: found as Array<Record<string, unknown>>, registry };
}

function agentIdOf(entry: Record<string, unknown>): string {
  return text(entry["agentId"]);
}

export function recordsCheck(project: string, markers: string[]): Check {
  const dispatch = probeDispatch(project);
  if ("error" in dispatch) return probeCheck("records", false, dispatch.error);
  const { id, dir, results, registry } = dispatch;

  const description = text((readJson(join(dir, "input.json")) as { description?: unknown } | undefined)?.description);
  if (!description.startsWith("W0 ")) return probeCheck("records", false, `input.json description "${description}" does not start "W0 "`);

  for (const entry of results) {
    if (entry["status"] !== "completed")
      return probeCheck("records", false, `results.json member ${agentIdOf(entry)} status ${String(entry["status"])}, want completed`);
  }

  const answers = results.map((entry) => text(entry["result"]));
  for (const marker of markers) {
    const seen = answers.filter((answer) => answer.includes(marker)).length;
    if (seen !== 1) return probeCheck("records", false, `marker ${marker} is in ${seen} members' results, want exactly 1`);
  }

  for (const entry of results) {
    const agentId = agentIdOf(entry);
    const member = registry.find((m) => m["agent_id"] === agentId);
    if (member === undefined) return probeCheck("records", false, `registry.json has no member ${agentId}`);
    if (text(member["model"]) === "") return probeCheck("records", false, `registry.json member ${agentId} records no model`);
  }

  return probeCheck("records", true, `.claude/swarm/${id}: ${results.length} members, every marker in one completed member`);
}

export function childrenCheck(project: string, markers: string[], locator: Locator, env: Record<string, string | undefined>): Check {
  const dispatch = probeDispatch(project);
  if ("error" in dispatch) return probeCheck("children", false, dispatch.error);

  const answers: string[] = [];
  for (const entry of dispatch.results) {
    const agentId = agentIdOf(entry);
    if (agentId === "") return probeCheck("children", false, "a results.json member has no agentId");
    const session = recordedSession(dispatch.registry, agentId);
    const where = session === undefined ? "" : ` in session ${session}`;

    let found: unknown = null;
    try {
      found = locator.locate(agentId, env, session);
    } catch (e) {
      return probeCheck("children", false, `locator.locate threw for ${agentId}: ${errorText(e)}`);
    }
    const paths = Array.isArray(found) ? found : [];
    if (paths.length !== 1) return probeCheck("children", false, `${paths.length} transcripts for ${agentId}${where}, want exactly 1`);

    const path = String(paths[0]);
    let transcript = "";
    try {
      transcript = readFileSync(path, "utf8");
    } catch (e) {
      return probeCheck("children", false, `cannot read ${path}: ${errorText(e)}`);
    }
    let final: unknown = null;
    try {
      final = locator.finalMessage(transcript);
    } catch (e) {
      return probeCheck("children", false, `locator.finalMessage threw on ${path}: ${errorText(e)}`);
    }
    const answer = typeof final === "string" ? final.trim() : "";
    if (markers.filter((m) => m === answer).length !== 1)
      return probeCheck("children", false, `${agentId}'s final message is not exactly one marker (${path})`);
    answers.push(answer);
  }

  for (const marker of markers) {
    const seen = answers.filter((answer) => answer === marker).length;
    if (seen !== 1) return probeCheck("children", false, `marker ${marker} is the final message of ${seen} members, want exactly 1`);
  }

  return probeCheck("children", true, `${answers.length} members, each transcript's final message is its own marker`);
}

/** `plugin` is the built plugin root; `skill` names the skill whose scripts/locate.ts to load. */
export async function verdictCheck(project: string, plugin: string, skill: string, env: Record<string, string | undefined>): Promise<Check> {
  const dispatch = probeDispatch(project);
  if ("error" in dispatch) return probeCheck("verdict", false, dispatch.error);

  const lead = readJson(join(dispatch.dir, VERDICT_FILE)) as Verdict | undefined;
  if (lead === undefined) return probeCheck("verdict", false, `${VERDICT_FILE} is missing or not JSON in .claude/swarm/${dispatch.id}`);
  if (lead.result !== "pass") return probeCheck("verdict", false, `the lead's ${VERDICT_FILE} says result=${String(lead.result)}`);

  const locatorPath = join(plugin, "skills", skill, "scripts", "locate.ts");
  let locator: Locator;
  try {
    locator = (await import(locatorPath)) as Locator;
  } catch (e) {
    return probeCheck("verdict", false, `cannot load ${locatorPath}: ${errorText(e)}`);
  }
  if (typeof locator?.locate !== "function") return probeCheck("verdict", false, `${locatorPath} exports no locate()`);

  const own = checkTranscripts(project, dispatch.id, locator, env);
  if (own.results_sha256 !== lead.results_sha256)
    return probeCheck("verdict", false, `results.json changed since the lead's check: results_sha256 ${own.results_sha256} now, ${String(lead.results_sha256)} in ${VERDICT_FILE}`);
  const leadIds = (Array.isArray(lead.members) ? lead.members : []).map((m) => text(m?.agentId));
  const ownIds = own.members.map((m) => m.agentId);
  // Compared as lists, never as joined text: an id may itself hold the separator.
  if (JSON.stringify(leadIds) !== JSON.stringify(ownIds))
    return probeCheck("verdict", false, `${VERDICT_FILE} lists members ${leadIds.join(", ") || "-"}, results.json's members are ${ownIds.join(", ") || "-"}`);
  if (own.result !== "pass")
    return probeCheck("verdict", false, `the probe's own transcript check says ${own.result}: ${own.members.find((m) => !m.ok)?.detail ?? "no members"}`);
  return probeCheck("verdict", true, `${VERDICT_FILE} matches the probe's own check of ${own.members.length} members`);
}
