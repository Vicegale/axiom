#!/usr/bin/env node
import { serverArgs } from "./server-command.js";
import { updateArgs } from "./update.js";

const argv = process.argv.slice(2);
const forServer = serverArgs(argv);
const forUpdate = updateArgs(argv);
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--db") i++;
  else if (argv[i] !== "--json") rest.push(argv[i] as string);
}
if (rest[0] === "hook") {
  // Hooks run before every tool call: load only what they need, not the whole command tree.
  const at = argv.indexOf("--db");
  const db = at >= 0 ? argv[at + 1] : undefined;
  if (rest[1] === "permission") {
    // Waits for the owner's decision on the Desk card (or a timeout); see permission.ts.
    const { runPermissionHook } = await import("./permission.js");
    process.exitCode = await runPermissionHook(process.env, { db });
  } else {
    const { runHook } = await import("./hook.js");
    process.exitCode = runHook(rest[1] ?? "", process.env, { db });
  }
} else if (forUpdate) {
  const { runUpdate } = await import("./update.js");
  process.exitCode = runUpdate(forUpdate, {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
  });
} else if (forServer) {
  const { runServerCli } = await import("@axiom/server");
  runServerCli(forServer, { stdout: (t) => process.stdout.write(t) }).catch((e: unknown) => {
    process.stderr.write(`axiom: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
} else {
  const { main } = await import("./program.js");
  process.exitCode = main(argv);
}
