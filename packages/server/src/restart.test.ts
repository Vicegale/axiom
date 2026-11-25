import { describe, expect, it } from "vitest";
import { main } from "./main.js";
import { type Runner, restartServer } from "./restart.js";

/** A fake runner: answers by command line, records calls. */
function fake(codes: Record<string, number>) {
  const calls: string[] = [];
  const run: Runner = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return { code: codes[line] ?? 1, out: "" };
  };
  return { run, calls };
}
const noSleep = async () => {};

describe("axiom server restart", () => {
  it("restarts the systemd service and waits until it answers", async () => {
    const f = fake({
      "systemctl --user is-enabled --quiet axiom.service": 0,
      "systemctl --user restart axiom.service": 0,
    });
    let asked = 0;
    const r = await restartServer({
      port: 4477,
      platform: "linux",
      run: f.run,
      answers: async () => ++asked >= 3,
      sleep: noSleep,
    });
    expect(r).toEqual({ ok: true, message: "Restarted the Axiom service: http://127.0.0.1:4477" });
    expect(f.calls).toContain("systemctl --user restart axiom.service");
  });

  it("kickstarts the launchd agent on macOS", async () => {
    const f = fake({
      "launchctl print gui/501/local.axiom.server": 0,
      "launchctl kickstart -k gui/501/local.axiom.server": 0,
    });
    const r = await restartServer({
      port: 4477,
      platform: "darwin",
      uid: 501,
      run: f.run,
      answers: async () => true,
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    expect(f.calls).toContain("launchctl kickstart -k gui/501/local.axiom.server");
  });

  it("never touches a server started by hand", async () => {
    const f = fake({});
    const r = await restartServer({
      port: 4477,
      platform: "linux",
      run: f.run,
      answers: async () => true,
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/started by hand/);
    expect(f.calls.some((c) => c.includes("restart"))).toBe(false);
  });

  it("says how to start one when nothing runs", async () => {
    const r = await restartServer({
      port: 4477,
      platform: "linux",
      run: fake({}).run,
      answers: async () => false,
      sleep: noSleep,
    });
    expect(r).toEqual({
      ok: false,
      message:
        "No Axiom service is set up and no server is running. Start one with `axiom server`.",
    });
  });

  it("reports a service that doesn't come back, with where its logs are", async () => {
    const f = fake({
      "systemctl --user is-active --quiet axiom.service": 0,
      "systemctl --user restart axiom.service": 0,
    });
    const r = await restartServer({
      port: 5000,
      platform: "linux",
      run: f.run,
      answers: async () => false,
      sleep: noSleep,
      waitMs: 500,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("journalctl --user -u axiom.service");
  });

  it("is reachable from the server CLI, with the port option", async () => {
    let out = "";
    const f = fake({
      "systemctl --user is-enabled --quiet axiom.service": 0,
      "systemctl --user restart axiom.service": 0,
    });
    const started = await main(["restart", "--port", "4600"], {
      stdout: (t) => (out += t),
      restart: { platform: "linux", run: f.run, answers: async () => true, sleep: noSleep },
    });
    expect(started).toBe(false);
    expect(out).toBe("Restarted the Axiom service: http://127.0.0.1:4600\n");
    await expect(
      main(["restart"], {
        stdout: () => {},
        restart: { platform: "linux", run: fake({}).run, answers: async () => false },
      }),
    ).rejects.toThrow(/Start one with `axiom server`/);
  });
});
