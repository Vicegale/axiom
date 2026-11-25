import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AXIOM_VERSION,
  AxiomError,
  defaultDatabasePath,
  type EntryKind,
  LINK_KINDS,
  PROVIDERS,
  type Ref,
  type RefType,
  TASK_STATUSES,
  type TaskDetail,
  type TaskStatus,
  TOPIC_STATUSES,
  type TopicStatus,
  type View,
  WORK_ITEM_STATUSES,
  type WorkItemStatus,
} from "@axiom/core";
import { Argument, Command, CommanderError, Option } from "commander";
import {
  allowCliIn,
  CLAUDE_ALLOW_RULE,
  codexAllowRoot,
  codexDisallowRoot,
  codexSandboxMode,
  disallowCliFrom,
} from "./agent-access.js";
import { Context, currentThreadId, UsageError } from "./context.js";
import { entryText, table, topicTable, topicText, when } from "./format.js";
import { HOOK_EVENTS, runHook } from "./hook.js";
import {
  installInto,
  readSettings,
  uninstallFrom,
  writeSettings,
  writeTextWithBackup,
} from "./hooks-settings.js";

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

/** Accepts `to do`, `todo` and `to-do` for the first task status. */
function parseTaskStatus(text: string): TaskStatus {
  const word = text.trim().toLowerCase().replace(/[-_]/g, " ");
  const found = TASK_STATUSES.find((s) => s === word || s.replace(" ", "") === word);
  if (!found) {
    throw new UsageError(`invalid task status "${text}" (use ${TASK_STATUSES.join(", ")})`);
  }
  return found;
}

/** Keys of the dependencies that are not done yet. */
function waitsOn(task: TaskDetail, all: readonly TaskDetail[]): string[] {
  return task.dependsOn.filter((k) => all.find((t) => t.key === k)?.status !== "done");
}

function taskText(task: TaskDetail, all: readonly TaskDetail[], spec: string | null): string {
  const waits = waitsOn(task, all);
  return [
    `${task.key}  ${task.title}`,
    `status:      ${task.status}${task.waiting ? " (waiting)" : ""}`,
    `done when:   ${task.doneWhen ?? "-"}`,
    `spec:        ${spec ?? "-"}`,
    `waits on:    ${waits.length ? waits.join(", ") : "-"}`,
    `depends on:  ${task.dependsOn.length ? task.dependsOn.join(", ") : "-"}`,
    `dependents:  ${task.dependents.length ? task.dependents.join(", ") : "-"}`,
  ].join("\n");
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
        const here = ctx.currentThread();
        const current = here ? ctx.axiom.getTopic(here.topicId).slug : undefined;
        return { data: topics, text: topicTable(topics, current) };
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

  // ---- tasks ------------------------------------------------------------------------
  const task = sub(program, "task", "tasks of a topic, with dependencies");

  /** A spec link of the topic: by id, or by path (the link is added when the topic lacks it). */
  const specLinkId = (ctx: Context, topicRef: string | number, spec: string): number => {
    if (/^\d+$/.test(spec)) return Number(spec);
    const detail = ctx.axiom.getTopic(topicRef);
    const found = detail.links.find((l) => l.kind === "spec" && l.target === spec);
    return found
      ? found.id
      : ctx.axiom.addLink(detail.id, { kind: "spec", target: spec }, ctx.actor).id;
  };

  sub(task, "add", "add a task to a topic")
    .argument("<key>", "short key, unique in the topic (S7, KC3)")
    .argument("<title>")
    .option("--done-when <text>", "what makes it done")
    .option("--spec <linkId|path>", "the spec link it belongs to (a path adds the link)")
    .option("--after <key>", "a task it waits for (repeatable)", collect, [])
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [key, title], o) => {
        const topicRef = ctx.topic(o.topic);
        const created = ctx.axiom.createTask(
          topicRef,
          {
            key: key as string,
            title: title as string,
            doneWhen: o.doneWhen,
            specLinkId: o.spec === undefined ? undefined : specLinkId(ctx, topicRef, o.spec),
            dependsOn: o.after,
          },
          ctx.actor,
        );
        return { data: created, text: `Added task ${created.key}.` };
      }),
    );

  sub(task, "status", "set a task's status")
    .argument("<key>")
    .argument("<status>", TASK_STATUSES.join(" | "))
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [key, status], o) => {
        const t = ctx.axiom.setTaskStatus(
          ctx.topic(o.topic),
          key as string,
          parseTaskStatus(status as string),
          ctx.actor,
        );
        return { data: t, text: `${t.key} is now ${t.status}.` };
      }),
    );

  sub(task, "depend", "make a task wait for others (or stop waiting with --remove)")
    .argument("<key>")
    .option("--on <key>", "a task it waits for (repeatable)", collect, [])
    .option("--remove", "remove the dependencies instead")
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [key], o) => {
        if (!o.on.length) throw new UsageError("give at least one --on <key>");
        const topicRef = ctx.topic(o.topic);
        for (const on of o.on as string[]) {
          if (o.remove) ctx.axiom.removeTaskDependency(topicRef, key as string, on, ctx.actor);
          else ctx.axiom.addTaskDependency(topicRef, key as string, on, ctx.actor);
        }
        const done = ctx.axiom.getTask(topicRef, key as string);
        return {
          data: done,
          text: `${done.key} now depends on: ${done.dependsOn.join(", ") || "nothing"}.`,
        };
      }),
    );

  sub(task, "list", "list a topic's tasks")
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, _a, o) => {
        const tasks = ctx.axiom.listTasks(ctx.topic(o.topic));
        return {
          data: tasks,
          text: tasks.length
            ? table([
                ["KEY", "STATUS", "TITLE", "WAITS ON"],
                ...tasks.map((t) => [t.key, t.status, t.title, waitsOn(t, tasks).join(", ")]),
              ])
            : "No tasks.",
        };
      }),
    );

  sub(task, "show", "show one task")
    .argument("<key>")
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [key], o) => {
        const topicRef = ctx.topic(o.topic);
        const tasks = ctx.axiom.listTasks(topicRef);
        const found = tasks.find((t) => t.key === key);
        if (!found) throw new AxiomError("not-found", `task not found: ${key}`);
        const spec = found.specLinkId
          ? (ctx.axiom.getTopic(topicRef).links.find((l) => l.id === found.specLinkId)?.target ??
            null)
          : null;
        return { data: found, text: taskText(found, tasks, spec) };
      }),
    );

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
  const linkGroup = sub(program, "link", "links on a topic");
  sub(linkGroup, "add", "add a link")
    .addArgument(new Argument("<kind>").choices(LINK_KINDS))
    .argument("<target>", "URL, path or name")
    .option("--label <label>", "label (at most 120 characters)")
    .option("--description <text>", "one-line description (at most 200 characters)")
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [kind, target], o) => {
        const link = ctx.axiom.addLink(
          ctx.topic(o.topic),
          {
            kind: kind as never,
            target: target as string,
            label: o.label,
            description: o.description,
          },
          ctx.actor,
        );
        return { data: link, text: `Added ${link.kind} link #${link.id}.` };
      }),
    );
  sub(
    linkGroup,
    "update",
    "change a link's target, label or description (an empty string clears a label or description)",
  )
    .argument("<id>", "link id (shown by `topic show`)")
    .option(
      "--target <target>",
      "new URL, path or name (a repository or worktree must be an existing folder)",
    )
    .option("--label <label>", "label (at most 120 characters)")
    .option("--description <text>", "one-line description (at most 200 characters)")
    .option("--topic <topic>", "topic slug (default: current)")
    .action(
      run((ctx, [id], o) => {
        if (o.label === undefined && o.description === undefined && o.target === undefined) {
          throw new UsageError("pass --target, --label and/or --description");
        }
        const linkId = Number(id);
        if (!Number.isInteger(linkId)) throw new UsageError(`not a link id: ${id}`);
        const link = ctx.axiom.updateLink(
          ctx.topic(o.topic),
          linkId,
          { target: o.target, label: o.label, description: o.description },
          ctx.actor,
        );
        return { data: link, text: `Updated ${link.kind} link #${link.id}.` };
      }),
    );

  const monitor = sub(program, "monitor", "monitor targets");
  sub(monitor, "add", "add a monitor target (creates the link if the topic lacks it)")
    .argument("<check>", "what to check, such as pr-review, pr-checks or deploy-health")
    .argument("<target>", "what it watches, such as owner/repo#123")
    .addOption(
      new Option(
        "--link-kind <kind>",
        "kind of the watched link (default: pr for pr-* checks)",
      ).choices(LINK_KINDS),
    )
    .option("--topic <topic>", "topic slug (default: current)")
    .option("--confirmed", "confirm now instead of leaving it suggested")
    .action(
      run((ctx, [check, target], o) => {
        const { axiom, actor } = ctx;
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(check as string)) {
          throw new UsageError("check must be lowercase kebab-case, such as pr-review");
        }
        const linkKind = o.linkKind ?? ((check as string).startsWith("pr-") ? "pr" : undefined);
        if (!linkKind) throw new UsageError("pass --link-kind for checks that are not pr-*");
        const detail = axiom.getTopic(ctx.topic(o.topic));
        const link =
          detail.links.find((l) => l.kind === linkKind && l.target === target) ??
          axiom.addLink(detail.id, { kind: linkKind as never, target: target as string }, actor);
        const m = axiom.addMonitorTarget(
          detail.id,
          {
            kind: check as string,
            linkId: link.id,
            state: o.confirmed ? "confirmed" : "suggested",
          },
          actor,
        );
        return {
          data: m,
          text: `Added ${m.state} monitor target #${m.id} (${check} on ${linkKind} ${target}).`,
        };
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
    .argument("[topic]")
    .addOption(new Option("--provider <provider>").choices(PROVIDERS))
    .option("--id <providerThreadId>", "the provider's thread id")
    .option("--env <environmentId>", "T3 environment id")
    .option("--title <title>", "title")
    .option("--task <key>", "the task of the topic this thread works on")
    .action(
      run((ctx, [slug], o) => {
        if (!slug) {
          const here = ctx.currentThread();
          const at = here ? ctx.axiom.getTopic(here.topicId).slug : undefined;
          throw new UsageError(
            at
              ? `this session is already attached to topic ${at} (axiom thread show)`
              : "name the topic to attach to: axiom thread attach <topic> (axiom topic list shows them)",
          );
        }
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
          { ...found, environmentId: o.env, title: o.title, taskKey: o.task },
          ctx.actor,
        );
        return {
          data: t,
          text: `Attached ${t.provider} thread ${t.providerThreadId} to ${slug} (thread #${t.id}).`,
        };
      }),
    );
  sub(thread, "task", "name the task the current thread works on (or clear it with --none)")
    .argument("[key]")
    .option("--none", "clear the thread's task")
    .action(
      run((ctx, [key], o) => {
        if (Boolean(key) === Boolean(o.none)) throw new UsageError("give a task key or --none");
        const t = ctx.currentThread();
        if (!t) {
          throw new UsageError(
            "this session is not an attached thread (run `axiom thread attach <topic>` first)",
          );
        }
        const updated = ctx.axiom.setThreadTask(t.id, o.none ? null : (key as string), ctx.actor);
        return {
          data: updated,
          text: o.none ? "Thread has no task now." : `Thread now works on task ${key}.`,
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

  // ---- Claude Code hooks -----------------------------------------------------------------
  // `axiom hook <event>` is handled in main() before commander runs (it must never fail); the
  // command is registered here only so it shows in --help.
  // Dispatched in index.ts before commander (see server-command.ts); listed here for --help.
  sub(
    program,
    "server",
    "run the local server: `axiom server [start] [--port N]`, `axiom server install [--dry-run]`",
  )
    .argument("[args...]")
    .allowUnknownOption()
    .action(() => {});
  sub(program, "hook", "record a Claude Code hook event from stdin (used by installed hooks)")
    .addArgument(new Argument("<event>").choices(HOOK_EVENTS))
    .action(() => {});

  const hooks = sub(program, "hooks", "install or remove Axiom's Claude Code hooks");
  const hooksCommand = (name: string, description: string, change: typeof installInto) =>
    sub(hooks, name, description)
      .option("--settings <path>", "settings file (default: ~/.claude/settings.json)")
      .option("--dry-run", "print the resulting settings and write nothing")
      .addOption(new Option("--cli-entry <path>", "built CLI entry to call").hideHelp())
      .action(
        run((_ctx, _args, o) => {
          const path = resolve(o.settings ?? join(homedir(), ".claude", "settings.json"));
          const entry = resolve(
            o.cliEntry ?? join(dirname(fileURLToPath(import.meta.url)), "index.js"),
          );
          const current = readSettings(path);
          const next = change(current, process.execPath, entry);
          if (o.dryRun) {
            const text = JSON.stringify(next, null, 2);
            return { data: next, text };
          }
          const { backup, changed } = writeSettings(path, current, next);
          const text = changed
            ? `${name === "install" ? "Installed" : "Removed"} Axiom hooks in ${path}${backup ? ` (backup: ${backup})` : ""}.`
            : `No changes needed in ${path}.`;
          return { data: { path, changed, backup: backup ?? null }, text };
        }),
      );
  hooksCommand(
    "install",
    "add Axiom's hooks to Claude Code settings (idempotent, with backup)",
    installInto,
  );
  hooksCommand("uninstall", "remove Axiom's hooks from Claude Code settings", (s) =>
    uninstallFrom(s),
  );

  // ---- agents ----------------------------------------------------------------
  const agents = sub(program, "agents", "let agents run the axiom CLI without asking");
  const agentsCommand = (allow: boolean) =>
    sub(
      agents,
      allow ? "allow" : "disallow",
      allow
        ? "allow `axiom` in Claude Code and Axiom's data folder in Codex's sandbox (with backups)"
        : "undo `axiom agents allow`",
    )
      .option("--settings <path>", "Claude Code settings (default: ~/.claude/settings.json)")
      .option(
        "--codex-config <path>",
        "Codex config (default: ~/.codex/config.toml, if ~/.codex exists)",
      )
      .option("--dry-run", "say what would change and write nothing")
      .action(
        run((ctx, _args, o) => {
          const lines: string[] = [];
          const data: Record<string, unknown> = {};

          const claudePath = resolve(o.settings ?? join(homedir(), ".claude", "settings.json"));
          const current = readSettings(claudePath);
          const next = allow ? allowCliIn(current) : disallowCliFrom(current);
          const claudeChanged = JSON.stringify(next) !== JSON.stringify(current);
          let claudeBackup: string | undefined;
          if (claudeChanged && !o.dryRun)
            claudeBackup = writeSettings(claudePath, current, next).backup;
          data.claude = { path: claudePath, changed: claudeChanged, backup: claudeBackup ?? null };
          lines.push(
            `Claude Code: ${
              claudeChanged
                ? `${o.dryRun ? (allow ? "would add" : "would remove") : allow ? "added" : "removed"} ${CLAUDE_ALLOW_RULE} ${allow ? "to" : "from"} permissions.allow in ${claudePath}`
                : `${CLAUDE_ALLOW_RULE} is ${allow ? "already" : "not"} allowed in ${claudePath}`
            }${claudeBackup ? ` (backup: ${claudeBackup})` : ""}`,
          );

          const codexHome = join(homedir(), ".codex");
          const codexPath = o.codexConfig
            ? resolve(o.codexConfig)
            : existsSync(codexHome)
              ? join(codexHome, "config.toml")
              : null;
          if (codexPath === null) {
            lines.push("Codex: not installed (no ~/.codex); skipped");
            data.codex = null;
          } else {
            const toml = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
            const dataDir = dirname(resolve(ctx.options.db ?? defaultDatabasePath(env)));
            const mode = codexSandboxMode(toml);
            const edit = allow ? codexAllowRoot(toml, dataDir) : codexDisallowRoot(toml, dataDir);
            let backup: string | undefined;
            if (edit.changed && !o.dryRun) backup = writeTextWithBackup(codexPath, edit.text);
            data.codex = {
              path: codexPath,
              sandboxMode: mode ?? null,
              changed: edit.changed,
              backup: backup ?? null,
            };
            const fullAccess =
              mode === "danger-full-access"
                ? " (Codex runs with full access here, so this only matters for workspace-write sessions)"
                : "";
            lines.push(
              `Codex: ${o.dryRun && edit.changed ? "would have " : ""}${edit.note} in ${codexPath}${fullAccess}${backup ? ` (backup: ${backup})` : ""}`,
            );
          }
          return { data, text: lines.join("\n") };
        }),
      );
  agentsCommand(true);
  agentsCommand(false);

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
  if (rest[0] === "hook") {
    const at = argv.indexOf("--db");
    return runHook(rest[1] ?? "", env, { db: at >= 0 ? argv[at + 1] : undefined });
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
