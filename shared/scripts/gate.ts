// Swarm build conductor — mechanical wave gate and stage finder.
// constraints.md (3, 4, 7, 7a) and the plan template's §§ 9–12 (references/plan-template.md).
//
// Reads only what is on disk: the project's plan files and the wave's own records
// under <project>/.claude/swarm/<wave-id>/. A lens PASS counts only when the wave's
// recorded result says PASS — the wave file's prose is a claim; results.json, checked
// against the harness's own transcripts by the committed transcript verdict, is the
// observation (D-W4-6, D-W4-14).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File, VERDICT_FILE, type Verdict } from "./transcripts";

export type CheckState = "ok" | "missing" | "red";

export interface GateCheck {
  id: string;
  group: "gate" | "records";
  state: CheckState;
  detail: string;
}

export interface WaveGate {
  wave: string;
  complete: boolean;
  checks: GateCheck[];
}

export interface NextStage {
  stage: number;
  name: string;
  wave: string | null;
  why: string;
}

interface LensReport {
  verdict?: unknown;
  not_covered?: unknown;
  model?: unknown;
}

// One adversarial lens member. A lens wave has ≥ 2 members (a one-item wave is not a
// wave), each on its own gate row; every member's report and model count.
interface AdversarialMember {
  report?: LensReport;
  model?: string;
}

type Add = (id: string, group: GateCheck["group"], state: CheckState, detail: string) => void;

const SLOT = /<[A-Z][A-Z0-9_]*>/;
const ROW_STATES_OBSERVED = new Set(["OBSERVED", "KNOWN-FAIL-AS-PREDICTED"]);

// A swarm-only project declares `- Wave gate: /swarm-gate` in its standing permissions;
// each wave's § 9 then carries one `swarm-gate: <item>` row per item
// (the swarm-gate procedure's wave mode). Their observed state is checked like any plain row.
const SWARM_GATE_DECLARED = /^-\s*Wave gate:\s*`?\/swarm-gate\b/m;
const SWARM_GATE_ITEMS = ["tests", "TESTS.md", "tigerstyle", "security", "simplify", "stress", "scope"];

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readJson(path: string): unknown {
  const text = read(path);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Body of the first heading matching `heading`, up to the next heading of the
// same or a higher level.
export function section(text: string, heading: RegExp): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const level = (lines[start]!.match(/^#+/) ?? ["##"])[0].length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^(#+)\s/);
    if (m && m[1]!.length <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

// Markdown table rows keyed by lower-cased header cell. An escaped pipe (`\|`)
// is a literal pipe inside a cell, not a column break (GFM).
export function tableRows(text: string): Array<Record<string, string>> {
  const rows = text
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/(?<!\\)\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replaceAll("\\|", "|")),
    );
  if (rows.length < 2) return [];
  const header = rows[0]!.map((c) => c.toLowerCase());
  return rows
    .slice(1)
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)))
    .map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

// Record entries are bullets whose bold lead-in ends with the wave — template
// § 12: `- **<date> — W<N> closed:** …` (amendment log) and `- **<date> — W<N>:** …`
// (model split). A mention elsewhere in a line, or a range like `W4–W7` in a
// planning entry's lead-in, is not the wave's record.
function entryRe(wave: string, suffix: string): RegExp {
  return new RegExp(`^[-*]\\s+\\*\\*[^*\\n]*\\b${wave}${suffix}:\\*\\*`, "im");
}

function taggedDispatches(root: string, wave: string): string[] {
  const dir = join(root, ".claude", "swarm");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => {
      const input = readJson(join(dir, id, "input.json")) as { description?: unknown } | undefined;
      const desc = typeof input?.description === "string" ? input.description : "";
      return desc === wave || desc.startsWith(`${wave} `);
    })
    .sort();
}

function lensNotCovered(report: LensReport | undefined): string[] {
  return Array.isArray(report?.not_covered) ? report!.not_covered.filter((x): x is string => typeof x === "string") : [];
}

// The model the transcript verdict records for this member: the harness wrote it into
// the member's own transcript, so it is evidence, not the lead's memory (amended
// D-W4-14, contract lens A3).
function verdictModel(dir: string, agentId: string): string | undefined {
  const verdict = readJson(join(dir, VERDICT_FILE)) as Verdict | undefined;
  const members = Array.isArray(verdict?.members) ? verdict.members : [];
  const model = members.find((m) => m?.["agentId"] === agentId)?.["model"];
  return typeof model === "string" && model !== "" ? model : undefined;
}

// The adversarial row cites `<wave-id>/<agent-id>`; its PASS is the wave's recorded
// answer for that member, and its model is the transcript verdict's.
function checkAdversarialRow(root: string, rowState: string, observed: string, add: Add): AdversarialMember {
  const [waveId, agentId] = observed.split("/");
  const dir = join(root, ".claude", "swarm", waveId ?? "");
  const results = waveId ? readJson(join(dir, "results.json")) : undefined;
  const entry = Array.isArray(results)
    ? (results as Array<Record<string, unknown>>).find((r) => r["agentId"] === agentId)
    : undefined;
  const refuse = (state: CheckState, detail: string): AdversarialMember => {
    add("adversarial-lens", "gate", state, detail);
    return {};
  };
  if (rowState !== "PASS") return refuse("red", `row state ${rowState || "empty"}`);
  if (!waveId || !agentId) return refuse("missing", `observed "${observed}" is not <wave-id>/<agent-id>`);
  if (!entry) return refuse("missing", `no result for ${agentId} in .claude/swarm/${waveId}/results.json`);
  if (entry["status"] !== "completed") return refuse("red", `${agentId} status ${String(entry["status"])}`);

  let report: LensReport | undefined;
  try {
    report = JSON.parse(String(entry["result"])) as LensReport;
  } catch {
    report = undefined;
  }
  if (report === undefined) add("adversarial-lens", "gate", "red", `${waveId}/${agentId} result is not the lens schema`);
  else if (report.verdict !== "PASS") add("adversarial-lens", "gate", "red", `${waveId}/${agentId} result verdict ${String(report.verdict)}`);
  else add("adversarial-lens", "gate", "ok", `${waveId}/${agentId} verdict PASS`);

  return { report, model: verdictModel(dir, agentId) };
}

function checkReconRow(root: string, rowState: string, observed: string, add: Add): LensReport | undefined {
  const recon = observed ? (readJson(join(root, observed)) as LensReport | undefined) : undefined;
  if (rowState !== "PASS") add("recon-lens", "gate", "red", `row state ${rowState || "empty"}`);
  else if (recon === undefined) add("recon-lens", "gate", "missing", `recon report "${observed}" missing or not JSON`);
  else if (recon.verdict !== "PASS") add("recon-lens", "gate", "red", `recon verdict ${String(recon.verdict)}`);
  else add("recon-lens", "gate", "ok", `${observed} verdict PASS`);
  return recon;
}

function checkPlainRow(name: string, rowState: string, observed: string, add: Add): void {
  const id = `row:${name}`;
  if (rowState === "RED") add(id, "gate", "red", `observed "${observed}"`);
  else if (!ROW_STATES_OBSERVED.has(rowState) || observed === "")
    add(id, "gate", "missing", `state ${rowState || "empty"}, observed "${observed}"`);
  else add(id, "gate", "ok", observed);
}

// Rules across the lenses: each kind has a row, no adversarial member ran on the recon lens's
// model, and every item any lens member reported not covering is recorded in § 11.
function checkLensPair(
  checks: GateCheck[],
  adversarial: AdversarialMember[],
  recon: LensReport | undefined,
  records: string,
  add: Add,
): void {
  if (!checks.some((c) => c.id === "adversarial-lens")) add("adversarial-lens", "gate", "missing", "no adversarial lens row");
  if (!checks.some((c) => c.id === "recon-lens")) add("recon-lens", "gate", "missing", "no recon lens row");

  const models = adversarial.map((m) => m.model);
  const shown = models.map((m) => m ?? "?").join(",");
  const reconModel = typeof recon?.model === "string" ? recon.model : undefined;
  if (models.length === 0 || models.some((m) => !m) || !reconModel)
    add("lens-models", "gate", "missing", `adversarial=${shown || "?"} recon=${reconModel ?? "?"}`);
  else if (models.includes(reconModel)) add("lens-models", "gate", "red", `adversarial and recon lenses both ran on ${reconModel}`);
  else add("lens-models", "gate", "ok", `adversarial=${shown} recon=${reconModel}`);

  const gaps = [...adversarial.flatMap((m) => lensNotCovered(m.report)), ...lensNotCovered(recon)];
  const unrecorded = gaps.filter((g) => !records.includes(`Not covered: ${g}`));
  if (unrecorded.length > 0) add("not-covered", "gate", "missing", `unrecorded: ${unrecorded.join("; ")}`);
  else add("not-covered", "gate", "ok", gaps.length === 0 ? "lenses report full coverage" : `${gaps.length} recorded`);
}

// Retro items as single strings: a bullet line plus its indented continuation lines (markdown
// wraps long bullets; the disposition usually lands on the last line).
function retroItems(retro: string): string[] {
  const items: string[] = [];
  for (const line of retro.split("\n")) {
    if (/^\s*[-*]\s+\S/.test(line)) items.push(line.trim());
    else if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function checkSwarmGateRows(root: string, rowNames: string[], add: Add): void {
  const planText = read(join(root, "plans", "BuildPlan.md")) ?? "";
  const permissions = section(planText, /^###\s+Standing permissions/i) ?? "";
  if (!SWARM_GATE_DECLARED.test(permissions)) return;
  const names = rowNames.map((n) => n.toLowerCase());
  const absent = SWARM_GATE_ITEMS.filter((item) => !names.includes(`swarm-gate: ${item.toLowerCase()}`));
  if (absent.length > 0) add("swarm-gate-rows", "gate", "missing", `no § 9 row for: ${absent.join(", ")}`);
  else add("swarm-gate-rows", "gate", "ok", `${SWARM_GATE_ITEMS.length} rows present`);
}

// S4 consumer (D-W4-14): the transcript check runs on the machine that ran the wave and
// commits its verdict with the wave; the gate reads that verdict and never finds a
// transcript itself (it stays environment-free, invariant 8). A wave whose records moved
// after the check, or whose check never ran or failed, is not gated.
function checkTranscriptVerdicts(root: string, dispatches: string[], add: Add): void {
  for (const id of dispatches) {
    const dir = join(root, ".claude", "swarm", id);
    const verdict = readJson(join(dir, VERDICT_FILE)) as Verdict | undefined;
    if (verdict === undefined) {
      add("transcript-verdict", "gate", "missing", `.claude/swarm/${id}/${VERDICT_FILE} missing or not JSON`);
      continue;
    }
    if (verdict.result !== "pass") {
      add("transcript-verdict", "gate", "red", `${id}: transcript check result ${String(verdict.result)}`);
      continue;
    }
    const results = readJson(join(dir, "results.json"));
    if (!Array.isArray(results)) {
      add("transcript-verdict", "gate", "red", `.claude/swarm/${id}/results.json missing or not an array`);
      continue;
    }
    const agentIds = (results as Array<Record<string, unknown>>).map((r) => String(r?.["agentId"] ?? ""));
    const checked = (Array.isArray(verdict.members) ? verdict.members : []).map((m) => String(m?.["agentId"] ?? ""));
    // Compared as lists, never as joined text: an id may itself hold the separator.
    if (JSON.stringify(checked) !== JSON.stringify(agentIds)) {
      add(
        "transcript-verdict",
        "gate",
        "red",
        `${id}: the verdict checked members ${checked.join(", ") || "-"}, results.json holds ${agentIds.join(", ") || "-"}`,
      );
      continue;
    }
    if (sha256File(join(dir, "results.json")) !== verdict.results_sha256) {
      add("transcript-verdict", "gate", "red", `${id}: results.json changed since the transcript check`);
      continue;
    }
    add("transcript-verdict", "gate", "ok", `${id}: ${agentIds.length} members checked against their transcripts`);
  }
}

// The wave's § 11 records; returns the dispatches tagged for this wave, which the
// transcript-verdict check below needs.
function checkRecords(root: string, wave: string, records: string, add: Add): string[] {
  const planText = read(join(root, "plans", "BuildPlan.md")) ?? "";
  const amendments = section(planText, /^##\s+(\d+\.\s+)?Amendment log/i) ?? "";
  if (entryRe(wave, " closed").test(amendments)) add("amendment-log", "records", "ok", "entry present");
  else add("amendment-log", "records", "missing", `no "- **<date> — ${wave} closed:**" entry in plans/BuildPlan.md amendment log`);

  const split = read(join(root, "docs", "model-split.md")) ?? "";
  if (entryRe(wave, "").test(split)) add("model-split", "records", "ok", "entry present");
  else add("model-split", "records", "missing", `no "- **<date> — ${wave}:**" entry in docs/model-split.md`);

  const dispatches = taggedDispatches(root, wave);
  const recorded = new Set([...records.matchAll(/^Driver record:\s*(\S+)/gm)].map((m) => m[1]!));
  const unrecorded = dispatches.filter((id) => !recorded.has(id));
  if (dispatches.length === 0) add("driver-records", "records", "missing", `no .claude/swarm/<wave-id>/input.json describes "${wave} …"`);
  else if (unrecorded.length > 0) add("driver-records", "records", "missing", `no Driver record line for ${unrecorded.join(", ")}`);
  else add("driver-records", "records", "ok", `${dispatches.length} dispatches recorded`);

  const items = retroItems(section(records, /^###\s+Retro/i) ?? "");
  const undisposed = items.filter((l) => !/\b(FOLDED|LEAD-PRACTICE)\b/.test(l));
  if (items.length === 0) add("retro", "records", "missing", `no retro items under § 11 ### Retro`);
  else if (undisposed.length > 0)
    add("retro", "records", "missing", `no disposition: ${undisposed.map((l) => l.replace(/^\s*[-*]\s+/, "")).join("; ")}`);
  else add("retro", "records", "ok", `${items.length} items dispositioned`);

  return dispatches;
}

export function checkWaveGate(root: string, wave: string): WaveGate {
  const checks: GateCheck[] = [];
  const add: Add = (id, group, state, detail) => void checks.push({ id, group, state, detail });

  const waveText = read(join(root, "plans", `${wave}.md`));
  const gateBody = waveText === null ? null : section(waveText, /^##\s+9\.\s/);
  const rows = gateBody === null ? [] : tableRows(gateBody);
  const records = (waveText === null ? null : section(waveText, /^##\s+11\.\s/)) ?? "";

  if (waveText === null) add("gate-table", "gate", "missing", `plans/${wave}.md missing`);
  else if (rows.length === 0) add("gate-table", "gate", "missing", `plans/${wave}.md § 9 has no gate rows`);
  else add("gate-table", "gate", "ok", `${rows.length} rows`);

  const adversarial: AdversarialMember[] = [];
  let recon: LensReport | undefined;
  for (const row of rows) {
    const name = row["row"] ?? "";
    const rowState = (row["state"] ?? "").toUpperCase();
    const observed = row["observed"] ?? "";
    const lname = name.toLowerCase();
    if (lname.includes("adversarial lens")) adversarial.push(checkAdversarialRow(root, rowState, observed, add));
    else if (lname.includes("recon lens")) recon = checkReconRow(root, rowState, observed, add);
    else checkPlainRow(name, rowState, observed, add);
  }
  if (rows.length > 0) checkLensPair(checks, adversarial, recon, records, add);
  if (waveText !== null) checkSwarmGateRows(root, rows.map((r) => r["row"] ?? ""), add);
  checkTranscriptVerdicts(root, checkRecords(root, wave, records, add), add);

  return { wave, complete: checks.every((c) => c.state === "ok"), checks };
}

export function nextStage(root: string): NextStage {
  if (!existsSync(join(root, "docs", "pins.md"))) return { stage: 1, name: "recon", wave: null, why: "docs/pins.md missing" };

  const planText = read(join(root, "plans", "BuildPlan.md"));
  const permissions = planText === null ? null : section(planText, /^###\s+Standing permissions/i);
  if (permissions === null || permissions.trim() === "" || SLOT.test(permissions))
    return {
      stage: 2,
      name: "calibration",
      wave: null,
      why: planText === null ? "plans/BuildPlan.md missing" : "standing permissions missing or still carry a <SLOT>",
    };

  const rows = tableRows(section(planText!, /^###\s+Wave list/i) ?? "")
    .filter((r) => !Object.values(r).some((cell) => SLOT.test(cell)))
    .map((r) => ({ wave: r["wave"] ?? "", milestone: (r["milestone"] ?? "").replace(/`/g, "").trim() }))
    .filter((r) => /^W\d+$/.test(r.wave));
  const waves = rows.map((r) => r.wave);
  if (waves.length === 0) return { stage: 3, name: "milestone-plan", wave: null, why: "no rows in ### Wave list" };
  const milestones = section(planText!, /^###\s+Milestones/i);
  if (milestones === null || milestones.trim() === "" || SLOT.test(milestones))
    return { stage: 3, name: "milestone-plan", wave: null, why: "### Milestones missing or still carries a <SLOT>" };

  // Waves before the first incomplete one are all complete, so each earlier milestone
  // is finished; the next milestone's waves wait until its amendment-log closed entry.
  const finished: string[] = [];
  for (const { wave, milestone } of rows) {
    const gate = checkWaveGate(root, wave);
    if (gate.complete) {
      if (milestone !== "" && !finished.includes(milestone)) finished.push(milestone);
      continue;
    }
    const unclosed = finished.find((m) => m !== milestone && !entryRe(m, " closed").test(planText!));
    if (unclosed !== undefined)
      return {
        stage: 12,
        name: "milestone-gate",
        wave: null,
        why: `every ${unclosed} wave is complete and the amendment log has no ${unclosed} closed entry`,
      };
    if (!existsSync(join(root, "plans", `${wave}-invariants.md`)))
      return { stage: 4, name: "probes", wave, why: `plans/${wave}-invariants.md missing` };
    if (!existsSync(join(root, "plans", `${wave}.md`)))
      return { stage: 5, name: "wave-decisions", wave, why: `plans/${wave}.md missing` };
    const table = gate.checks.find((c) => c.id === "gate-table");
    if (table?.state !== "ok") return { stage: 6, name: "wave-plan", wave, why: table?.detail ?? "no gate table" };
    const open = gate.checks.find((c) => c.group === "gate" && c.state !== "ok");
    if (open) return { stage: 7, name: "dispatch-to-gate", wave, why: `${open.id}: ${open.detail}` };
    const rec = gate.checks.find((c) => c.state !== "ok")!;
    return { stage: 11, name: "records", wave, why: `${rec.id}: ${rec.detail}` };
  }
  return { stage: 12, name: "milestone-gate", wave: null, why: `every listed wave (${waves.join(", ")}) is complete` };
}
