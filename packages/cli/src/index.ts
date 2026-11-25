#!/usr/bin/env node
import { main } from "./program.js";

process.exitCode = main(process.argv.slice(2));
