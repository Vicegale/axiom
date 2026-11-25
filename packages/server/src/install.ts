import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 4477;
export const LAUNCHD_LABEL = "local.axiom.server";

export type ServicePlatform = "linux" | "darwin";

export interface InstallOptions {
  /** Home directory the service file goes under (default: $HOME). */
  home?: string;
  dryRun?: boolean;
  port?: number;
  dbPath?: string;
  nodePath?: string;
  /** Absolute path of the built server entry (default: this package's dist/cli.js). */
  entry?: string;
  /** systemd (linux) or launchd (darwin); default: the platform this runs on. */
  platform?: ServicePlatform;
  /**
   * PATH for the service (default: this process's PATH). Services start with a minimal
   * PATH, and the server runs `claude` and `t3`, so it keeps the one the owner installed with.
   */
  pathEnv?: string;
}

export interface InstallResult {
  /** The file's contents (a systemd unit or a launchd plist). */
  unit: string;
  path: string;
  written: boolean;
  commands: string[];
  platform: ServicePlatform;
}

interface Spec {
  nodePath: string;
  entry: string;
  port: number;
  dbPath?: string;
  pathEnv?: string;
}

const args = (o: Spec) => [o.nodePath, o.entry, ...(o.dbPath ? ["--db", o.dbPath] : [])];

export function renderUnit(o: Spec) {
  const exec = args(o)
    .map((p) => (/\s/.test(p) ? JSON.stringify(p) : p))
    .join(" ");
  const path = o.pathEnv ? `Environment=${JSON.stringify(`PATH=${o.pathEnv}`)}\n` : "";
  return `[Unit]
Description=Axiom tracker (local server)

[Service]
ExecStart=${exec}
Restart=on-failure
Environment=AXIOM_PORT=${o.port}
${path}
[Install]
WantedBy=default.target
`;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPlist(o: Spec & { logPath: string }) {
  const program = args(o)
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  const env = [
    `    <key>AXIOM_PORT</key>\n    <string>${o.port}</string>`,
    ...(o.pathEnv ? [`    <key>PATH</key>\n    <string>${xml(o.pathEnv)}</string>`] : []),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Writes the user service for the server: `~/.config/systemd/user/axiom.service` on Linux,
 * `~/Library/LaunchAgents/local.axiom.server.plist` on macOS. Never enables or starts it:
 * it returns the commands for the owner to run.
 */
export function installService(options: InstallOptions = {}): InstallResult {
  const home = options.home ?? process.env.HOME ?? homedir();
  const platform: ServicePlatform =
    options.platform ?? (process.platform === "darwin" ? "darwin" : "linux");
  const spec: Spec = {
    nodePath: options.nodePath ?? process.execPath,
    entry: options.entry ?? fileURLToPath(new URL("./cli.js", import.meta.url)),
    port: options.port ?? DEFAULT_PORT,
    dbPath: options.dbPath,
    pathEnv: options.pathEnv ?? process.env.PATH,
  };

  let path: string;
  let unit: string;
  let commands: string[];
  const dirs: string[] = [];
  if (platform === "darwin") {
    path = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const logPath = join(home, "Library", "Logs", "axiom", "server.log");
    dirs.push(dirname(logPath));
    unit = renderPlist({ ...spec, logPath });
    commands = [
      `launchctl bootstrap gui/$(id -u) ${path}`,
      `# stop and remove: launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`,
      `# logs: ${logPath}`,
    ];
  } else {
    path = join(home, ".config", "systemd", "user", "axiom.service");
    unit = renderUnit(spec);
    commands = [
      "systemctl --user daemon-reload",
      "systemctl --user enable --now axiom.service",
      "# logs: journalctl --user -u axiom.service",
    ];
  }
  if (!options.dryRun) {
    for (const d of [dirname(path), ...dirs]) mkdirSync(d, { recursive: true });
    writeFileSync(path, unit);
  }
  return { unit, path, written: !options.dryRun, commands, platform };
}
