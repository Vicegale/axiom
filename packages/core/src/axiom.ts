import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { z } from "zod";
import { oneLine } from "./activity.js";
import {
  type Actor,
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_T3_PIN,
  type EntryKind,
  type LinkKind,
  type MonitorState,
  type NotificationKind,
  type Provider,
  type TaskStatus,
  type TopicStatus,
  type View,
  type WorkItemStatus,
} from "./constants.js";
import { AxiomError } from "./errors.js";
import {
  entryWriteError,
  isAxiomEntryKind,
  manualStatusError,
  needsStalePrompt,
  staleCutoff,
  stopStatus,
  type ThreadState,
  topicStatusFromThreads,
  viewsOfTopic,
} from "./rules.js";
import {
  entryDataSchemas,
  jiraSchema,
  linkKindSchema,
  monitorStateSchema,
  notificationKindSchema,
  parseWith,
  providerSchema,
  refsSchema,
  settingSchemas,
  slugSchema,
  taskKeySchema,
  taskStatusSchema,
  topicStatusSchema,
  workItemStatusSchema,
} from "./schemas.js";
import type {
  Entry,
  Epic,
  Link,
  MonitorTarget,
  Notification,
  Ref,
  Task,
  TaskDetail,
  Thread,
  Ticket,
  Topic,
  TopicDetail,
  TopicRef,
  TopicSummary,
} from "./types.js";

export type Clock = () => Date;

type Row = Record<string, unknown>;
const BOOLEAN_COLUMNS = new Set([
  "muted",
  "stale_prompt_dismissed",
  "waiting_on_owner",
  "favorite",
  "desk_hidden",
]);

/** The longest reply kept on a thread, in characters. */
export const MAX_REPLY_CHARS = 200_000;

/** The longest activity line kept on a thread, in characters. */
export const MAX_ACTIVITY_CHARS = 300;

function camel<T>(row: Row | undefined): T {
  if (!row) throw new AxiomError("not-found", "row not found");
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[name] = BOOLEAN_COLUMNS.has(key) ? value === 1 : value;
  }
  return out as T;
}

export interface CreateTopicInput {
  slug: string;
  title: string;
  goal?: string;
  statusNote?: string;
  status?: TopicStatus;
}

export interface CreateWorkItemInput {
  slug: string;
  title: string;
  status?: WorkItemStatus;
  jira?: { key: string; url: string };
}

export interface AttachThreadInput {
  /** The key of a task of the topic this thread works on. */
  taskKey?: string;
  provider: Provider;
  providerThreadId: string;
  environmentId?: string | null;
  title?: string;
}

export interface EntryInput {
  kind: EntryKind;
  body?: string;
  data?: unknown;
  refs?: Ref[];
  correctsEntryId?: number;
}

export interface CreateTaskInput {
  key: string;
  title: string;
  doneWhen?: string;
  /** A `spec` link of the same topic, for grouping. */
  specLinkId?: number;
  /** Keys of tasks of the same topic this one waits for. */
  dependsOn?: string[];
  /** Order within the topic. Default: after the last task. */
  position?: number;
}

export interface UpdateTaskInput {
  title?: string;
  doneWhen?: string | null;
  specLinkId?: number | null;
  position?: number;
}

export interface ListTopicsFilter {
  view?: View;
  status?: TopicStatus | null;
}

export interface ListNotificationsOptions {
  includeDismissed?: boolean;
}

const LINK_LABEL_MAX = 120;
const LINK_DESCRIPTION_MAX = 200;

/** Trims a link's label or description; empty becomes null (cleared). */
function linkText(value: string, what: string, max: number): string | null {
  const v = value.trim();
  if (v.length > max) {
    throw new AxiomError("validation", `link ${what} must be at most ${max} characters`);
  }
  return v === "" ? null : v;
}

function ownerOnly(actor: Actor, what: string): void {
  if (actor.kind !== "owner") {
    throw new AxiomError("permission", `only the owner can ${what}`);
  }
}

/** The tracker's operations on one open database. Every write takes an actor. */
export class Axiom {
  readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(db: DatabaseSync, clock: Clock = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  now(): Date {
    return this.clock();
  }

  // ---- plumbing -----------------------------------------------------------

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as SQLInputValue[])) as unknown as T[];
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params as SQLInputValue[])) as unknown as T | undefined;
  }

  private run(sql: string, ...params: unknown[]): number {
    const r = this.stmt(sql).run(...(params as SQLInputValue[]));
    return Number(r.lastInsertRowid);
  }

  /** `BEGIN IMMEDIATE ... COMMIT` for the outermost call; savepoints when nested. */
  private tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.db.exec("BEGIN IMMEDIATE");
      this.depth = 1;
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      } finally {
        this.depth = 0;
      }
    }
    const name = `sp${this.depth}`;
    this.db.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  private iso(): string {
    return this.clock().toISOString();
  }

  private topicRow(ref: TopicRef): Topic {
    const row =
      typeof ref === "number"
        ? this.get<Row>("SELECT * FROM topic WHERE id = ?", ref)
        : this.get<Row>("SELECT * FROM topic WHERE slug = ?", ref);
    if (!row) throw new AxiomError("not-found", `topic not found: ${ref}`);
    return camel<Topic>(row);
  }

  private threadRow(id: number): Thread {
    const row = this.get<Row>("SELECT * FROM thread WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `thread not found: ${id}`);
    return camel<Thread>(row);
  }

  // ---- topics -------------------------------------------------------------

  createTopic(input: CreateTopicInput, actor: Actor): Topic {
    const slug = parseWith(slugSchema, input.slug, "slug");
    const status = parseWith(topicStatusSchema, input.status ?? "idle", "status");
    if (!input.title.trim()) throw new AxiomError("validation", "title is required");
    return this.tx(() => {
      if (this.get("SELECT 1 FROM topic WHERE slug = ?", slug)) {
        throw new AxiomError("conflict", `topic slug already exists: ${slug}`);
      }
      const at = this.iso();
      const id = this.run(
        `INSERT INTO topic (slug, title, status, status_note, goal, created_at, last_worked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        slug,
        input.title,
        status,
        input.statusNote ?? null,
        input.goal ?? null,
        at,
        at,
      );
      const threadId = actor.kind === "agent" ? (actor.threadId ?? null) : null;
      this.insertEntry({
        topicId: id,
        author: "axiom",
        threadId: this.knownThreadId(threadId),
        kind: "topic created",
        body: `Topic created: ${input.title}`,
        data: { createdBy: actor.kind },
      });
      return this.topicRow(id);
    });
  }

  updateTopic(
    ref: TopicRef,
    changes: { title?: string; goal?: string | null; statusNote?: string | null },
    _actor: Actor,
  ): Topic {
    return this.tx(() => {
      const t = this.topicRow(ref);
      this.run(
        "UPDATE topic SET title = ?, goal = ?, status_note = ?, last_worked_at = ? WHERE id = ?",
        changes.title ?? t.title,
        changes.goal === undefined ? t.goal : changes.goal,
        changes.statusNote === undefined ? t.statusNote : changes.statusNote,
        this.iso(),
        t.id,
      );
      return this.topicRow(t.id);
    });
  }

  /** Sets the topic's status by hand. Agents' choices are also remembered on their thread. */
  setTopicStatus(ref: TopicRef, status: TopicStatus, actor: Actor, reason?: string): Topic {
    const parsed = parseWith(topicStatusSchema, status, "status");
    const denied = manualStatusError(actor, parsed);
    if (denied) throw new AxiomError("permission", denied);
    return this.tx(() => {
      const t = this.topicRow(ref);
      let threadId: number | null = null;
      if (actor.kind === "agent" && actor.threadId !== undefined) {
        const th = this.get<Row>("SELECT * FROM thread WHERE id = ?", actor.threadId);
        if (th && th.topic_id === t.id) {
          threadId = actor.threadId;
          this.run("UPDATE thread SET declared_status = ? WHERE id = ?", parsed, threadId);
        }
      }
      this.applyTopicStatus(t, parsed, reason, threadId);
      return this.topicRow(t.id);
    });
  }

  setTopicMuted(ref: TopicRef, muted: boolean, actor: Actor): Topic {
    ownerOnly(actor, "mute a topic");
    return this.tx(() => {
      const t = this.topicRow(ref);
      this.run("UPDATE topic SET muted = ? WHERE id = ?", muted ? 1 : 0, t.id);
      return this.topicRow(t.id);
    });
  }

  /** The owner clicks a topic: its undismissed notifications are dismissed. */
  openTopic(ref: TopicRef, actor: Actor): void {
    ownerOnly(actor, "open a topic");
    this.tx(() => {
      const t = this.topicRow(ref);
      this.run(
        "UPDATE notification SET dismissed_at = ? WHERE topic_id = ? AND dismissed_at IS NULL",
        this.iso(),
        t.id,
      );
    });
  }

  /** Writes the new status (and a `status change` entry) if it differs from the current one. */
  private applyTopicStatus(
    t: Topic,
    to: TopicStatus | null,
    reason: string | undefined,
    threadId: number | null,
  ): void {
    if (t.status === to) return;
    this.run("UPDATE topic SET status = ? WHERE id = ?", to, t.id);
    this.insertEntry({
      topicId: t.id,
      author: "axiom",
      threadId,
      kind: "status change",
      body: `${t.status ?? "none"} -> ${to ?? "none"}${reason ? `: ${reason}` : ""}`,
      data: { from: t.status, to, ...(reason ? { reason } : {}) },
    });
  }

  private knownThreadId(id: number | null | undefined): number | null {
    if (id === null || id === undefined) return null;
    return this.get("SELECT 1 FROM thread WHERE id = ?", id) ? id : null;
  }

  getTopic(ref: TopicRef): TopicDetail {
    const t = this.topicRow(ref);
    const summary = this.summarize(t);
    return {
      ...summary,
      tickets: this.all<Row>(
        `SELECT ticket.* FROM ticket JOIN topic_ticket ON ticket.id = topic_ticket.ticket_id
         WHERE topic_ticket.topic_id = ? ORDER BY ticket.id`,
        t.id,
      ).map((r) => camel<Ticket>(r)),
      epics: this.all<Row>(
        `SELECT epic.* FROM epic JOIN topic_epic ON epic.id = topic_epic.epic_id
         WHERE topic_epic.topic_id = ? ORDER BY epic.id`,
        t.id,
      ).map((r) => camel<Epic>(r)),
      threads: this.all<Row>("SELECT * FROM thread WHERE topic_id = ? ORDER BY id", t.id).map((r) =>
        camel<Thread>(r),
      ),
      links: this.all<Row>("SELECT * FROM link WHERE topic_id = ? ORDER BY id", t.id).map((r) =>
        camel<Link>(r),
      ),
      monitorTargets: this.all<Row>(
        "SELECT * FROM monitor_target WHERE topic_id = ? ORDER BY id",
        t.id,
      ).map((r) => camel<MonitorTarget>(r)),
    };
  }

  private summarize(t: Topic): TopicSummary {
    const openThreadStatuses = this.all<{ status: TopicStatus }>(
      "SELECT status FROM thread WHERE topic_id = ? AND ended_at IS NULL ORDER BY id",
      t.id,
    ).map((r) => r.status);
    const counts = this.get<{ total: number; done: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done FROM task WHERE topic_id = ?",
      t.id,
    );
    return {
      ...t,
      taskCounts: { total: counts?.total ?? 0, done: counts?.done ?? 0 },
      views: viewsOfTopic(t.status, openThreadStatuses),
      highlighted: this.isHighlighted(t.id),
      openThreadStatuses,
    };
  }

  listTopics(filter: ListTopicsFilter = {}): TopicSummary[] {
    return this.all<Row>("SELECT * FROM topic ORDER BY last_worked_at DESC, id DESC")
      .map((r) => this.summarize(camel<Topic>(r)))
      .filter((t) => filter.view === undefined || t.views.includes(filter.view))
      .filter((t) => filter.status === undefined || t.status === filter.status);
  }

  // ---- tickets and epics --------------------------------------------------

  private createWorkItem(table: "ticket" | "epic", input: CreateWorkItemInput): Ticket {
    const slug = parseWith(slugSchema, input.slug, "slug");
    const status = parseWith(workItemStatusSchema, input.status ?? "to do", "status");
    const jira = input.jira === undefined ? null : parseWith(jiraSchema, input.jira, "jira");
    return this.tx(() => {
      if (this.get(`SELECT 1 FROM ${table} WHERE slug = ?`, slug)) {
        throw new AxiomError("conflict", `${table} slug already exists: ${slug}`);
      }
      const at = this.iso();
      const id = this.run(
        `INSERT INTO ${table} (slug, title, status, jira_key, jira_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        slug,
        input.title,
        status,
        jira?.key ?? null,
        jira?.url ?? null,
        at,
        at,
      );
      return this.workItemRow(table, id);
    });
  }

  private workItemRow(table: "ticket" | "epic", ref: TopicRef): Ticket {
    const row =
      typeof ref === "number"
        ? this.get<Row>(`SELECT * FROM ${table} WHERE id = ?`, ref)
        : this.get<Row>(`SELECT * FROM ${table} WHERE slug = ?`, ref);
    if (!row) throw new AxiomError("not-found", `${table} not found: ${ref}`);
    return camel<Ticket>(row);
  }

  private setWorkItemStatus(
    table: "ticket" | "epic",
    ref: TopicRef,
    status: WorkItemStatus,
    _actor: Actor,
  ): Ticket {
    const parsed = parseWith(workItemStatusSchema, status, "status");
    return this.tx(() => {
      const item = this.workItemRow(table, ref);
      if (item.jiraKey !== null) {
        throw new AxiomError(
          "conflict",
          `${table} ${item.slug} is linked to Jira (${item.jiraKey}); its status is Jira's and is locked`,
        );
      }
      this.run(
        `UPDATE ${table} SET status = ?, updated_at = ? WHERE id = ?`,
        parsed,
        this.iso(),
        item.id,
      );
      return this.workItemRow(table, item.id);
    });
  }

  private setWorkItemJiraStatus(
    table: "ticket" | "epic",
    ref: TopicRef,
    jiraStatus: string,
  ): Ticket {
    return this.tx(() => {
      const item = this.workItemRow(table, ref);
      if (item.jiraKey === null) {
        throw new AxiomError("conflict", `${table} ${item.slug} is not linked to Jira`);
      }
      const at = this.iso();
      this.run(
        `UPDATE ${table} SET jira_status = ?, jira_synced_at = ?, updated_at = ? WHERE id = ?`,
        jiraStatus,
        at,
        at,
        item.id,
      );
      return this.workItemRow(table, item.id);
    });
  }

  createTicket(input: CreateWorkItemInput, _actor: Actor): Ticket {
    return this.createWorkItem("ticket", input);
  }
  createEpic(input: CreateWorkItemInput, _actor: Actor): Epic {
    return this.createWorkItem("epic", input);
  }
  getTicket(ref: TopicRef): Ticket {
    return this.workItemRow("ticket", ref);
  }
  getEpic(ref: TopicRef): Epic {
    return this.workItemRow("epic", ref);
  }
  listTickets(): Ticket[] {
    return this.all<Row>("SELECT * FROM ticket ORDER BY id").map((r) => camel<Ticket>(r));
  }
  listEpics(): Epic[] {
    return this.all<Row>("SELECT * FROM epic ORDER BY id").map((r) => camel<Epic>(r));
  }
  setTicketStatus(ref: TopicRef, status: WorkItemStatus, actor: Actor): Ticket {
    return this.setWorkItemStatus("ticket", ref, status, actor);
  }
  setEpicStatus(ref: TopicRef, status: WorkItemStatus, actor: Actor): Epic {
    return this.setWorkItemStatus("epic", ref, status, actor);
  }
  /** For the Jira connector: stores Jira's own status name and when it was pulled. */
  setTicketJiraStatus(ref: TopicRef, jiraStatus: string): Ticket {
    return this.setWorkItemJiraStatus("ticket", ref, jiraStatus);
  }
  setEpicJiraStatus(ref: TopicRef, jiraStatus: string): Epic {
    return this.setWorkItemJiraStatus("epic", ref, jiraStatus);
  }

  // ---- parents (many-to-many) ---------------------------------------------

  addTopicToTicket(topic: TopicRef, ticket: TopicRef, _actor: Actor): void {
    this.tx(() => {
      this.run(
        "INSERT OR IGNORE INTO topic_ticket (topic_id, ticket_id) VALUES (?, ?)",
        this.topicRow(topic).id,
        this.workItemRow("ticket", ticket).id,
      );
    });
  }
  removeTopicFromTicket(topic: TopicRef, ticket: TopicRef, _actor: Actor): void {
    this.run(
      "DELETE FROM topic_ticket WHERE topic_id = ? AND ticket_id = ?",
      this.topicRow(topic).id,
      this.workItemRow("ticket", ticket).id,
    );
  }
  addTopicToEpic(topic: TopicRef, epic: TopicRef, _actor: Actor): void {
    this.tx(() => {
      this.run(
        "INSERT OR IGNORE INTO topic_epic (topic_id, epic_id) VALUES (?, ?)",
        this.topicRow(topic).id,
        this.workItemRow("epic", epic).id,
      );
    });
  }
  removeTopicFromEpic(topic: TopicRef, epic: TopicRef, _actor: Actor): void {
    this.run(
      "DELETE FROM topic_epic WHERE topic_id = ? AND epic_id = ?",
      this.topicRow(topic).id,
      this.workItemRow("epic", epic).id,
    );
  }
  addTicketToEpic(ticket: TopicRef, epic: TopicRef, _actor: Actor): void {
    this.tx(() => {
      this.run(
        "INSERT OR IGNORE INTO ticket_epic (ticket_id, epic_id) VALUES (?, ?)",
        this.workItemRow("ticket", ticket).id,
        this.workItemRow("epic", epic).id,
      );
    });
  }
  removeTicketFromEpic(ticket: TopicRef, epic: TopicRef, _actor: Actor): void {
    this.run(
      "DELETE FROM ticket_epic WHERE ticket_id = ? AND epic_id = ?",
      this.workItemRow("ticket", ticket).id,
      this.workItemRow("epic", epic).id,
    );
  }
  listTicketEpics(ticket: TopicRef): Epic[] {
    return this.all<Row>(
      `SELECT epic.* FROM epic JOIN ticket_epic ON epic.id = ticket_epic.epic_id
       WHERE ticket_epic.ticket_id = ? ORDER BY epic.id`,
      this.workItemRow("ticket", ticket).id,
    ).map((r) => camel<Epic>(r));
  }

  // ---- links and monitor targets ------------------------------------------

  addLink(
    topic: TopicRef,
    input: { kind: LinkKind; target: string; label?: string; description?: string },
    actor: Actor,
  ): Link {
    const kind = parseWith(linkKindSchema, input.kind, "link kind");
    if (!input.target.trim()) throw new AxiomError("validation", "link target is required");
    const label = input.label === undefined ? null : linkText(input.label, "label", LINK_LABEL_MAX);
    const description =
      input.description === undefined
        ? null
        : linkText(input.description, "description", LINK_DESCRIPTION_MAX);
    return this.tx(() => {
      const t = this.topicRow(topic);
      const threadId = this.knownThreadId(actor.kind === "agent" ? actor.threadId : null);
      const id = this.run(
        `INSERT INTO link (topic_id, kind, target, label, description, created_at, created_by_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        kind,
        input.target,
        label,
        description,
        this.iso(),
        threadId,
      );
      return camel<Link>(this.get<Row>("SELECT * FROM link WHERE id = ?", id));
    });
  }

  /** Changes a link's label and/or description; an empty string clears the field. */
  updateLink(
    topic: TopicRef,
    linkId: number,
    changes: { label?: string; description?: string },
    _actor: Actor,
  ): Link {
    const label =
      changes.label === undefined ? undefined : linkText(changes.label, "label", LINK_LABEL_MAX);
    const description =
      changes.description === undefined
        ? undefined
        : linkText(changes.description, "description", LINK_DESCRIPTION_MAX);
    return this.tx(() => {
      const t = this.topicRow(topic);
      const row = this.get<Row>("SELECT * FROM link WHERE id = ? AND topic_id = ?", linkId, t.id);
      if (!row) throw new AxiomError("not-found", `link not found: ${linkId}`);
      this.run(
        "UPDATE link SET label = ?, description = ? WHERE id = ?",
        label === undefined ? (row.label as string | null) : label,
        description === undefined ? (row.description as string | null) : description,
        linkId,
      );
      if (label !== undefined || description !== undefined) this.touchTopic(t.id);
      return camel<Link>(this.get<Row>("SELECT * FROM link WHERE id = ?", linkId));
    });
  }

  addMonitorTarget(
    topic: TopicRef,
    input: { kind: string; linkId?: number; state?: MonitorState },
    _actor: Actor,
  ): MonitorTarget {
    const state = parseWith(monitorStateSchema, input.state ?? "suggested", "monitor state");
    return this.tx(() => {
      const t = this.topicRow(topic);
      if (input.linkId !== undefined) {
        const link = this.get<Row>("SELECT topic_id FROM link WHERE id = ?", input.linkId);
        if (!link || link.topic_id !== t.id) {
          throw new AxiomError("validation", "monitor target link must belong to the same topic");
        }
      }
      const id = this.run(
        "INSERT INTO monitor_target (topic_id, link_id, kind, state, created_at) VALUES (?, ?, ?, ?, ?)",
        t.id,
        input.linkId ?? null,
        input.kind,
        state,
        this.iso(),
      );
      return camel<MonitorTarget>(this.get<Row>("SELECT * FROM monitor_target WHERE id = ?", id));
    });
  }

  confirmMonitorTarget(id: number, _actor: Actor): MonitorTarget {
    return this.tx(() => {
      if (!this.get("SELECT 1 FROM monitor_target WHERE id = ?", id)) {
        throw new AxiomError("not-found", `monitor target not found: ${id}`);
      }
      this.run("UPDATE monitor_target SET state = 'confirmed' WHERE id = ?", id);
      return camel<MonitorTarget>(this.get<Row>("SELECT * FROM monitor_target WHERE id = ?", id));
    });
  }

  // ---- threads ------------------------------------------------------------

  attachThread(topic: TopicRef, input: AttachThreadInput, _actor: Actor): Thread {
    const provider = parseWith(providerSchema, input.provider, "provider");
    if (!input.providerThreadId) throw new AxiomError("validation", "providerThreadId is required");
    return this.tx(() => {
      const t = this.topicRow(topic);
      const existing = this.findThread({
        provider,
        providerThreadId: input.providerThreadId,
        environmentId: input.environmentId ?? null,
      });
      if (existing) {
        const where = existing.topicId === t.id ? "this topic" : `topic id ${existing.topicId}`;
        throw new AxiomError(
          "conflict",
          `thread ${provider}:${input.providerThreadId} is already attached to ${where}`,
        );
      }
      const at = this.iso();
      const id = this.run(
        `INSERT INTO thread (topic_id, provider, provider_thread_id, environment_id, title,
                             status_changed_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        provider,
        input.providerThreadId,
        input.environmentId ?? null,
        input.title ?? null,
        at,
        at,
      );
      if (input.taskKey !== undefined) {
        this.run(
          "UPDATE thread SET task_id = ? WHERE id = ?",
          this.taskRow(t.id, input.taskKey).id,
          id,
        );
      }
      return this.threadRow(id);
    });
  }

  /**
   * Finds an attached thread. `environmentId: undefined` matches any environment (a session knows
   * its thread id but not always its T3 environment id); `null` or a string must match exactly.
   */
  findThread(input: {
    provider: Provider;
    providerThreadId: string;
    environmentId?: string | null;
  }): Thread | undefined {
    const row =
      input.environmentId === undefined
        ? this.get<Row>(
            `SELECT * FROM thread WHERE provider = ? AND provider_thread_id = ?
               ORDER BY id LIMIT 1`,
            input.provider,
            input.providerThreadId,
          )
        : this.get<Row>(
            `SELECT * FROM thread WHERE provider = ? AND provider_thread_id = ?
               AND COALESCE(environment_id, '') = ?`,
            input.provider,
            input.providerThreadId,
            input.environmentId ?? "",
          );
    return row ? camel<Thread>(row) : undefined;
  }

  /** Every attached thread of a provider, oldest first. */
  listProviderThreads(provider: Provider): Thread[] {
    return this.all<Row>("SELECT * FROM thread WHERE provider = ? ORDER BY id", provider).map((r) =>
      camel<Thread>(r),
    );
  }

  /**
   * Asks the server to re-read a provider now (a hook saw activity). Written to a setting so the
   * server notices it through the database change counter. Never throws on a missing provider.
   */
  requestProviderRefresh(provider: Provider): void {
    this.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      `providerRefresh:${provider}`,
      JSON.stringify(this.iso()),
    );
  }

  /** Sets a thread's title when it has none (providers fill it in; a title given by hand wins). */
  fillThreadTitle(threadId: number, title: string): boolean {
    const t = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!t) return false;
    const r = this.db
      .prepare("UPDATE thread SET title = ? WHERE id = ? AND (title IS NULL OR title = '')")
      .run(t, threadId);
    return Number(r.changes) > 0;
  }

  /** The working directory a direct Claude Code session runs in (from its hooks), for resuming. */
  setThreadCwd(threadId: number, cwd: string): void {
    this.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      `threadCwd:${threadId}`,
      JSON.stringify(cwd),
    );
  }

  threadCwd(threadId: number): string | null {
    const v = this.getSetting(`threadCwd:${threadId}`);
    return typeof v === "string" ? v : null;
  }

  /** Bookkeeping that providers keep in the setting table (not owner settings; no actor check). */
  setInternalSetting(key: string, value: unknown): void {
    this.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  /** Records that a Claude Code hook ran (any session, attached or not): hooks are alive. */
  recordHookEvent(): void {
    this.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      "hooks:lastEventAt",
      JSON.stringify(this.iso()),
    );
  }

  /** When any Claude Code hook last ran (ISO), or null. */
  lastHookEventAt(): string | null {
    const v = this.getSetting("hooks:lastEventAt");
    return typeof v === "string" ? v : null;
  }

  /** When a refresh was last requested for the provider (epoch ms), or 0. */
  providerRefreshRequestedAt(provider: Provider): number {
    const v = this.getSetting(`providerRefresh:${provider}`);
    return typeof v === "string" ? Date.parse(v) || 0 : 0;
  }

  /**
   * How many subagents the thread was still waiting on when it last stopped (from Claude Code's
   * Stop payload). While this is above zero the thread has not really stopped (01, "When an agent
   * stops"). Kept as a setting so no migration is needed.
   */
  setRunningSubagents(threadId: number, count: number): void {
    const key = `subagents:${threadId}`;
    if (count > 0) {
      this.run(
        "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key,
        JSON.stringify(count),
      );
    } else {
      this.run("DELETE FROM setting WHERE key = ?", key);
    }
  }

  runningSubagents(threadId: number): number {
    const v = this.getSetting(`subagents:${threadId}`);
    return typeof v === "number" ? v : 0;
  }

  getThread(id: number): Thread {
    return this.threadRow(id);
  }

  // ---- the Desk (02): latest replies, summaries, arrangement ----------------

  /**
   * Stores the thread's latest reply (capped). Blank text and a reply identical to the stored one
   * change nothing, so the same reply seen twice (hook, then T3 sync) is not summarised twice.
   * Not a history entry.
   */
  setThreadReply(threadId: number, text: string, at?: string): void {
    if (!text.trim()) return;
    const th = this.threadRow(threadId);
    const capped = text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS) : text;
    if (th.lastReply === capped) return;
    this.run(
      "UPDATE thread SET last_reply = ?, last_reply_at = ?, summary_error = NULL WHERE id = ?",
      capped,
      at ?? this.iso(),
      threadId,
    );
  }

  /** Stores the summary of the reply made at `replyAt`. Ephemeral: overwrites the last one. */
  setThreadSummary(
    threadId: number,
    summary: { now: string; next: string },
    replyAt: string,
  ): void {
    this.threadRow(threadId);
    this.run(
      `UPDATE thread SET summary_now = ?, summary_next = ?, summary_at = ?, summary_reply_at = ?,
         summary_error = NULL WHERE id = ?`,
      summary.now,
      summary.next,
      this.iso(),
      replyAt,
      threadId,
    );
  }

  setThreadSummaryError(threadId: number, message: string): void {
    this.threadRow(threadId);
    this.run("UPDATE thread SET summary_error = ? WHERE id = ?", message, threadId);
  }

  /**
   * Stores the newest step the agent took, as one short line (trimmed, newlines folded, capped at
   * `MAX_ACTIVITY_CHARS`). Ephemeral: overwrites the last one, never a history entry, touches
   * nothing else. Blank text changes nothing.
   */
  setThreadActivity(threadId: number, text: string, at?: string): void {
    const line = oneLine(text, MAX_ACTIVITY_CHARS);
    if (!line) return;
    this.threadRow(threadId);
    this.run(
      "UPDATE thread SET activity_text = ?, activity_at = ? WHERE id = ?",
      line,
      at ?? this.iso(),
      threadId,
    );
  }

  /** Threads whose latest reply has no summary yet (never summarised, or the reply is newer). */
  threadsNeedingSummary(limit: number): Thread[] {
    return this.all<Row>(
      `SELECT * FROM thread
       WHERE last_reply IS NOT NULL AND last_reply_at IS NOT NULL
         AND (summary_reply_at IS NULL OR last_reply_at > summary_reply_at)
       ORDER BY last_reply_at DESC, id DESC LIMIT ?`,
      limit,
    ).map((r) => camel<Thread>(r));
  }

  setTopicFavorite(topic: TopicRef, on: boolean, actor: Actor): void {
    ownerOnly(actor, "favourite a topic");
    this.run("UPDATE topic SET favorite = ? WHERE id = ?", on ? 1 : 0, this.topicRow(topic).id);
  }

  setTopicDeskHidden(topic: TopicRef, hidden: boolean, actor: Actor): void {
    ownerOnly(actor, "hide a topic from the Desk");
    this.run(
      "UPDATE topic SET desk_hidden = ? WHERE id = ?",
      hidden ? 1 : 0,
      this.topicRow(topic).id,
    );
  }

  /**
   * The owner's drag order: the listed topics get positions 0..n-1 in that order; any other topic
   * that had a position keeps its relative order after them.
   */
  setDeskOrder(slugs: string[], actor: Actor): void {
    ownerOnly(actor, "arrange the Desk");
    if (new Set(slugs).size !== slugs.length) {
      throw new AxiomError("validation", "a topic is listed twice");
    }
    this.tx(() => {
      const ids = slugs.map((s) => this.topicRow(s).id);
      const rest = this.all<{ id: number }>(
        "SELECT id FROM topic WHERE desk_order IS NOT NULL ORDER BY desk_order, id",
      )
        .map((r) => r.id)
        .filter((id) => !ids.includes(id));
      [...ids, ...rest].forEach((id, i) => {
        this.run("UPDATE topic SET desk_order = ? WHERE id = ?", i, id);
      });
    });
  }

  /** A new turn started: the thread is working, and what it declared before no longer holds. */
  threadWorking(threadId: number): Thread {
    return this.tx(() => {
      const th = this.threadEvent(threadId, {
        event: "working",
        status: "wip",
        body: "Thread working",
        clear: true,
      });
      // The thread's task, if it named one, is being worked on (01, Tasks). Stopping or ending
      // never touches it: the agent sets `done` or `blocked`. A task already `done` stays done:
      // a thread still pointing at it is doing follow-up work, not reopening it.
      if (th.taskId !== null) {
        const task = this.taskById(th.taskId);
        if (task.status === "to do" || task.status === "blocked") {
          this.applyTaskStatus(task, "wip", { kind: "axiom" }, threadId);
        }
      }
      return th;
    });
  }

  threadWaitingOnOwner(threadId: number, reason: string): Thread {
    return this.threadEvent(threadId, {
      event: "waiting on owner",
      status: "hitl",
      body: `Waiting on the owner: ${reason}`,
      waiting: true,
      notify: { kind: "agent asked", body: reason },
    });
  }

  threadStopped(threadId: number): Thread {
    return this.threadEvent(threadId, {
      event: "stopped",
      body: "Thread stopped",
      notify: { kind: "agent stopped", body: "The agent stopped" },
      statusFromStop: true,
    });
  }

  threadError(threadId: number, message: string): Thread {
    return this.threadEvent(threadId, {
      event: "error",
      status: "error",
      body: `Thread error: ${message}`,
      notify: { kind: "error", body: message },
    });
  }

  /** The session ended. The thread's status is unchanged; it stops counting as open. */
  threadEnded(threadId: number, reason?: string): Thread {
    return this.tx(() => {
      const th = this.threadRow(threadId);
      if (th.endedAt === null) {
        this.run(
          "UPDATE thread SET ended_at = ?, end_reason = ? WHERE id = ?",
          this.iso(),
          reason ?? null,
          threadId,
        );
        // A thread that ends while still running (killed, crashed session) is no longer working.
        if (th.status === "wip") {
          this.run(
            `UPDATE thread SET status = 'idle', status_changed_at = ?,
               status_changed_seq = (SELECT COALESCE(MAX(status_changed_seq), 0) + 1 FROM thread)
             WHERE id = ?`,
            this.iso(),
            threadId,
          );
        }
      }
      this.insertEntry({
        topicId: th.topicId,
        author: "axiom",
        threadId,
        kind: "thread event",
        body: `Thread ended${reason ? `: ${reason}` : ""}`,
        data: { event: "ended", provider: th.provider, providerThreadId: th.providerThreadId },
      });
      // Only a thread that was still running changes the topic; otherwise a session ending would
      // overwrite a status set by hand (for example the owner marking the topic done).
      if (th.endedAt === null && th.status === "wip") {
        this.recomputeFromThreads(this.topicRow(th.topicId), "thread ended", threadId);
      }
      return this.threadRow(threadId);
    });
  }

  /**
   * A session that had ended was resumed: the thread counts as open again. Status is unchanged;
   * the next prompt moves it. Does nothing (and writes no entry) when the thread is already open.
   */
  threadReopened(threadId: number): Thread {
    return this.tx(() => {
      const th = this.threadRow(threadId);
      if (th.endedAt === null) return th;
      this.run("UPDATE thread SET ended_at = NULL, end_reason = NULL WHERE id = ?", threadId);
      this.insertEntry({
        topicId: th.topicId,
        author: "axiom",
        threadId,
        kind: "thread event",
        body: "Thread resumed",
        data: { event: "resumed", provider: th.provider, providerThreadId: th.providerThreadId },
      });
      return this.threadRow(threadId);
    });
  }

  private threadEvent(
    threadId: number,
    ev: {
      event: string;
      body: string;
      status?: TopicStatus;
      statusFromStop?: boolean;
      clear?: boolean;
      waiting?: boolean;
      notify?: { kind: NotificationKind; body: string };
    },
  ): Thread {
    return this.tx(() => {
      const th = this.threadRow(threadId);
      const topic = this.topicRow(th.topicId);
      let status = ev.status;
      if (ev.statusFromStop) {
        status = stopStatus({
          declaredStatus: th.declaredStatus,
          waitingOnOwner: th.waitingOnOwner,
          hasPrLink: !!this.get(
            "SELECT 1 FROM link WHERE topic_id = ? AND kind = 'pr'",
            th.topicId,
          ),
          confirmedMonitorTargets:
            this.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM monitor_target WHERE topic_id = ? AND state = 'confirmed'",
              th.topicId,
            )?.n ?? 0,
        });
      }
      if (status === undefined) throw new AxiomError("validation", "thread event without a status");
      this.run(
        `UPDATE thread SET status = ?, status_changed_at = ?,
           status_changed_seq = (SELECT COALESCE(MAX(status_changed_seq), 0) + 1 FROM thread),
           declared_status = CASE WHEN ? THEN NULL ELSE declared_status END,
           waiting_on_owner = CASE WHEN ? THEN 0 WHEN ? THEN 1 ELSE waiting_on_owner END
         WHERE id = ?`,
        status,
        this.iso(),
        ev.clear ? 1 : 0,
        ev.clear ? 1 : 0,
        ev.waiting ? 1 : 0,
        threadId,
      );
      this.insertEntry({
        topicId: topic.id,
        author: "axiom",
        threadId,
        kind: "thread event",
        body: ev.body,
        data: { event: ev.event, provider: th.provider, providerThreadId: th.providerThreadId },
      });
      if (ev.notify) this.insertNotification(topic.id, threadId, ev.notify.kind, ev.notify.body);
      this.recomputeFromThreads(topic, `thread ${ev.event}`, threadId);
      return this.threadRow(threadId);
    });
  }

  private recomputeFromThreads(topic: Topic, reason: string, threadId: number): void {
    const threads = this.all<Row>("SELECT * FROM thread WHERE topic_id = ?", topic.id).map((r) => {
      const th = camel<Thread>(r);
      const state: ThreadState = {
        status: th.status,
        open: th.endedAt === null,
        statusChangedAt: th.statusChangedAt,
        statusChangedSeq: th.statusChangedSeq,
      };
      return state;
    });
    if (threads.length === 0) return;
    const fresh = this.topicRow(topic.id);
    this.applyTopicStatus(fresh, topicStatusFromThreads(threads), reason, threadId);
  }

  // ---- tasks (01, Tasks) ----------------------------------------------------

  private taskById(id: number): Task {
    const row = this.get<Row>("SELECT * FROM task WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `task not found: ${id}`);
    return camel<Task>(row);
  }

  private taskRow(topicId: number, key: string): Task {
    const row = this.get<Row>("SELECT * FROM task WHERE topic_id = ? AND key = ?", topicId, key);
    if (!row) throw new AxiomError("not-found", `task not found: ${key}`);
    return camel<Task>(row);
  }

  private touchTopic(topicId: number): void {
    this.run("UPDATE topic SET last_worked_at = ? WHERE id = ?", this.iso(), topicId);
  }

  private checkSpecLink(topicId: number, linkId: number): void {
    const link = this.get<Row>("SELECT topic_id, kind FROM link WHERE id = ?", linkId);
    if (!link || link.topic_id !== topicId || link.kind !== "spec") {
      throw new AxiomError("validation", "a task's spec must be a spec link of the same topic");
    }
  }

  createTask(topic: TopicRef, input: CreateTaskInput, _actor: Actor): TaskDetail {
    const key = parseWith(taskKeySchema, input.key, "task key");
    if (!input.title.trim()) throw new AxiomError("validation", "task title is required");
    return this.tx(() => {
      const t = this.topicRow(topic);
      if (this.get("SELECT 1 FROM task WHERE topic_id = ? AND key = ?", t.id, key)) {
        throw new AxiomError("conflict", `task key already exists in ${t.slug}: ${key}`);
      }
      if (input.specLinkId !== undefined) this.checkSpecLink(t.id, input.specLinkId);
      const deps = [...new Set(input.dependsOn ?? [])].map((k) => {
        if (k === key) throw new AxiomError("validation", `task ${key} cannot depend on itself`);
        return this.taskRow(t.id, k);
      });
      const at = this.iso();
      const position =
        input.position ??
        (this.get<{ p: number }>(
          "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM task WHERE topic_id = ?",
          t.id,
        )?.p as number);
      const id = this.run(
        `INSERT INTO task (topic_id, key, title, done_when, position, spec_link_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        key,
        input.title,
        input.doneWhen ?? null,
        position,
        input.specLinkId ?? null,
        at,
        at,
      );
      // A new task has no dependents yet, so these edges cannot close a cycle.
      for (const d of deps) {
        this.run(
          "INSERT INTO task_dependency (task_id, depends_on_task_id) VALUES (?, ?)",
          id,
          d.id,
        );
      }
      this.touchTopic(t.id);
      return this.taskDetail(this.taskById(id));
    });
  }

  updateTask(topic: TopicRef, key: string, changes: UpdateTaskInput, _actor: Actor): TaskDetail {
    return this.tx(() => {
      const t = this.topicRow(topic);
      const task = this.taskRow(t.id, key);
      if (changes.title !== undefined && !changes.title.trim()) {
        throw new AxiomError("validation", "task title is required");
      }
      if (changes.specLinkId !== undefined && changes.specLinkId !== null) {
        this.checkSpecLink(t.id, changes.specLinkId);
      }
      this.run(
        `UPDATE task SET title = ?, done_when = ?, spec_link_id = ?, position = ?, updated_at = ?
         WHERE id = ?`,
        changes.title ?? task.title,
        changes.doneWhen === undefined ? task.doneWhen : changes.doneWhen,
        changes.specLinkId === undefined ? task.specLinkId : changes.specLinkId,
        changes.position ?? task.position,
        this.iso(),
        task.id,
      );
      this.touchTopic(t.id);
      return this.taskDetail(this.taskById(task.id));
    });
  }

  /**
   * Sets a task's status and writes a `status change` entry (author `axiom`, as 08 requires for
   * that kind; `data.task` is the key and `data.by` who asked). Anyone may set a task's status.
   */
  setTaskStatus(topic: TopicRef, key: string, status: TaskStatus, actor: Actor): TaskDetail {
    const parsed = parseWith(taskStatusSchema, status, "task status");
    return this.tx(() => {
      const t = this.topicRow(topic);
      const task = this.taskRow(t.id, key);
      const threadId = this.knownThreadId(actor.kind === "agent" ? actor.threadId : null);
      this.applyTaskStatus(task, parsed, actor, threadId);
      return this.taskDetail(this.taskById(task.id));
    });
  }

  private applyTaskStatus(task: Task, to: TaskStatus, actor: Actor, threadId: number | null): void {
    if (task.status === to) return;
    this.run("UPDATE task SET status = ?, updated_at = ? WHERE id = ?", to, this.iso(), task.id);
    this.insertEntry({
      topicId: task.topicId,
      author: "axiom",
      threadId,
      kind: "status change",
      body: `Task ${task.key}: ${task.status} -> ${to}`,
      data: { task: task.key, from: task.status, to, by: actor.kind },
    });
  }

  /** `key` now waits for `dependsOn`. Same topic only; rejects itself and cycles. */
  addTaskDependency(topic: TopicRef, key: string, dependsOn: string, _actor: Actor): TaskDetail {
    return this.tx(() => {
      const t = this.topicRow(topic);
      const task = this.taskRow(t.id, key);
      if (key === dependsOn) {
        throw new AxiomError("validation", `task ${key} cannot depend on itself`);
      }
      const dep = this.taskRow(t.id, dependsOn);
      // A cycle appears when the new prerequisite already (transitively) waits for this task.
      const path = this.dependencyPath(dep.id, task.id);
      if (path) {
        const chain = [key, ...path.map((id) => this.taskById(id).key)];
        throw new AxiomError("validation", `dependency cycle: ${chain.join(" waits for ")}`);
      }
      this.run(
        "INSERT OR IGNORE INTO task_dependency (task_id, depends_on_task_id) VALUES (?, ?)",
        task.id,
        dep.id,
      );
      this.touchTopic(t.id);
      return this.taskDetail(task);
    });
  }

  removeTaskDependency(topic: TopicRef, key: string, dependsOn: string, _actor: Actor): TaskDetail {
    return this.tx(() => {
      const t = this.topicRow(topic);
      const task = this.taskRow(t.id, key);
      const dep = this.taskRow(t.id, dependsOn);
      this.run(
        "DELETE FROM task_dependency WHERE task_id = ? AND depends_on_task_id = ?",
        task.id,
        dep.id,
      );
      this.touchTopic(t.id);
      return this.taskDetail(task);
    });
  }

  /** Task ids from `from` to `to` following "waits for" edges, or null when `to` is unreachable. */
  private dependencyPath(from: number, to: number): number[] | null {
    const seen = new Map<number, number | null>([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const id = queue.shift() as number;
      if (id === to) {
        const path: number[] = [];
        for (let at: number | null = id; at !== null; at = seen.get(at) ?? null) path.unshift(at);
        return path;
      }
      for (const r of this.all<{ depends_on_task_id: number }>(
        "SELECT depends_on_task_id FROM task_dependency WHERE task_id = ?",
        id,
      )) {
        if (!seen.has(r.depends_on_task_id)) {
          seen.set(r.depends_on_task_id, id);
          queue.push(r.depends_on_task_id);
        }
      }
    }
    return null;
  }

  private taskDetail(task: Task): TaskDetail {
    const dependsOn = this.all<{ key: string; status: TaskStatus }>(
      `SELECT d.key AS key, d.status AS status FROM task_dependency x JOIN task d ON d.id = x.depends_on_task_id
       WHERE x.task_id = ? ORDER BY d.position, d.id`,
      task.id,
    );
    const dependents = this.all<{ key: string }>(
      `SELECT d.key AS key FROM task_dependency x JOIN task d ON d.id = x.task_id
       WHERE x.depends_on_task_id = ? ORDER BY d.position, d.id`,
      task.id,
    );
    return {
      ...task,
      dependsOn: dependsOn.map((d) => d.key),
      dependents: dependents.map((d) => d.key),
      waiting: dependsOn.some((d) => d.status !== "done"),
    };
  }

  getTask(topic: TopicRef, key: string): TaskDetail {
    return this.taskDetail(this.taskRow(this.topicRow(topic).id, key));
  }

  /** The topic's tasks in order, with dependencies, dependents and the `waiting` flag. */
  listTasks(topic: TopicRef): TaskDetail[] {
    const t = this.topicRow(topic);
    return this.all<Row>("SELECT * FROM task WHERE topic_id = ? ORDER BY position, id", t.id).map(
      (r) => this.taskDetail(camel<Task>(r)),
    );
  }

  /** Names (or clears, with null) the task a thread works on. The task must be in its topic. */
  setThreadTask(threadId: number, key: string | null, _actor: Actor): Thread {
    return this.tx(() => {
      const th = this.threadRow(threadId);
      const task = key === null ? null : this.taskRow(th.topicId, key);
      this.run("UPDATE thread SET task_id = ? WHERE id = ?", task?.id ?? null, threadId);
      // Pointing a thread that is already working at a task starts that task now, rather than
      // at the thread's next "working" event (same rule as threadWorking).
      if (task && th.endedAt === null && th.status === "wip") {
        const current = this.taskById(task.id);
        if (current.status === "to do" || current.status === "blocked") {
          this.applyTaskStatus(current, "wip", { kind: "axiom" }, threadId);
        }
      }
      return this.threadRow(threadId);
    });
  }

  // ---- entries ------------------------------------------------------------

  addEntry(topic: TopicRef, input: EntryInput, actor: Actor): Entry {
    const kind = input.kind;
    if (!(kind in entryDataSchemas)) {
      throw new AxiomError("validation", `unknown entry kind "${kind}"`);
    }
    const denied = entryWriteError(actor, kind);
    if (denied) throw new AxiomError("permission", denied);
    if (!isAxiomEntryKind(kind) && !input.body?.trim()) {
      throw new AxiomError("validation", `"${kind}" entries need a body`);
    }
    const schema = entryDataSchemas[kind] as z.ZodType;
    const data = parseWith(schema, input.data, `data for "${kind}" entry`);
    const refs = parseWith(refsSchema, input.refs ?? [], "refs");
    return this.tx(() => {
      const t = this.topicRow(topic);
      if (input.correctsEntryId !== undefined) {
        const target = this.get<Row>(
          "SELECT topic_id FROM entry WHERE id = ?",
          input.correctsEntryId,
        );
        if (!target) {
          throw new AxiomError("not-found", `entry to correct not found: ${input.correctsEntryId}`);
        }
        if (target.topic_id !== t.id) {
          throw new AxiomError(
            "validation",
            "an entry can only correct an entry of the same topic",
          );
        }
      }
      const id = this.insertEntry({
        topicId: t.id,
        author: actor.kind,
        threadId: this.knownThreadId(actor.kind === "agent" ? actor.threadId : null),
        kind,
        body: input.body ?? null,
        data,
        refs,
        correctsEntryId: input.correctsEntryId ?? null,
      });
      return this.entryRow(id);
    });
  }

  private insertEntry(e: {
    topicId: number;
    author: Entry["author"];
    threadId?: number | null;
    kind: EntryKind;
    body?: string | null;
    data?: unknown;
    refs?: Ref[];
    correctsEntryId?: number | null;
  }): number {
    if (e.kind === "status change" || isAxiomEntryKind(e.kind)) {
      parseWith(entryDataSchemas[e.kind] as z.ZodType, e.data, `data for "${e.kind}" entry`);
    }
    const at = this.iso();
    const id = this.run(
      `INSERT INTO entry (topic_id, at, author, thread_id, kind, body, data, refs, corrects_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.topicId,
      at,
      e.author,
      e.threadId ?? null,
      e.kind,
      e.body ?? null,
      e.data === undefined ? null : JSON.stringify(e.data),
      JSON.stringify(e.refs ?? []),
      e.correctsEntryId ?? null,
    );
    this.run("UPDATE topic SET last_worked_at = ? WHERE id = ?", at, e.topicId);
    return id;
  }

  private entryRow(id: number): Entry {
    return this.mapEntry(this.get<Row>("SELECT * FROM entry WHERE id = ?", id));
  }

  private mapEntry(row: Row | undefined): Entry {
    const e = camel<Entry & { data: string | null; refs: string | null }>(row);
    return {
      ...e,
      data: e.data === null ? null : JSON.parse(e.data),
      refs: e.refs === null ? [] : (JSON.parse(e.refs) as Ref[]),
    };
  }

  listEntries(topic: TopicRef): Entry[] {
    const t = this.topicRow(topic);
    return this.all<Row>("SELECT * FROM entry WHERE topic_id = ? ORDER BY id", t.id).map((r) =>
      this.mapEntry(r),
    );
  }

  /** Hard delete (for example a leaked secret). Owner only; entries are otherwise never changed. */
  deleteEntry(id: number, actor: Actor): void {
    ownerOnly(actor, "delete an entry");
    this.tx(() => {
      if (!this.get("SELECT 1 FROM entry WHERE id = ?", id)) {
        throw new AxiomError("not-found", `entry not found: ${id}`);
      }
      this.run("DELETE FROM entry WHERE id = ?", id);
    });
  }

  // ---- notifications ------------------------------------------------------

  private insertNotification(
    topicId: number,
    threadId: number | null,
    kind: NotificationKind,
    body: string | null,
  ): number {
    parseWith(notificationKindSchema, kind, "notification kind");
    return this.run(
      "INSERT INTO notification (topic_id, thread_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)",
      topicId,
      threadId,
      kind,
      body,
      this.iso(),
    );
  }

  /** For connectors (monitor problem, Jira changed, PR review). */
  raiseNotification(
    topic: TopicRef,
    kind: NotificationKind,
    body: string | null,
    _actor: Actor,
  ): number {
    return this.tx(() => this.insertNotification(this.topicRow(topic).id, null, kind, body));
  }

  /** The notifications pane: hides muted kinds and muted topics. Dismissed ones only on request. */
  listNotifications(options: ListNotificationsOptions = {}): Notification[] {
    const mutedKinds = new Set<string>(this.getSetting("mutedKinds") as string[]);
    return this.all<Row>(
      `SELECT notification.*, topic.slug AS topic_slug FROM notification
       JOIN topic ON topic.id = notification.topic_id
       WHERE topic.muted = 0 ${options.includeDismissed ? "" : "AND notification.dismissed_at IS NULL"}
       ORDER BY notification.id DESC`,
    )
      .map((r) => camel<Notification>(r))
      .filter((n) => !mutedKinds.has(n.kind));
  }

  /** Highlighted = any undismissed notification. Muting never hides this. */
  isHighlighted(topic: TopicRef): boolean {
    const id = typeof topic === "number" ? topic : this.topicRow(topic).id;
    return !!this.get(
      "SELECT 1 FROM notification WHERE topic_id = ? AND dismissed_at IS NULL LIMIT 1",
      id,
    );
  }

  // ---- stale prompts ------------------------------------------------------

  /** Creates a `stale prompt` notification for each idle topic untouched for N days. */
  refreshStalePrompts(now: Date = this.clock()): number[] {
    const days = this.getSetting("staleAfterDays") as number;
    const cutoff = staleCutoff(now, days);
    return this.tx(() => {
      const created: number[] = [];
      const candidates = this.all<Row>(
        "SELECT * FROM topic WHERE status = 'idle' AND stale_prompt_dismissed = 0 AND last_worked_at < ?",
        cutoff,
      ).map((r) => camel<Topic>(r));
      for (const t of candidates) {
        const open = !!this.get(
          "SELECT 1 FROM notification WHERE topic_id = ? AND kind = 'stale prompt' AND dismissed_at IS NULL",
          t.id,
        );
        if (
          needsStalePrompt({
            status: t.status,
            lastWorkedAt: t.lastWorkedAt,
            stalePromptDismissed: t.stalePromptDismissed,
            hasOpenStalePrompt: open,
            now,
            staleAfterDays: days,
          })
        ) {
          created.push(
            this.insertNotification(
              t.id,
              null,
              "stale prompt",
              `Idle for more than ${days} days: mark as stale?`,
            ),
          );
        }
      }
      return created;
    });
  }

  markStale(topic: TopicRef, actor: Actor): Topic {
    ownerOnly(actor, "mark a topic stale");
    return this.tx(() => {
      const t = this.topicRow(topic);
      this.applyTopicStatus(t, "stale", "marked stale by the owner", null);
      this.dismissStaleNotifications(t.id);
      return this.topicRow(t.id);
    });
  }

  /** The prompt never comes back for this topic. */
  dismissStalePrompt(topic: TopicRef, actor: Actor): void {
    ownerOnly(actor, "dismiss a stale prompt");
    this.tx(() => {
      const t = this.topicRow(topic);
      this.run("UPDATE topic SET stale_prompt_dismissed = 1 WHERE id = ?", t.id);
      this.dismissStaleNotifications(t.id);
    });
  }

  private dismissStaleNotifications(topicId: number): void {
    this.run(
      `UPDATE notification SET dismissed_at = ?
       WHERE topic_id = ? AND kind = 'stale prompt' AND dismissed_at IS NULL`,
      this.iso(),
      topicId,
    );
  }

  // ---- settings -----------------------------------------------------------

  getSetting(key: string): unknown {
    const row = this.get<{ value: string }>("SELECT value FROM setting WHERE key = ?", key);
    if (row) return JSON.parse(row.value);
    if (key === "mutedKinds") return [];
    if (key === "staleAfterDays") return DEFAULT_STALE_AFTER_DAYS;
    if (key === "summaries") return { enabled: true };
    if (key === "t3Pin") return { ...DEFAULT_T3_PIN };
    return undefined;
  }

  setSetting(key: string, value: unknown, actor: Actor): void {
    ownerOnly(actor, "change settings");
    const schema = (settingSchemas as Record<string, z.ZodType>)[key];
    const checked = schema ? parseWith(schema, value, `setting ${key}`) : value;
    if (checked === undefined) throw new AxiomError("validation", "setting value is required");
    this.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(checked),
    );
  }
}
