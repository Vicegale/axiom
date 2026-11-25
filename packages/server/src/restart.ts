import { spawnSync } from "node:child_process";
import { LAUNCHD_LABEL, type ServicePlatform } from "./install.js";

/** Runs a command; returns its exit code (null when it could not run) and output. */
export type Runner = (cmd: string, args: string[]) => { code: number | null; out: string };

export const runCommand: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.error ? null : r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

/** Is an Axiom server answering on this port? */
export async function serverAnswers(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface RestartOptions {
  port: number;
  platform?: ServicePlatform;
  run?: Runner;
  answers?: (port: number) => Promise<boolean>;
  uid?: number;
  /** How long to wait for the restarted server to answer. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RestartResult {
  ok: boolean;
  message: string;
}

/**
 * `axiom server restart`: restarts the user service (systemd on Linux, launchd on macOS) and waits
 * until it answers again. A server started by hand is never killed: the owner stops it.
 */
export async function restartServer(o: RestartOptions): Promise<RestartResult> {
  const platform = o.platform ?? (process.platform === "darwin" ? "darwin" : "linux");
  const run = o.run ?? runCommand;
  const answers = o.answers ?? ((p: number) => serverAnswers(p));
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const url = `http://127.0.0.1:${o.port}`;

  const service =
    platform === "darwin"
      ? run("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]).code === 0
      : run("systemctl", ["--user", "is-enabled", "--quiet", "axiom.service"]).code === 0 ||
        run("systemctl", ["--user", "is-active", "--quiet", "axiom.service"]).code === 0;

  if (!service) {
    if (await answers(o.port)) {
      return {
        ok: false,
        message: `The server at ${url} was started by hand, not as a service: stop it (Ctrl-C in its terminal) and run \`axiom server\` again. To run it as a service, use scripts/install.sh --service.`,
      };
    }
    return {
      ok: false,
      message:
        "No Axiom service is set up and no server is running. Start one with `axiom server`.",
    };
  }

  const r =
    platform === "darwin"
      ? run("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`])
      : run("systemctl", ["--user", "restart", "axiom.service"]);
  if (r.code !== 0) {
    return { ok: false, message: `Restarting the service failed${r.out ? `: ${r.out}` : "."}` };
  }

  const logs =
    platform === "darwin"
      ? "~/Library/Logs/axiom/server.log"
      : "journalctl --user -u axiom.service";
  const waitMs = o.waitMs ?? 10_000;
  for (let waited = 0; waited <= waitMs; waited += 250) {
    if (await answers(o.port)) return { ok: true, message: `Restarted the Axiom service: ${url}` };
    await sleep(250);
  }
  return {
    ok: false,
    message: `The service restarted but nothing answers at ${url} yet. Logs: ${logs}`,
  };
}
