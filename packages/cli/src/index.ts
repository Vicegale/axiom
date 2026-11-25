#!/usr/bin/env node
import { main } from "./program.js";
import { serverArgs } from "./server-command.js";

const argv = process.argv.slice(2);
const forServer = serverArgs(argv);
if (forServer) {
  const { runServerCli } = await import("@axiom/server");
  runServerCli(forServer, { stdout: (t) => process.stdout.write(t) }).catch((e: unknown) => {
    process.stderr.write(`axiom: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
} else {
  process.exitCode = main(argv);
}
