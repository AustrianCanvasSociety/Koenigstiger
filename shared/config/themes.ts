// The colour themes `ktx config` is drawn in. Each is five roles, written as terminal
// codes over the 256 standard colours (the number in each call is the colour's index),
// so a theme looks the same in every terminal that has them. The owner picked these
// four from the samples of 2026-10-01 (.claude/decisions/) and made Dunkelgelb the default.

/**
 * How the panel is drawn, after OpenCode's command palette: a bold title with a dim
 * `esc` at the right edge, group headings in colour, values dim at the right edge, the
 * selected row as one full-width bar, and the banner in its own colour.
 */
export type Style = { title: string; group: string; dim: string; selected: string; banner: string };

const BOLD = "\x1b[1m";
const fg = (index: number) => `\x1b[38;5;${index}m`;
const heading = (index: number) => `\x1b[1;38;5;${index}m`;
/** The selected row: bold text in colour `text` on a bar of colour `ground`. */
const bar = (ground: number, text: number) => `\x1b[1;38;5;${text};48;5;${ground}m`;

/** A theme's name as the `theme` option stores it, and the name the menu shows. */
export const THEMES: Record<string, Style & { label: string }> = {
  // Dark yellow and olive green, after late-war German armour paint.
  dunkelgelb: { label: "Dunkelgelb", title: BOLD, group: heading(107), dim: fg(101), selected: bar(179, 16), banner: fg(179) },
  // Deep orange: a burnt orange bar, brighter orange headings.
  tieforange: { label: "Tieforange", title: BOLD, group: heading(208), dim: fg(243), selected: bar(166, 16), banner: fg(166) },
  // Red on black: a dark red bar with white text, red headings and banner.
  "rot-schwarz": { label: "Rot auf Schwarz", title: BOLD, group: heading(160), dim: fg(240), selected: bar(124, 231), banner: fg(160) },
  // Red bar, orange headings, an ember-orange banner.
  glut: { label: "Glut", title: BOLD, group: heading(208), dim: fg(243), selected: bar(160, 231), banner: fg(202) },
};

export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = "dunkelgelb";

/** NO_COLOR's drawing: no colour at all, the selected row in reverse video. */
export const PLAIN: Style = { title: BOLD, group: BOLD, dim: "", selected: "\x1b[7m", banner: "" };

/** The style for a `theme` option's value; anything that is not a theme's name draws as the default. */
export function themeStyle(name: unknown): Style {
  return typeof name === "string" && Object.hasOwn(THEMES, name) ? THEMES[name] : THEMES[DEFAULT_THEME];
}
