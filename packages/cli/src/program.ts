import {
  AXIOM_VERSION,
  AxiomError,
  type EntryKind,
  LINK_KINDS,
  PROVIDERS,
  type Ref,
  type RefType,
  TOPIC_STATUSES,
  type TopicStatus,
  type View,
  WORK_ITEM_STATUSES,
  type WorkItemStatus,
} from "@axiom/core";
import { Argument, Command, CommanderError, Option } from "commander";
import { Context, currentThreadId, UsageError } from "./context.js";
import { entryText, table, topicTable, topicText, when } from "./format.js";

/** What a handler returns: text for people, data for `--json`. */
interface Output {
  text: string;
  data: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: commander options are untyped
type Opts = Record<string, any>;
type Handler = (ctx: Context, args: string[], opts: Opts) => Output;

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** CLI words for entry kinds that differ from the core kind. */
const ENTRY_KIND_WORDS: Record<string, EntryKind> = {
  note: "note",
  decision: "decision",
  finding: "finding",
  verification: "verification",
  "next-steps": "next steps",
  "owner-input": "owner input",
  authorization: "authorization",
};

const VIEW_CHOICES = ["attention", "ongoing", "monitoring"] as const;

function parseRef(text: string): Ref {
  const i = text.indexOf(":");
  if (i <= 0) throw new UsageError(`invalid --ref "${text}" (expected <type>:<value>)`);
  return { type: text.slice(0, i) as RefType, value: text.slice(i + 1) };
}

function parseId(text: string, what: string): number {
  if (!/^\d+$/.test(text)) throw new UsageError(`${what} must be a number, got "${text}"`);
  return Number(text);
}

export function buildProgram(env: NodeJS.ProcessEnv, write: (s: string) => void): Command {
  const program = new Command("axiom");
  program
    .description("Axiom: track what agents are working on")
    .version(AXIOM_VERSION, "-v, --version")
    .option("--db <path>", "database path (default: $AXIOM_DB or the XDG data directory)")
    .option("--json", "print machine-readable JSON")
    .showHelpAfterError()
    .exitOverride();

  /** Wraps a handler: opens the context, runs it, prints the output. */
  const run =
    (handler: Handler) =>
    (...received: unknown[]) => {
      const cmd = received[received.length - 1] as Command;
      const opts = cmd.optsWithGlobals() as Opts;
      // Optional arguments that were omitted arrive as undefined.
      const given = received.slice(0, cmd.registeredArguments.length) as (string | undefined)[];
      const ctx = new Context(env, { db: opts.db, json: opts.json });
      try {
        const out = handler(ctx, given as unknown as string[], opts);
        write(ctx.json ? JSON.stringify(out.data, null, 2) : out.text);
      } finally {
        ctx.close();
      }
    };

  const sub = (parent: Command, name: string, description: string) =>
    parent.command(name).description(description).showHelpAfterError().exitOverride();

  // ---- topic ----------------------------------------------------------------
  const topic = sub(program, "topic", "create, show and update topics");

  sub(topic, "new", "create a topic")
    .argument("<slug>", "lowercase kebab-case name")
    .requiredOption("--title <title>", "title")
    .option("--goal <goal>", "what done means")
    .option("--note <note>", "status note")
    .option("--epic <slug>", "parent epic (repeatable)", collect, [])
    .option("--ticket <slug>", "parent ticket (repeatable)", collect, [])
    .action(
      run((ctx, [slug], o) => {
        const { axiom, actor } = ctx;
        const created = axiom.createTopic(
          { slug: slug as string, title: o.title, goal: o.goal, statusNote: o.note },
          actor,
        );
        for (const t of o.ticket) axiom.addTopicToTicket(created.id, t, actor);
        for (const e of o.epic) axiom.addTopicToEpic(created.id, e, actor);
        return { data: axiom.getTopic(created.id), text: `Created topic ${created.slug}.` };
      }),
    );

  sub(topic, "show", "show a topic")
    .argument("[topic]", "topic slug (default: the current thread's topic)")
    .action(
      run((ctx, [slug]) => {
        const ref = ctx.topic(slug);
        const detail = ctx.axiom.getTopic(ref);
        const history = ctx.axiom.listEntries(detail.id).slice(-10);
        const monitorTargets = detail.monitorTargets.map((m) => ({
          ...m,
          target: detail.links.find((l) => l.id === m.linkId)?.target ?? null,
        }));
        return {
          data: { ...detail, monitorTargets, history },
          text: topicText(detail, monitorTargets, history),
        };
      }),
    );

  sub(topic, "list", "list topics")
    .addOption(new Option("--view <view>", "only one view").choices(VIEW_CHOICES))
    .addOption(new Option("--status <status>", "only one status").choices(TOPIC_STATUSES))
    .option("--all", "include done and stale topics")
    .action(
      run((ctx, _a, o) => {
        let topics = ctx.axiom.listTopics({
          view: o.view as View | undefined,
          status: o.status as TopicStatus | undefined,
        });
        if (!o.all && !o.status) {
          topics = topics.filter((t) => t.status !== "done" && t.status !== "stale");
        }
        return { data: topics, text: topicTable(topics) };
      }),
    );

  sub(topic, "status", "set a topic's status")
    .addArgument(new Argument("<status>").choices(TOPIC_STATUSES))
    .argument("[topic]", "topic slug (default: current)")
    .option("--reason <reason>", "why")
    .action(
      run((ctx, [status, slug], o) => {
        const t = ctx.axiom.setTopicStatus(
          ctx.topic(slug),
          status as TopicStatus,
          ctx.actor,
          o.reason,
        );
        return { data: t, text: `${t.slug} is now ${t.status ?? "(none)"}.` };
      }),
    );

  sub(topic, "note", "set a topic's status note")
    .argument("<text>")
    .argument("[topic]", "topic slug (default: current)")
    .action(
      run((ctx, [text, slug]) => {
        const t = ctx.axiom.updateTopic(ctx.topic(slug), { statusNote: text }, ctx.actor);
        return { data: t, text: `Updated the status note of ${t.slug}.` };
      }),
    );

  sub(topic, "goal", "set a topic's goal")
    .argument("<text>")
    .argument("[topic]", "topic slug (default: current)")
    .action(
      run((ctx, [text, slug]) => {
        const t = ctx.axiom.updateTopic(ctx.topic(slug), { goal: text }, ctx.actor);
        return { data: t, text: `Updated the goal of ${t.slug}.` };
      }),
    );

  const parent = sub(topic, "parent", "add or remove a topic's ticket or epic parent");
  for (const verb of ["add", "remove"] as const) {
    sub(parent, verb, `${verb} a parent`)
      .argument("[topic]", "topic slug (default: current)")
      .option("--ticket <slug>", "ticket")
      .option("--epic <slug>", "epic")
      .action(
        run((ctx, [slug], o) => {
          if (Boolean(o.ticket) === Boolean(o.epic)) {
            throw new UsageError("give exactly one of --ticket or --epic");
          }
          const { axiom, actor } = ctx;
          const ref = ctx.topic(slug);
          const kind = o.ticket ? "ticket" : "epic";
          const target = o.ticket ?? o.epic;
          if (kind === "ticket") {
            (verb === "add" ? axiom.addTopicToTicket : axiom.removeTopicFromTicket).call(
              axiom,
              ref,
              target,
              actor,
            );
          } else {
            (verb === "add" ? axiom.addTopicToEpic : axiom.removeTopicFromEpic).call(
              axiom,
              ref,
              target,
              actor,
            );
          }
          const detail = axiom.getTopic(ref);
          return {
            data: detail,
            text: `${verb === "add" ? "Added" : "Removed"} ${kind} ${target} ${verb === "add" ? "to" : "from"} ${detail.slug}.`,
          };
        }),
      );
  }

  // ---- ticket and epic ----------------------------------------------------------
  for (const kind of ["ticket", "epic"] as const) {
    const group = sub(program, kind, `create and list ${kind}s`);
    const api = (ctx: Context) => ({
      create: (input: Parameters<typeof ctx.axiom.createTicket>[0]) =>
        kind === "ticket"
          ? ctx.axiom.createTicket(input, ctx.actor)
          : ctx.axiom.createEpic(input, ctx.actor),
      setStatus: (slug: string, s: WorkItemStatus) =>
        kind === "ticket"
          ? ctx.axiom.setTicketStatus(slug, s, ctx.actor)
          : ctx.axiom.setEpicStatus(slug, s, ctx.actor),
      list: () => (kind === "ticket" ? ctx.axiom.listTickets() : ctx.axiom.listEpics()),
    });

    const create = sub(group, "new", `create a ${kind}`)
      .argument("<slug>")
      .requiredOption("--title <title>", "title")
      .option("--jira-key <key>", "Jira key (status becomes Jira's and locked)")
      .option("--jira-url <url>", "Jira URL");
    if (kind === "ticket") create.option("--epic <slug>", "parent epic (repeatable)", collect, []);
    create.action(
      run((ctx, [slug], o) => {
        if (Boolean(o.jiraKey) !== Boolean(o.jiraUrl)) {
          throw new UsageError("--jira-key and --jira-url go together");
        }
        const item = api(ctx).create({
          slug: slug as string,
          title: o.title,
          jira: o.jiraKey ? { key: o.jiraKey, url: o.jiraUrl } : undefined,
        });
        for (const e of (o.epic as string[] | undefined) ?? []) {
          ctx.axiom.addTicketToEpic(item.id, e, ctx.actor);
        }
        return { data: item, text: `Created ${kind} ${item.slug}.` };
      }),
    );

    sub(group, "status", `set a ${kind}'s status (not allowed when linked to Jira)`)
      .argument("<slug>")
      .addArgument(new Argument("<status>").choices(WORK_ITEM_STATUSES))
      .action(
        run((ctx, [slug, status]) => {
          const item = api(ctx).setStatus(slug as string, status as WorkItemStatus);
          return { data: item, text: `${item.slug} is now ${item.status}.` };
        }),
      );

    sub(group, "list", `list ${kind}s`).action(
      run((ctx) => {
        const items = api(ctx).list();
        return {
          data: items,
          text: items.length
            ? table(
                items.map((i) => [
                  i.slug,
                  i.jiraKey && i.jiraStatus ? i.jiraStatus : i.status,
                  i.jiraKey ?? "",
                  i.title,
                ]),
              )
            : `No ${kind}s.`,
        };
      }),
    );
  }

  // ---- entries --------------------------------------------------------------------
  sub(program, "entry", "write a history entry")
    .argument("<kind>", Object.keys(ENTRY_KIND_WORDS).join(" | "))
    .argument("<body>")
    .option("--topic <topic>", "topic slug (default: current)")
    .option("--why <why>", "decision: the reason")
    .addOption(
      new Option("--result <result>", "verification: result").choices(["pass", "fail", "partial"]),
    )
    .option("--evidence <text>", "verification: evidence (repeatable)", collect, [])
    .option("--scope <scope>", "authorization: what is allowed")
    .option("--standing", "authorization: lasts beyond this task")
    .option("--ref <type:value>", "reference (repeatable)", collect, [])
    .option("--corrects <entryId>", "entry this one corrects")
    .action(
      run((ctx, [word, body], o) => {
        const kind = ENTRY_KIND_WORDS[word as string];
        if (!kind) {
          throw new UsageError(
            `unknown entry kind "${word}" (use ${Object.keys(ENTRY_KIND_WORDS).join(", ")})`,
          );
        }
        let data: Record<string, unknown> | undefined;
        if (o.why !== undefined) data = { ...data, why: o.why };
        if (o.result !== undefined || o.evidence.length) {
          data = {
            ...data,
            result: o.result,
            ...(o.evidence.length ? { evidence: o.evidence } : {}),
          };
        }
        if (o.scope !== undefined || o.standing) {
          data = { ...data, scope: o.scope, standing: o.standing === true };
        }
        const entry = ctx.axiom.addEntry(
          ctx.topic(o.topic),
          {
            kind,
            body: body as string,
            data,
            refs: o.ref.map(parseRef),
            correctsEntryId:
              o.corrects === undefined ? undefined : parseId(o.corrects, "--corrects"),
          },
          ctx.actor,
        );
        return { data: entry, text: `Wrote ${entry.kind} entry #${entry.id}.` };
      }),
    );

  sub(program, "entries", "list a topic's history")
    .argument("[topic]", "topic slug (default: current)")
    .option("--limit <n>", "only the last N entries")
    .option("--kind <kind>", "only this kind")
    .action(
      run((ctx, [slug], o) => {
        let kind: EntryKind | undefined;
        if (o.kind !== undefined) {
          kind = ENTRY_KIND_WORDS[o.kind] ?? (o.kind.replaceAll("-", " ") as EntryKind);
        }
        let entries = ctx.axiom.listEntries(ctx.topic(slug));
        if (kind) entries = entries.filter((e) => e.kind === kind);
        if (o.limit !== undefined) entries = entries.slice(-parseId(o.limit, "--limit"));
        return {
          data: entries,
          text: entries.length ? entries.map(entryText).join("\n") : "No entries.",
        };
      }),
    );

  // ---- links and monitor targets ----------------------------------------------------
  sub(sub(program, "link", "links on a topic"), "add", "add a link")
    .addArgument(new Argument("<kind>").choices(LINK_KINDS))
    .argument("<target>", "URL, path or name")
    .option("--label <label>", "label")
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [kind, target], o) => {
        const link = ctx.axiom.addLink(
          ctx.topic(o.topic),
          { kind: kind as never, target: target as string, label: o.label },
          ctx.actor,
        );
        return { data: link, text: `Added ${link.kind} link #${link.id}.` };
      }),
    );

  const monitor = sub(program, "monitor", "monitor targets");
  sub(monitor, "add", "add a monitor target (creates the link if the topic lacks it)")
    .addArgument(new Argument("<kind>").choices(LINK_KINDS))
    .argument("<target>", "what to watch, such as a PR URL")
    .option("--topic <topic>", "topic slug (default: current)")
    .option("--confirmed", "confirm now instead of leaving it suggested")
    .action(
      run((ctx, [kind, target], o) => {
        const { axiom, actor } = ctx;
        const ref = ctx.topic(o.topic);
        const detail = axiom.getTopic(ref);
        const link =
          detail.links.find((l) => l.kind === kind && l.target === target) ??
          axiom.addLink(detail.id, { kind: kind as never, target: target as string }, actor);
        const m = axiom.addMonitorTarget(
          detail.id,
          { kind: kind as string, linkId: link.id, state: o.confirmed ? "confirmed" : "suggested" },
          actor,
        );
        return { data: m, text: `Added ${m.state} monitor target #${m.id} (${kind} ${target}).` };
      }),
    );
  sub(monitor, "confirm", "confirm a suggested monitor target")
    .argument("<id>")
    .action(
      run((ctx, [id]) => {
        const m = ctx.axiom.confirmMonitorTarget(parseId(id as string, "id"), ctx.actor);
        return { data: m, text: `Confirmed monitor target #${m.id}.` };
      }),
    );

  // ---- threads --------------------------------------------------------------------------
  const thread = sub(program, "thread", "threads attached to topics");
  sub(thread, "attach", "attach a thread to a topic (default: the current thread)")
    .argument("<topic>")
    .addOption(new Option("--provider <provider>").choices(PROVIDERS))
    .option("--id <providerThreadId>", "the provider's thread id")
    .option("--env <environmentId>", "T3 environment id")
    .option("--title <title>", "title")
    .action(
      run((ctx, [slug], o) => {
        if (Boolean(o.provider) !== Boolean(o.id)) {
          throw new UsageError("--provider and --id go together");
        }
        const found = o.provider
          ? { provider: o.provider, providerThreadId: o.id }
          : currentThreadId(env);
        if (!found) {
          throw new UsageError(
            "no thread to attach: pass --provider and --id, or run inside a session (T3CODE_THREAD_ID or CLAUDE_CODE_SESSION_ID)",
          );
        }
        const t = ctx.axiom.attachThread(
          slug as string,
          { ...found, environmentId: o.env, title: o.title },
          ctx.actor,
        );
        return {
          data: t,
          text: `Attached ${t.provider} thread ${t.providerThreadId} to ${slug} (thread #${t.id}).`,
        };
      }),
    );
  sub(thread, "show", "show the current thread and its topic").action(
    run((ctx) => {
      const id = currentThreadId(env);
      if (!id) {
        throw new UsageError(
          "not inside a session (T3CODE_THREAD_ID or CLAUDE_CODE_SESSION_ID is not set)",
        );
      }
      const t = ctx.currentThread();
      if (!t) {
        return {
          data: { ...id, attached: false },
          text: `Current thread ${id.provider}:${id.providerThreadId} is not attached to a topic.`,
        };
      }
      const topic = ctx.axiom.getTopic(t.topicId);
      return {
        data: { attached: true, thread: t, topic },
        text: [
          `thread:  #${t.id} ${t.provider}:${t.providerThreadId}  ${t.status}  ${t.endedAt ? "ended" : "open"}`,
          `topic:   ${topic.slug}: ${topic.title}`,
          `status:  ${topic.status ?? "(none)"}   started: ${when(t.startedAt)}`,
        ].join("\n"),
      };
    }),
  );

  return program;
}

/** Runs the CLI; returns the exit code. */
export function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  },
): number {
  const program = buildProgram(env, io.out);
  const configure = (c: Command) => {
    c.configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, "")),
      writeErr: (s) => io.err(s.replace(/\n$/, "")),
    });
    c.commands.forEach(configure);
  };
  configure(program);
  const json = argv.includes("--json");
  const fail = (code: string, message: string, exit: number): number => {
    io.err(json ? JSON.stringify({ error: { code, message } }) : `axiom: ${message}`);
    return exit;
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") i++;
    else if (argv[i] !== "--json") rest.push(argv[i] as string);
  }
  if (rest.length === 0) {
    io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }
  try {
    program.parse(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return 0;
      // commander already printed its message
      return 2;
    }
    if (err instanceof UsageError) return fail("usage", err.message, 2);
    if (err instanceof AxiomError) return fail(err.code, err.message, 1);
    return fail("error", err instanceof Error ? err.message : String(err), 1);
  }
}
