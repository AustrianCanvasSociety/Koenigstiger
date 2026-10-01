// `ktx config` — arrow-key options menu, hand-built on raw terminal input (no dependencies).
// W1 track menu. See plans/W1.md § 8.
import { BANNER } from "./banner";
import { formatValue, OPTIONS, type OptionDef, type Options } from "./options";
import { PLAIN, themeStyle, type Style } from "./themes";

/**
 * A decoded keypress. Printable input arrives as text; the menu decides what a letter means in each mode.
 * A space decodes to "space"; in a text prompt the menu inserts it as a space character.
 */
export type Key = "up" | "down" | "left" | "right" | "space" | "enter" | "escape" | "backspace" | "tab" | "ctrl-c" | { text: string };

export type MenuIO = {
  keys: AsyncIterable<Key>;
  write: (s: string) => void;
  /** The terminal's height in rows, when it is known; the banner is left out of a frame it would push off the screen. */
  rows?: () => number | undefined;
  /** The terminal's width in columns, when it is known; the panel narrows to fit it. */
  cols?: () => number | undefined;
};

// Every frame clears the screen and homes the cursor, so the menu stays one screen.
const CLEAR = "\x1b[2J\x1b[H";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** The panel's inner width in columns in a terminal wide enough for it; every row is padded or cut to the panel's width. */
export const WIDTH = 64;
/** The narrowest panel drawn; a terminal too narrow even for this wraps its rows. */
export const MIN_WIDTH = 24;
const MARGIN = "  ";
/** What a row adds around the panel's width: the margin, a gutter each side, and one spare column so no row ends on the terminal's last cell. */
const ROW_CHROME = MARGIN.length + 3;

/** The panel's width in a terminal `cols` wide: WIDTH when it fits or the width is unknown, else what fits, never under MIN_WIDTH. */
export function panelWidth(cols: number | undefined): number {
  if (cols === undefined) return WIDTH;
  return Math.max(MIN_WIDTH, Math.min(WIDTH, cols - ROW_CHROME));
}

/** The product's official name, on the top level's title row; `ktx` is its short name and its command. */
const NAME = "Königstiger";

/** A style (themes.ts) at the width this frame is drawn to. */
type Panel = Style & { width: number };

/** Which screen the menu is on. */
type Mode = "top" | "choices" | "one" | "list" | "prompt";

/** One frame: the body lines, and the footer naming the keys that work in the current mode. */
type Frame = { lines: string[]; keys: string };

/** Everything a keypress can change: the draft being edited, the cursors, and how the menu ended. */
type State = {
  draft: Options;
  mode: Mode;
  index: number; // the top-level row
  sub: number; // the cursor inside a choices sub-list or a list editor
  prompt: string; // the text prompt buffer
  notice: string; // explains, for one frame, why a key did nothing
  done: boolean; // set once the menu has resolved
  result: Options | null; // the options on `s`, null on a quit
};

const len = (s: string) => [...s].length;
/** `s` cut to `width` columns, ending in an ellipsis when something was dropped; no room at all is the empty string. */
const cut = (s: string, width: number) => (len(s) <= width ? s : width <= 0 ? "" : `${[...s].slice(0, width - 1).join("")}…`);
const paint = (code: string, s: string) => (code && s ? `${code}${s}${RESET}` : s);

/**
 * One row of the panel, the panel's width between two one-column gutters: `left` at the
 * left edge and `right` at the right edge, at least two columns apart. The right side
 * keeps up to a third of the width, so a short value (`on`, `(none)`) is never pushed out
 * by a long label; the left is cut to what remains, then the right to what the left
 * leaves. The selected row is one bar in the selected style; on any other row only the
 * right side is dim.
 */
function row(left: string, right: string, selected: boolean, style: Panel): string {
  const kept = Math.min(len(right), Math.floor(style.width / 3));
  const l = cut(left, style.width - (kept ? kept + 2 : 0));
  const r = cut(right, Math.max(0, style.width - len(l) - 2));
  const gap = " ".repeat(style.width - len(l) - len(r));
  if (selected) return `${MARGIN}${style.selected} ${l}${gap}${r} ${RESET}`;
  return `${MARGIN} ${l}${gap}${paint(style.dim, r)} `;
}

/**
 * The title row: the screen's name in bold, an optional dim note two columns after it
 * (the command, on the top level), and the key that leaves the screen, dim, at the right edge.
 */
const title = (name: string, style: Panel, sub = "") => {
  const l = cut(name, style.width - 5);
  const s = cut(sub ? `  ${sub}` : "", Math.max(0, style.width - len(l) - 5));
  return `${MARGIN} ${paint(style.title, l)}${paint(style.dim, s)}${" ".repeat(style.width - len(l) - len(s) - 3)}${paint(style.dim, "esc")} `;
};

/** `text` broken at spaces into lines of at most `width` columns; a longer word gets its own line. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (line && len(line) + 1 + len(word) > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The help or notice under the rows, dim and wrapped to the panel. */
const note = (text: string, style: Panel) => wrap(text, style.width).map((l) => `${MARGIN} ${paint(style.dim, l)}`);

/**
 * An option's group and its row text. A label written `Group: text` belongs to that
 * group and shows the text with its first letter raised; any other label is General.
 */
export function grouped(def: OptionDef): { group: string; text: string } {
  const at = def.label.indexOf(": ");
  if (at < 0) return { group: "General", text: def.label };
  const text = def.label.slice(at + 2);
  return { group: def.label.slice(0, at), text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/** A row's value at the right edge: a free-form list of two or more shows its count; its editor shows the entries. */
function summary(def: OptionDef, value: Options[string]): string {
  if (def.kind === "list" && (value as string[]).length > 1) return `${(value as string[]).length} entries`;
  return formatValue(def, value);
}

function topFrame(draft: Options, index: number, style: Panel): Frame {
  const lines = [title(NAME, style, "ktx config")];
  let last = "";
  OPTIONS.forEach((d, i) => {
    const { group, text } = grouped(d);
    if (group !== last) lines.push("", `${MARGIN} ${paint(style.group, group)}`);
    last = group;
    lines.push(row(text, summary(d, draft[d.key]), i === index, style));
  });
  return {
    lines: [...lines, "", ...note(OPTIONS[index].help, style)],
    keys: "up/down move · space toggle · enter open · s save · q quit",
  };
}

/** The sub-list of a single choice: the chosen one is marked, and choosing another shows at once. */
function oneFrame(def: OptionDef, chosen: string, index: number, style: Panel): Frame {
  return {
    lines: [
      title(`${NAME} › ${def.label}`, style),
      "",
      ...def.choices!.map((c, i) => row(`${c === chosen ? "(•)" : "( )"} ${c}`, "", i === index, style)),
      "",
      ...note(def.help, style),
    ],
    keys: "up/down move · space choose · enter choose and back · escape back",
  };
}

function choicesFrame(def: OptionDef, chosen: string[], index: number, notice: string, style: Panel): Frame {
  return {
    lines: [
      title(`${NAME} › ${def.label}`, style),
      "",
      ...def.choices!.map((c, i) => row(`${chosen.includes(c) ? "[x]" : "[ ]"} ${c}`, "", i === index, style)),
      "",
      ...note(notice || def.help, style), // the notice explains, for one frame, the key that was refused
    ],
    keys: "up/down move · space toggle · enter/escape back",
  };
}

function listFrame(def: OptionDef, entries: string[], index: number, style: Panel): Frame {
  return {
    lines: [
      title(`${NAME} › ${def.label}`, style),
      "",
      ...(entries.length
        ? entries.map((e, i) => row(e, "", i === index, style))
        : note("(no entries — press a to add one)", style)),
      "",
      ...note(def.help, style),
    ],
    keys: "up/down move · a add · d delete · escape back",
  };
}

function promptFrame(def: OptionDef, input: string, style: Panel): Frame {
  return {
    // The typed text, then one cell in the selected style standing in for the cursor.
    lines: [title(`${NAME} › ${def.label}`, style), "", `${MARGIN} ${paint(style.dim, "Add")} ${input}${style.selected} ${RESET}`],
    keys: "enter accept · escape cancel",
  };
}

/** The footer: the keys of the current mode, dim, wrapped to the panel like the help above it. */
const footer = (frame: Frame, style: Panel) => note(frame.keys, style);

const draw = (frame: Frame, style: Panel) => CLEAR + ["", ...frame.lines, "", ...footer(frame, style)].join("\n") + "\n";

/**
 * Show every option in OPTIONS and let the user change them; resolves to the edited options on save,
 * or null on quit without saving (q or escape at top level, ctrl-c anywhere, or the key stream ending).
 * Every frame is drawn in the theme the draft holds, so a theme change shows before it is saved;
 * `plain` (NO_COLOR) draws every frame without colour instead.
 */
export async function runMenu(io: MenuIO, options: Options, plain = false): Promise<Options | null> {
  // Edits land in a private copy seeded from the registry, so the caller's options are never mutated
  // and a partial object still renders every row.
  const draft: Options = Object.fromEntries(OPTIONS.map((d) => [d.key, structuredClone(d.default)]));
  for (const def of OPTIONS) if (options[def.key] !== undefined) draft[def.key] = structuredClone(options[def.key]);

  const state: State = { draft, mode: "top", index: 0, sub: 0, prompt: "", notice: "", done: false, result: null };
  redraw(state, io, plain);
  for await (const key of io.keys) {
    if (key === "ctrl-c") return null; // anywhere, including a text prompt
    state.notice = ""; // a notice explains the key just refused, so it lives for exactly one frame
    const handle =
      state.mode === "top" ? topKey : state.mode === "choices" ? choicesKey : state.mode === "one" ? oneKey : state.mode === "list" ? listKey : promptKey;
    handle(state, key);
    if (state.done) return state.result;
    redraw(state, io, plain);
  }
  return null; // the key stream ended without a save or a quit
}

const currentDef = (state: State) => OPTIONS[state.index];
const entries = (state: State) => state.draft[currentDef(state).key] as string[];

/** What `draw` adds around a frame's lines besides the footer: a blank line above, a blank before the footer, and the cursor's own line. */
const CHROME_ROWS = 3;
const BANNER_WIDTH = len(BANNER[0]);

/**
 * The top level with the banner over it, when it fits: the panel must be as wide as the
 * banner, and the banner, a blank line and the frame no taller than the terminal, because
 * a frame that scrolls loses its title. An unknown height (a pipe, a test) shows it.
 */
function withBanner(frame: Frame, style: Panel, rows: number | undefined): Frame {
  const needed = BANNER.length + 1 + frame.lines.length + CHROME_ROWS + footer(frame, style).length;
  if (style.width < BANNER_WIDTH || (rows !== undefined && needed > rows)) return frame;
  return { ...frame, lines: [...BANNER.map((line) => `${MARGIN} ${paint(style.banner, line)}`), "", ...frame.lines] };
}

function redraw(state: State, io: MenuIO, plain: boolean): void {
  const def = currentDef(state);
  // The theme is the draft's, and the width is read on every frame, so a theme just chosen
  // and a resized terminal are both right from the next keypress.
  const style: Panel = { ...(plain ? PLAIN : themeStyle(state.draft.theme)), width: panelWidth(io.cols?.()) };
  const frame =
    state.mode === "prompt" ? promptFrame(def, state.prompt, style)
    : state.mode === "one" ? oneFrame(def, state.draft[def.key] as string, state.sub, style)
    : state.mode === "choices" ? choicesFrame(def, entries(state), state.sub, state.notice, style)
    : state.mode === "list" ? listFrame(def, entries(state), state.sub, style)
    : withBanner(topFrame(state.draft, state.index, style), style, io.rows?.());
  io.write(draw(frame, style));
}

/** Resolve the menu: `s` resolves the draft, a quit resolves null. */
function finish(state: State, result: Options | null): void {
  state.done = true;
  state.result = result;
}

/** Top level: move, toggle a bool, open a sub-list or an editor, save or quit. */
function topKey(state: State, key: Key): void {
  const def = currentDef(state);
  if (key === "up") state.index = (state.index + OPTIONS.length - 1) % OPTIONS.length;
  else if (key === "down") state.index = (state.index + 1) % OPTIONS.length;
  else if (key === "space") {
    // A bool flips and a single choice steps to its next one; a list or choices row ignores space.
    if (def.kind === "one") {
      const choices = def.choices!;
      state.draft[def.key] = choices[(choices.indexOf(state.draft[def.key] as string) + 1) % choices.length];
    } else toggleBool(state.draft, def);
  } else if (key === "enter" && def.kind !== "bool") {
    state.mode = def.kind; // enter opens the sub-list or the editor; a bool has nothing to open
    // A single choice opens with the cursor on what is chosen; the others at their first row.
    state.sub = def.kind === "one" ? Math.max(0, def.choices!.indexOf(state.draft[def.key] as string)) : 0;
  } else if (isText(key, "s")) finish(state, state.draft);
  else if (isText(key, "q") || key === "escape") finish(state, null);
  // enter on a bool, other letters and tab: nothing
}

/** A choices sub-list: move, toggle one choice, return to the top level. */
function choicesKey(state: State, key: Key): void {
  const def = currentDef(state);
  const choices = def.choices!;
  if (key === "up") state.sub = (state.sub + choices.length - 1) % choices.length;
  else if (key === "down") state.sub = (state.sub + 1) % choices.length;
  else if (key === "space") toggleChoice(state.draft, def, choices[state.sub]);
  else if (key === "enter" || key === "escape") state.mode = "top";
}

/** A single-choice sub-list: move, choose the row under the cursor (enter also returns), or return unchanged. */
function oneKey(state: State, key: Key): void {
  const def = currentDef(state);
  const choices = def.choices!;
  if (key === "up") state.sub = (state.sub + choices.length - 1) % choices.length;
  else if (key === "down") state.sub = (state.sub + 1) % choices.length;
  else if (key === "space" || key === "enter") {
    state.draft[def.key] = choices[state.sub];
    if (key === "enter") state.mode = "top";
  } else if (key === "escape") state.mode = "top";
}

/** The list editor: move, add through the text prompt, delete, return to the top level. */
function listKey(state: State, key: Key): void {
  const list = entries(state);
  if (key === "up") state.sub = Math.max(0, state.sub - 1);
  else if (key === "down") state.sub = list.length ? Math.min(list.length - 1, state.sub + 1) : 0;
  else if (isText(key, "a")) {
    state.mode = "prompt";
    state.prompt = "";
  } else if (isText(key, "d") || key === "backspace") {
    if (list.length) list.splice(state.sub, 1);
    clampSub(state);
  } else if (key === "escape") state.mode = "top";
  // enter has no meaning here: in the editor only escape returns (plans/W1.md § 8)
}

/** The text prompt: every letter is text, enter accepts the entry, escape cancels. */
function promptKey(state: State, key: Key): void {
  if (key === "space") state.prompt += " ";
  else if (typeof key === "object") state.prompt += key.text;
  else if (key === "backspace") state.prompt = [...state.prompt].slice(0, -1).join("");
  else if (key === "enter") {
    const entry = state.prompt.trim(); // `ktx config set` trims each entry too
    if (entry) entries(state).push(entry); // entries must be non-empty (checkValue)
    state.prompt = "";
    state.mode = "list";
    clampSub(state);
  } else if (key === "escape") {
    state.prompt = "";
    state.mode = "list";
  }
}

const clampSub = (state: State) => (state.sub = entries(state).length ? Math.min(state.sub, entries(state).length - 1) : 0);

const isText = (key: Key, text: string) => typeof key === "object" && key.text === text;

/** Space toggles a bool row; every other kind ignores it (plans/W1.md § 8). */
function toggleBool(draft: Options, def: OptionDef): void {
  if (def.kind === "bool") draft[def.key] = !draft[def.key];
}

/**
 * Toggle one choice, keeping the stored list in registry order; the list may end up empty
 * (D-W5-3: every install is opt-in).
 */
function toggleChoice(draft: Options, def: OptionDef, choice: string): void {
  const chosen = new Set(draft[def.key] as string[]);
  if (chosen.has(choice)) chosen.delete(choice);
  else chosen.add(choice);
  draft[def.key] = def.choices!.filter((c) => chosen.has(c));
}

// Arrow keys are the only CSI/SS3 sequences the menu uses; any other final byte is consumed and dropped.
const ARROWS: Record<string, Key> = { A: "up", B: "down", C: "right", D: "left" };
/** Single bytes that are keys; any other control byte (below 0x20) is dropped. */
const BYTE_KEYS: Record<number, Key> = {
  0x0d: "enter", 0x0a: "enter", 0x7f: "backspace", 0x08: "backspace", 0x03: "ctrl-c", 0x09: "tab", 0x20: "space",
};

/**
 * Decode one chunk of raw terminal bytes into keys (escape sequences for arrows, control bytes, UTF-8 text).
 * Stateless: a terminal writes each escape sequence in one chunk, so a sequence split across chunks is not rejoined.
 */
export function decodeKeys(chunk: Uint8Array): Key[] {
  const keys: Key[] = [];
  const pending: number[] = [];
  const flush = () => {
    if (!pending.length) return;
    for (const ch of new TextDecoder().decode(new Uint8Array(pending))) keys.push({ text: ch });
    pending.length = 0;
  };

  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i];
    if (b === 0x1b) {
      const lead = chunk[i + 1];
      if (lead !== 0x5b && lead !== 0x4f) {
        flush(); // ESC, or ESC followed by a byte that starts no sequence
        keys.push("escape");
        continue;
      }
      // CSI ("\x1b[") or SS3 ("\x1bO"): skip the parameters, then read the final byte.
      let end = i + 2;
      while (end < chunk.length && (chunk[end] < 0x40 || chunk[end] > 0x7e)) end++;
      if (end >= chunk.length) break; // the sequence is split across chunks: drop it rather than guess
      const arrow = ARROWS[String.fromCharCode(chunk[end])];
      if (arrow) {
        flush();
        keys.push(arrow);
      }
      i = end;
    } else if (BYTE_KEYS[b] !== undefined) {
      flush();
      keys.push(BYTE_KEYS[b]);
    } else if (b < 0x20) {
      flush(); // any other control byte: no key
    } else {
      pending.push(b); // UTF-8 text; decoded as code points at the next boundary
    }
  }
  flush();
  return keys;
}

/** How many bytes the UTF-8 character a lead byte starts takes; 0 for ASCII and for bytes that start nothing. */
function utf8Width(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * Where the UTF-8 character the end of `chunk` is still waiting for starts, or chunk.length when the
 * chunk ends on a character boundary. Only a valid lead byte followed by too few continuation bytes
 * counts, so at most three bytes are held back.
 */
function partialTail(chunk: Uint8Array): number {
  let start = chunk.length; // walk back over the trailing continuation bytes to the lead byte
  while (start > 0 && chunk[start - 1] >= 0x80 && chunk[start - 1] <= 0xbf) start--;
  if (start === 0) return chunk.length; // nothing but continuation bytes: the lead byte is gone
  const lead = start - 1;
  return chunk.length - lead < utf8Width(chunk[lead]) ? lead : chunk.length;
}

/** carry ++ chunk, without copying when nothing is carried. */
function join(carry: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (!carry.length) return chunk;
  const joined = new Uint8Array(carry.length + chunk.length);
  joined.set(carry);
  joined.set(chunk, carry.length);
  return joined;
}

/**
 * The real terminal: stdin in raw mode, the cursor hidden, and both restored by close().
 * The key stream also restores them when it ends or throws, so a failed menu never leaves the
 * terminal in raw mode. An escape sequence split across reads is not rejoined (see decodeKeys),
 * but the bytes of a UTF-8 character split across reads are carried into the next chunk, so a
 * multi-byte character is never typed as replacement characters.
 */
export function terminalIO(): MenuIO & { close: () => void } {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stdout.write(SHOW_CURSOR);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
  };

  stdin.setRawMode(true);
  stdin.resume();
  try {
    stdout.write(HIDE_CURSOR);
  } catch (err) {
    close();
    throw err;
  }

  let carry = new Uint8Array(0); // an unfinished UTF-8 character left over from the last read
  const keys = (async function* () {
    try {
      for await (const chunk of stdin) {
        const bytes = join(carry, chunk as Uint8Array);
        const tail = partialTail(bytes);
        carry = bytes.slice(tail);
        for (const key of decodeKeys(bytes.subarray(0, tail))) yield key;
      }
    } finally {
      close();
    }
  })();

  return { keys, write: (s) => stdout.write(s), rows: () => stdout.rows, cols: () => stdout.columns, close };
}
