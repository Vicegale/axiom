#!/usr/bin/env node
import { serverArgs } from "./server-command.js";

const argv = process.argv.slice(2);
const forServer = serverArgs(argv);
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--db") i++;
  else if (argv[i] !== "--json") rest.push(argv[i] as string);
}
if (rest[0] === "hook") {
  // Hooks run before every tool call: load only what they need, not the whole command tree.
  const { runHook } = await import("./hook.js");
  const at = argv.indexOf("--db");
  process.exitCode = runHook(rest[1] ?? "", process.env, { db: at >= 0 ? argv[at + 1] : undefined });
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
