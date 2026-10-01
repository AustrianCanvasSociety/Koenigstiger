#!/usr/bin/env bun
// The config skill's script: ktx's options from inside a harness session.
//   bun config.ts list | get <key> | set <key> <value>
// Exit 0 done, 2 refused (unknown option, bad value, bad arguments), 3 the session
// may not write ktx's config folder (a harness sandbox).
import { configCommand } from "./lib/command";
import { configDir } from "./lib/env";

const args = process.argv.slice(2);
/** One argument as a shell word, for the command the exit-3 message hands the user. */
const word = (arg: string) => (/^[A-Za-z0-9_./,:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

try {
  const lines = configCommand(process.env, args);
  if (lines === null) {
    console.error("usage: config.ts list | get <key> | set <key> <value>");
    process.exit(2);
  }
  console.log(lines.join("\n"));
} catch (err) {
  const { code, message } = err as NodeJS.ErrnoException;
  if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
    console.error(
      `ktx: this session may not write ${configDir(process.env)} (${code}); nothing was saved. ` +
        `Run it in a terminal outside the harness: bun ${[process.argv[1], ...args].map(word).join(" ")}`,
    );
    process.exit(3);
  }
  console.error(`ktx: ${message}`);
  process.exit(2);
}
