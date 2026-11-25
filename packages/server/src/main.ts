import { parseArgs } from "node:util";
import { defaultDatabasePath } from "@axiom/core";
import { startServer } from "./index.js";
import { DEFAULT_PORT, installService } from "./install.js";
import { type RestartOptions, restartServer } from "./restart.js";

export interface MainIo {
  stdout: (text: string) => void;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams for `restart`. */
  restart?: Omit<RestartOptions, "port">;
}

const USAGE = `usage: axiom-server [--port N] [--db PATH]
       axiom-server install [--dry-run] [--port N] [--db PATH] [--platform linux|darwin]
       axiom-server restart [--port N]
`;

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${raw}`);
  return n;
}

/** Returns true when a server was started (the process should then stay alive). */
export async function main(argv: string[], io: MainIo): Promise<boolean> {
  const env = io.env ?? process.env;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      db: { type: "string" },
      "dry-run": { type: "boolean" },
      platform: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.stdout(USAGE);
    return false;
  }
  const port = parsePort(values.port ?? env.AXIOM_PORT, DEFAULT_PORT);

  if (positionals[0] === "install") {
    const platform = values.platform;
    if (platform !== undefined && platform !== "linux" && platform !== "darwin") {
      throw new Error(`invalid platform: ${platform} (linux or darwin)`);
    }
    const result = installService({
      platform,
      home: io.home,
      dryRun: values["dry-run"],
      port,
      dbPath: values.db,
    });
    if (result.written) {
      io.stdout(`Wrote ${result.path}\n\nTo enable it, run:\n`);
    } else {
      io.stdout(`# dry run: would write ${result.path}\n${result.unit}\n# then you would run:\n`);
    }
    for (const c of result.commands) io.stdout(`  ${c}\n`);
    return false;
  }
  if (positionals[0] === "restart") {
    const r = await restartServer({ ...io.restart, port });
    if (!r.ok) throw new Error(r.message);
    io.stdout(`${r.message}\n`);
    return false;
  }
  if (positionals.length > 0) throw new Error(`unknown command: ${positionals[0]}\n${USAGE}`);

  const server = await startServer({ dbPath: values.db ?? defaultDatabasePath(env), port });
  io.stdout(`Axiom server listening on ${server.url}\n`);
  const stop = () => {
    server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return true;
}
