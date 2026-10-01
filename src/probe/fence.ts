// The write fence a probe's writing run is spawned inside: a macOS sandbox-exec
// profile that denies every file write outside the probe's own temp dir. Kimi's
// file, wave and tools legs use it (W3 seam S2) and so do OpenCode's writing runs,
// whose own permission rules do not see a path handed to a shell command
// (plans/W6-invariants.md 34; plans/m4-probe/live/fence-opencode.json).
import { existsSync, realpathSync } from "node:fs";
import { assert } from "../assert";

/**
 * The sandbox-exec profile for a writing run: allow by default, deny every file
 * write, then allow writes only under realpath(tmp) plus exactly /dev/null,
 * /dev/zero, /dev/tty* and /dev/fd. Real paths, because that is what the kernel
 * resolves: on macOS a temp dir under /var is /private/var. `who` names the
 * harness in a refusal.
 */
export function writeFenceProfile(tmp: string, who: string): string {
  assert(existsSync(tmp), `${who} fence: the probe tmp ${tmp} does not exist`);
  const root = realpathSync(tmp);
  // A quote would close the profile's string early and let the rest of the path
  // become profile syntax; no temp path has one, and a fence is never guessed at.
  assert(!root.includes('"'), `${who} fence: the probe tmp ${root} cannot be written into a sandbox profile`);
  return `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "${root}") ` +
    `(literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (subpath "/dev/fd"))`;
}
