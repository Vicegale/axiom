#!/usr/bin/env node
import { AXIOM_VERSION } from "@axiom/core";

const args = process.argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
  console.log(AXIOM_VERSION);
} else {
  console.log("Usage: axiom [--version]");
}
