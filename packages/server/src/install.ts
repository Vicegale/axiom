import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 4477;

export interface InstallOptions {
  /** Home directory the unit goes under (default: $HOME). */
  home?: string;
  dryRun?: boolean;
  port?: number;
  dbPath?: string;
  nodePath?: string;
  /** Absolute path of the built server entry (default: this package's dist/cli.js). */
  entry?: string;
}

export interface InstallResult {
  unit: string;
  path: string;
  written: boolean;
  commands: string[];
}

export function renderUnit(o: { nodePath: string; entry: string; port: number; dbPath?: string }) {
  const exec = [o.nodePath, o.entry, ...(o.dbPath ? ["--db", o.dbPath] : [])]
    .map((p) => (/\s/.test(p) ? JSON.stringify(p) : p))
    .join(" ");
  return `[Unit]
Description=Axiom tracker (local server)

[Service]
ExecStart=${exec}
Restart=on-failure
Environment=AXIOM_PORT=${o.port}

[Install]
WantedBy=default.target
`;
}

/** Writes `~/.config/systemd/user/axiom.service`. Never runs systemctl. */
export function installService(options: InstallOptions = {}): InstallResult {
  const home = options.home ?? process.env.HOME ?? homedir();
  const path = join(home, ".config", "systemd", "user", "axiom.service");
  const entry = options.entry ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  const unit = renderUnit({
    nodePath: options.nodePath ?? process.execPath,
    entry,
    port: options.port ?? DEFAULT_PORT,
    dbPath: options.dbPath,
  });
  if (!options.dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit);
  }
  return {
    unit,
    path,
    written: !options.dryRun,
    commands: ["systemctl --user daemon-reload", "systemctl --user enable --now axiom.service"],
  };
}
