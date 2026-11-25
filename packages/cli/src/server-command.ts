/**
 * `axiom server [start] [--port N]`, `axiom server restart` and `axiom server install [--dry-run] [--port N]` hand off to
 * @axiom/server's own CLI. It is dispatched before commander and imported lazily, so other
 * commands (and the hooks, which must stay fast) never load the server.
 *
 * Returns the arguments for the server CLI, or null when this is not a server command.
 */
export function serverArgs(argv: readonly string[]): string[] | null {
  let db: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--db") db = argv[++i];
    else if (a !== "--json") rest.push(a);
  }
  if (rest[0] !== "server") return null;
  const args = rest.slice(1);
  if (args[0] === "start") args.shift();
  if (db !== undefined && !args.includes("--db")) args.push("--db", db);
  return args;
}
