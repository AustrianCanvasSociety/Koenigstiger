// Minimal Agent Client Protocol client over stdio (JSON-RPC 2.0, one message
// per line), enough to prompt a Kimi session once and record what came back.
// Hand-written: no npm dependency. Reference client: plans/w2-probe/acp-spike.ts;
// the messages it received live (L6): plans/w2-probe/acp-l6-log.json. W2 kimi track.
//
// Exchange: initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile:
// false, writeTextFile: false}, terminal: false}}, session/new {cwd, mcpServers: []},
// then one session/prompt {sessionId, prompt: [{type: "text", text}]}.
//
// Every agent-to-client request is answered with the reference client's refusal,
// `{result: {outcome: {outcome: "cancelled"}}}`: an outcome the agent reads as
// "not granted", whatever the request was for. L6 recorded no agent-to-client
// request, so that shape is the reference client's, never observed live. With
// `approve: true` a session/request_permission is the one exception (W3 seam S4,
// `reply`); nothing else is ever granted. The agent's stderr is drained into the
// same log, so a failed run explains itself and a full pipe can never block the agent.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assert } from "../assert";

export type AcpOptions = {
  /** Command to spawn, e.g. ["kimi", "acp"]; tests pass a fake agent. */
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Text of the single session/prompt. */
  prompt: string;
  /**
   * Bound on the whole exchange, from spawn to the prompt result; the agent is
   * killed at the limit. Returning the run then waits a short grace for the agent
   * to go, and SIGKILLs it, so no run leaves an agent behind.
   */
  timeoutMs: number;
  /** Where every line in and out is written, including lines that are not JSON. */
  rawPath: string;
  /**
   * W3 (D-W3-7): when true, answer each session/request_permission with the
   * `allow_once` option it offers (cancelled when it offers none). Every other
   * agent-to-client request is still refused. Only for a run inside an OS fence;
   * the default refuses everything, as in W2.
   */
  approve?: boolean;
};

/**
 * `messages`: every JSON-RPC 2.0 object received from the agent, in order (lines
 * that are not JSON go to rawPath only). `stopReason`: the session/prompt
 * result's stopReason, or "timeout" / "error" when the exchange did not finish;
 * never empty (seam S5 producer). Every agent-to-client request (permission,
 * fs, terminal) is answered with a refusal, so the probe never grants anything —
 * except that with `approve: true` a session/request_permission gets its
 * `allow_once` option (W3 seam S4), for a run inside an OS fence.
 * `raw`: the recorded exchange, the rawPath file. Each line there carries what it
 * is: "> " sent to the agent, "< " received from it, "! " the agent's stderr.
 */
export type AcpRun = { messages: any[]; stopReason: string; raw: string };

/** Exactly the initialize params the reference client sent live (L6). */
const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};
/** stopReason when the agent never finished the prompt inside `timeoutMs`. */
const TIMEOUT = "timeout";
/** stopReason when the exchange broke before the prompt result (a failed initialize, a dead agent). */
const ERROR = "error";
/** How long the agent gets to honour SIGTERM before the client escalates (or gives up waiting). */
const REAP_GRACE_MS = 250;
const SENT = "> ";
const RECEIVED = "< ";
const STDERR = "! ";

/** One JSON-RPC request, resolved by the response carrying its id. */
type Call = (method: string, params: object, id: number) => Promise<any>;

/** Whether a parsed line is a JSON-RPC 2.0 object, the only kind `messages` may hold (seam S5). */
function isRpc(msg: unknown): boolean {
  return !!msg && typeof msg === "object" && !Array.isArray(msg) && (msg as any).jsonrpc === "2.0";
}

/**
 * The answer to an agent-to-client request (seam S4). Approving is exactly what
 * the live run recorded (W3 invariant 28): the option the request offers whose
 * `kind` is `allow_once`, by its own optionId — never `allow_always`, and never
 * an option chosen by name. Every other request, and a permission request that
 * offers no usable `allow_once`, gets the W2 refusal.
 */
function reply(msg: any, approve: boolean): object {
  const options = msg.method === "session/request_permission" ? msg.params?.options : undefined;
  const allow = approve && Array.isArray(options) ? options.find((o: any) => o?.kind === "allow_once" && typeof o.optionId === "string") : undefined;
  const result = allow
    ? { outcome: { outcome: "selected", optionId: allow.optionId } }
    : { outcome: { outcome: "cancelled" } };
  return { jsonrpc: "2.0", id: msg.id, result };
}

/** Hand each line of a child stream to `onLine` as it arrives; a broken pipe just ends the read. */
async function pump(stream: AsyncIterable<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const takeLines = () => {
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
  try {
    for await (const chunk of stream) {
      // stream: true holds an incomplete multi-byte sequence over to the next read.
      buf += decoder.decode(chunk, { stream: true });
      takeLines();
    }
    buf += decoder.decode();
    if (buf.trim()) onLine(buf);
  } catch {
    // The agent was killed mid-write: what arrived is already recorded.
  }
}

/**
 * End the agent: SIGTERM, a short grace for it to go, then SIGKILL. The run is
 * not over until the agent is (a stubborn one must not outlive the probe); the
 * wait is bounded either way, so a report always comes back.
 */
async function reap(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode === null) proc.kill();
  await Promise.race([proc.exited, Bun.sleep(REAP_GRACE_MS)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
  await Promise.race([proc.exited, Bun.sleep(REAP_GRACE_MS)]);
}

/** The one exchange this client drives, end to end; returns why it ended. */
async function exchange(call: Call, cwd: string, prompt: string): Promise<string> {
  const init = await call("initialize", INITIALIZE_PARAMS, 1);
  if (init.error) return ERROR;
  const session = await call("session/new", { cwd, mcpServers: [] }, 2);
  const sessionId = session.result?.sessionId;
  if (typeof sessionId !== "string") return ERROR;
  const answer = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, 3);
  return answer.error ? ERROR : String(answer.result?.stopReason || ERROR);
}

/** Write the recorded exchange, assert the producer side of the ACP seam, and return the run. */
async function closeRun(rawPath: string, lines: string[], messages: any[], stopReason: string): Promise<AcpRun> {
  mkdirSync(dirname(rawPath), { recursive: true });
  await Bun.write(rawPath, lines.length ? `${lines.join("\n")}\n` : "");
  assert(messages.every(isRpc), "acp: messages may hold only JSON-RPC 2.0 objects");
  assert(!!stopReason, "acp: stopReason must never be empty");
  return { messages, stopReason, raw: rawPath };
}

export async function runAcp(opts: AcpOptions): Promise<AcpRun> {
  const proc = Bun.spawn(opts.command, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: string[] = [];
  const messages: any[] = [];
  const pending = new Map<number, (msg: any) => void>();
  let stopReason = "";
  let settled = false;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (reason: string) => {
    if (settled) return;
    settled = true;
    stopReason = reason || ERROR;
    settle();
  };
  const send = (msg: object) => {
    const line = JSON.stringify(msg);
    lines.push(SENT + line);
    proc.stdin.write(`${line}\n`);
    proc.stdin.flush();
  };
  const call: Call = (method, params, id) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  const onLine = (line: string) => {
    lines.push(RECEIVED + line); // every line the agent sends, JSON-RPC or not (T1)
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Anything that is not a JSON-RPC 2.0 object is recorded, never handed to the evaluator.
    if (!isRpc(msg)) return;
    messages.push(msg);
    if (msg.method !== undefined && msg.id !== undefined) {
      send(reply(msg, opts.approve === true));
      return;
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };

  const reader = pump(proc.stdout, onLine);
  const errors = pump(proc.stderr, (line) => lines.push(STDERR + line));
  // The agent died: whatever it wrote before that has been read by now, so the
  // prompt result is either already in or will never come.
  proc.exited
    .then(() => Promise.all([reader, errors]))
    .then(() => finish(ERROR));

  const timer = setTimeout(() => finish(TIMEOUT), opts.timeoutMs);
  // A throw inside the exchange (a write to a dead agent, say) ends the run too.
  void exchange(call, opts.cwd, opts.prompt).then(finish, () => finish(ERROR));

  await done;
  clearTimeout(timer);
  await reap(proc);
  return closeRun(opts.rawPath, lines, messages, stopReason);
}
