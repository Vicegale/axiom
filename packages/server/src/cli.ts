#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2), { stdout: (t) => process.stdout.write(t) }).catch((e) => {
  process.stderr.write(`axiom-server: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
