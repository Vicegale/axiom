import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { z } from "zod";
import { oneLine } from "./activity.js";
import {
  type Actor,
  DEFAULT_APPROVAL_TIMEOUT_SEC,
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_T3_PIN,
  type Effort,
  type EntryKind,
  type LinkKind,
  type MonitorState,
  type NotificationKind,
  type Provider,
  STEWARD_ACTION_KINDS,
  STEWARD_SETTING_KEY,
  STEWARD_STAGES,
  type StewardActionKind,
  type StewardAttachedKind,
  type StewardComplexity,
  type StewardItemKind,
  type StewardItemState,
  type StewardLevel,
  type StewardMemoryScope,
  type StewardMemorySource,
  type StewardMessageRole,
  type StewardStage,
  type StewardStatus,
  type StewardSuggestionKind,
  type StewardWakeTrigger,
  SUBAGENT_KEEP_MS,
  type TaskStatus,
  type TopicStatus,
  type View,
  type WorkItemStatus,
} from "./constants.js";
import { AxiomError } from "./errors.js";
import {
  cleanSuggestions,
  describePermissionUpdate,
  type PermissionUpdate,
  updatesToApply,
} from "./permissions.js";
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
  DEFAULT_STEWARD_SETTINGS,
  effortSchema,
  entryDataSchemas,
  jiraSchema,
  linkKindSchema,
  monitorStateSchema,
  notificationKindSchema,
  parseWith,
  providerSchema,
  refsSchema,
  type StewardSettings,
  settingSchemas,
  slugSchema,
  stewardAttachedKindSchema,
  stewardComplexitySchema,
  stewardItemKindSchema,
  stewardItemStateSchema,
  stewardLevelSchema,
  stewardMemoryScopeSchema,
  stewardMemorySourceSchema,
  stewardMessageRoleSchema,
  stewardSuggestionKindSchema,
  stewardWakeTriggerSchema,
  taskKeySchema,
  taskStatusSchema,
  topicStatusSchema,
  workItemStatusSchema,
} from "./schemas.js";
import { countTokens, localDay, localDayRange, mergeDefaults, modelFamily } from "./steward.js";
import type {
  Approval,
  Entry,
  Epic,
  Link,
  MonitorTarget,
  Notification,
  Ref,
  RuntimePatch,
  StewardAction,
  StewardBlindSpot,
  StewardCapCheck,
  StewardChat,
  StewardFamilyUsage,
  StewardItem,
  StewardItemWithFix,
  StewardMemory,
  StewardMessage,
  StewardMessageMeta,
  StewardModelUsage,
  StewardPrRecord,
  StewardRequest,
  StewardRun,
  StewardServerBeat,
  StewardSuggestion,
  StewardWake,
  Subagent,
  SubagentSnapshot,
  SubagentStatus,
  Task,
  TaskDetail,
  Thread,
  ThreadStop,
  Ticket,
  TokenCounts,
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
  "steward_enabled",
]);

/** The owner writes memory items up to this long (Steward writes shorter ones). */
export const OWNER_MEMORY_TEXT_MAX = 2000;

/** A check of one topic may be asked for this often (ST10). */
export const STEWARD_CHECK_INTERVAL_MS = 10 * 60_000;

/** The longest reply kept on a thread, in characters. */
export const MAX_REPLY_CHARS = 200_000;

/** The longest activity line kept on a thread, in characters. */
export const MAX_ACTIVITY_CHARS = 300;
const MAX_SUBAGENT_TITLE_CHARS = 200;
const MAX_SUBAGENT_TYPE_CHARS = 80;
/** How long an announced Agent/Task call waits for its subagent to start. */
const QUEUED_CALL_TTL_MS = 30 * 60 * 1000;

function camel<T>(row: Row | undefined): T {
  if (!row) throw new AxiomError("not-found", "row not found");
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[name] = BOOLEAN_COLUMNS.has(key) ? value === 1 : value;
  }
  return out as T;
}

/** An `approval` row, with its JSON columns parsed (a damaged value reads as empty). */
function approvalFromRow(row: Row): Approval {
  const { suggestions, applied, ...rest } = row;
  const json = (v: unknown): unknown => {
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const done = json(applied);
  return {
    ...camel<Omit<Approval, "suggestions" | "applied">>(rest),
    suggestions: cleanSuggestions(json(suggestions)),
    applied: Array.isArray(done) ? cleanSuggestions(done) : null,
  };
}

function messageOf(row: Row | undefined): StewardMessage {
  const m = camel<Omit<StewardMessage, "meta"> & { meta: string | null }>(row);
  let meta: StewardMessageMeta | null = null;
  if (m.meta) {
    try {
      meta = JSON.parse(m.meta) as StewardMessageMeta;
    } catch {
      meta = null;
    }
  }
  return { ...m, meta };
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

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface StewardWakeFinish {
  status: Exclude<StewardStatus, "running">;
  brief?: string;
  /** Left as stored when absent. */
  blindSpots?: StewardBlindSpot[];
  gathered?: unknown;
  error?: string;
}

export interface StewardRunInput {
  /** Exactly one of `wakeId` and `chatId`. */
  wakeId?: number;
  chatId?: number;
  stage: StewardStage;
  model: string;
  effort: Effort;
  startedAt?: string;
  usage?: TokenCounts;
  error?: string;
}

export interface StewardRunFinish {
  status: Exclude<StewardStatus, "running">;
  error?: string;
  /** The model that actually answered, when it differs from the one asked for. */
  model?: string;
  usage?: TokenCounts;
}

export interface StewardItemInput {
  kind: StewardItemKind;
  title: string;
  wakeId?: number;
  topic?: TopicRef;
  level?: StewardLevel;
  body?: string;
  signal?: string;
  source?: string;
  fingerprint?: string;
  entryId?: number;
  parentItemId?: number;
  promotion?: StewardComplexity;
}

export interface StewardMemoryInput {
  scope: StewardMemoryScope;
  attachedKind?: StewardAttachedKind;
  attachedKey?: string;
  text: string;
  /** Ignored when the owner writes: that is always `owner`. */
  source?: StewardMemorySource;
}

export interface ListStewardMemoryOptions {
  scope?: StewardMemoryScope;
  attachedKind?: StewardAttachedKind;
  attachedKey?: string;
  includeRetired?: boolean;
}

/** An item with its topic's slug. */
const ITEM_SELECT = `SELECT steward_item.*, topic.slug AS topic_slug FROM steward_item
  LEFT JOIN topic ON topic.id = steward_item.topic_id`;

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

  /** Runs a statement and returns how many rows it changed. */
  private change(sql: string, ...params: unknown[]): number {
    return Number(this.stmt(sql).run(...(params as SQLInputValue[])).changes);
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
      this.applyTopicStatus(t, parsed, reason, threadId, actor.kind === "steward");
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

  /**
   * Writes the new status (and a `status change` entry) if it differs from the current one.
   * Returns the entry's id, or null when nothing changed. A change by Steward is marked as its own:
   * the entry's author is `steward` and its data says `by: "steward"` (03, Tidying).
   */
  private applyTopicStatus(
    t: Topic,
    to: TopicStatus | null,
    reason: string | undefined,
    threadId: number | null,
    bySteward = false,
  ): number | null {
    if (t.status === to) return null;
    this.run("UPDATE topic SET status = ? WHERE id = ?", to, t.id);
    return this.insertEntry({
      topicId: t.id,
      author: bySteward ? "steward" : "axiom",
      threadId,
      kind: "status change",
      body: `${t.status ?? "none"} -> ${to ?? "none"}${reason ? `: ${reason}` : ""}`,
      data: {
        from: t.status,
        to,
        ...(reason ? { reason } : {}),
        ...(bySteward ? { by: "steward" } : {}),
      },
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

  /**
   * Changes a link's target, label and/or description; an empty string clears a label or
   * description. A repository or worktree target must be an existing folder (`~` is expanded).
   */
  updateLink(
    topic: TopicRef,
    linkId: number,
    changes: { target?: string; label?: string; description?: string },
    _actor: Actor,
  ): Link {
    const label =
      changes.label === undefined ? undefined : linkText(changes.label, "label", LINK_LABEL_MAX);
    const description =
      changes.description === undefined
        ? undefined
        : linkText(changes.description, "description", LINK_DESCRIPTION_MAX);
    if (changes.target !== undefined && !changes.target.trim()) {
      throw new AxiomError("validation", "link target is required");
    }
    return this.tx(() => {
      const t = this.topicRow(topic);
      const row = this.get<Row>("SELECT * FROM link WHERE id = ? AND topic_id = ?", linkId, t.id);
      if (!row) throw new AxiomError("not-found", `link not found: ${linkId}`);
      let target: string | undefined;
      if (changes.target !== undefined) {
        target = changes.target.trim();
        if (row.kind === "repository" || row.kind === "worktree") {
          if (target === "~") target = homedir();
          else if (target.startsWith("~/")) target = join(homedir(), target.slice(2));
          if (target.length > 1) target = target.replace(/\/+$/, "");
          let ok = false;
          try {
            ok = target.startsWith("/") && statSync(target).isDirectory();
          } catch {
            ok = false;
          }
          if (!ok) throw new AxiomError("validation", `folder not found: ${target}`);
        }
      }
      this.run(
        "UPDATE link SET target = ?, label = ?, description = ? WHERE id = ?",
        target === undefined ? (row.target as string) : target,
        label === undefined ? (row.label as string | null) : label,
        description === undefined ? (row.description as string | null) : description,
        linkId,
      );
      if (target !== undefined || label !== undefined || description !== undefined) {
        this.touchTopic(t.id);
      }
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

  /**
   * How many background commands (shells, monitors; not subagents) were still running when the
   * thread last stopped. A stop with any is `monitoring`, not `idle` (01, "When an agent stops").
   * Kept as a setting, like the subagent count.
   */
  setRunningCommands(threadId: number, count: number): void {
    const key = `commands:${threadId}`;
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

  runningCommands(threadId: number): number {
    const v = this.getSetting(`commands:${threadId}`);
    return typeof v === "number" ? v : 0;
  }

  /**
   * True when an open thread of the topic is `monitoring` because it waits on its own background
   * commands: the topic needs no monitor target for that, and Steward leaves it alone.
   */
  topicWaitsOnCommands(topic: TopicRef): boolean {
    const t = this.topicRow(topic);
    return !!this.get(
      `SELECT 1 FROM thread JOIN setting ON setting.key = 'commands:' || thread.id
       WHERE thread.topic_id = ? AND thread.ended_at IS NULL AND thread.status = 'monitoring'`,
      t.id,
    );
  }

  /**
   * A T3 thread's hook reported running commands after the T3 sync had already stopped the thread
   * as `idle`: it is monitoring them. Does nothing otherwise. No notification: the stop raised it.
   */
  threadWaitingOnCommands(threadId: number): Thread {
    return this.tx(() => {
      const th = this.threadRow(threadId);
      const n = this.runningCommands(threadId);
      if (th.endedAt !== null || th.status !== "idle" || n === 0) return th;
      this.run(
        `UPDATE thread SET status = 'monitoring', status_changed_at = ?,
           status_changed_seq = (SELECT COALESCE(MAX(status_changed_seq), 0) + 1 FROM thread)
         WHERE id = ?`,
        this.iso(),
        threadId,
      );
      this.insertEntry({
        topicId: th.topicId,
        author: "axiom",
        threadId,
        kind: "thread event",
        body: `Waiting on ${commandCount(n)}`,
        data: {
          event: "waiting on commands",
          commands: n,
          provider: th.provider,
          providerThreadId: th.providerThreadId,
        },
      });
      this.recomputeFromThreads(this.topicRow(th.topicId), "thread waiting on commands", threadId);
      return this.threadRow(threadId);
    });
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

  /**
   * Stores what a thread runs on: model, effort, context used / window size. Only the keys given
   * change, and nothing is written when they already hold those values (so a poll that sees
   * nothing new makes no noise). Ephemeral: never a history entry. Returns whether anything
   * changed.
   */
  setThreadRuntime(threadId: number, patch: RuntimePatch, at?: string): boolean {
    const row = this.threadRow(threadId);
    const columns: Record<keyof RuntimePatch, string> = {
      model: "model",
      effort: "effort",
      contextUsed: "context_used",
      contextMax: "context_max",
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(columns) as (keyof RuntimePatch)[]) {
      const next = patch[key];
      if (next === undefined) continue;
      const value = typeof next === "string" ? next.trim() || null : next;
      if ((row[key] ?? null) === value) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return false;
    this.run(
      `UPDATE thread SET ${sets.join(", ")}, runtime_at = ? WHERE id = ?`,
      ...values,
      at ?? this.iso(),
      threadId,
    );
    return true;
  }

  // ---- the subagent tree of the current turn (02, D11, D12) ------------------

  /**
   * Claude Code announced an Agent/Task tool call (PreToolUse). `SubagentStart` has no description,
   * so the call waits here until the subagent of its type starts and takes its title. `parentKey`
   * is the subagent that made the call (the hook payload's `agent_id` inside a subagent), absent
   * when the thread did. Calls older than `QUEUED_CALL_TTL_MS` (denied, never started) are dropped.
   */
  queueSubagentCall(
    threadId: number,
    call: { title?: string | null; agentType: string; parentKey?: string | null },
  ): void {
    const now = this.clock();
    this.run(
      "DELETE FROM subagent_call WHERE thread_id = ? AND created_at < ?",
      threadId,
      new Date(now.getTime() - QUEUED_CALL_TTL_MS).toISOString(),
    );
    this.run(
      `INSERT INTO subagent_call (thread_id, title, agent_type, created_at, parent_key)
       VALUES (?, ?, ?, ?, ?)`,
      threadId,
      call.title ? oneLine(call.title, MAX_SUBAGENT_TITLE_CHARS) || null : null,
      oneLine(call.agentType, MAX_SUBAGENT_TYPE_CHARS) || "general-purpose",
      now.toISOString(),
      call.parentKey ? oneLine(call.parentKey, MAX_SUBAGENT_TYPE_CHARS) || null : null,
    );
  }

  /**
   * A subagent started (`SubagentStart`). Titled, and placed under its parent, from the oldest
   * queued call of its type, which it uses up. Seeing the same `key` again changes nothing.
   * Returns whether a row was added.
   */
  subagentStarted(threadId: number, key: string, agentType?: string | null): boolean {
    return this.tx(() => {
      if (this.get("SELECT 1 FROM subagent WHERE thread_id = ? AND key = ?", threadId, key)) {
        return false;
      }
      const type = agentType ? oneLine(agentType, MAX_SUBAGENT_TYPE_CHARS) || null : null;
      const call = this.get<{ id: number; title: string | null; parentKey: string | null }>(
        `SELECT id, title, parent_key AS parentKey FROM subagent_call
         WHERE thread_id = ? AND agent_type = ? ORDER BY id LIMIT 1`,
        threadId,
        type ?? "general-purpose",
      );
      if (call) this.run("DELETE FROM subagent_call WHERE id = ?", call.id);
      this.run(
        `INSERT INTO subagent (thread_id, key, title, agent_type, started_at, parent_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        threadId,
        key,
        call?.title ?? null,
        type,
        this.iso(),
        call?.parentKey && call.parentKey !== key ? call.parentKey : null,
      );
      return true;
    });
  }

  /** A running subagent stopped (`SubagentStop`): it is done, and stays listed. Returns whether it was running. */
  subagentStopped(threadId: number, key: string): boolean {
    return this.finishSubagents(threadId, "done", (k) => k === key) > 0;
  }

  /** Marks the thread's running subagents `status` when `pick` takes their key. Returns how many. */
  private finishSubagents(
    threadId: number,
    status: Exclude<SubagentStatus, "running">,
    pick: (key: string) => boolean,
  ): number {
    return this.tx(() => {
      let n = 0;
      const at = this.iso();
      for (const r of this.all<{ key: string }>(
        "SELECT key FROM subagent WHERE thread_id = ? AND status = 'running'",
        threadId,
      )) {
        if (!pick(r.key)) continue;
        n += this.change(
          "UPDATE subagent SET status = ?, ended_at = ? WHERE thread_id = ? AND key = ?",
          status,
          at,
          threadId,
          r.key,
        );
      }
      return n;
    });
  }

  /**
   * The parent's Stop lists the subagents still running (`background_tasks`: the ids are the
   * subagents' `agent_id`s, and `description` names one that has no title yet). Running rows not
   * listed are done. Queued calls that never started are dropped. Returns whether a row changed.
   */
  keepSubagents(
    threadId: number,
    running: readonly { key: string; title?: string | null }[],
  ): boolean {
    return this.tx(() => {
      this.run("DELETE FROM subagent_call WHERE thread_id = ?", threadId);
      const keys = new Set(running.map((r) => r.key));
      let changed = this.finishSubagents(threadId, "done", (k) => !keys.has(k)) > 0;
      for (const r of running) {
        const title = r.title ? oneLine(r.title, MAX_SUBAGENT_TITLE_CHARS) || null : null;
        if (!title) continue;
        changed =
          this.change(
            "UPDATE subagent SET title = ? WHERE thread_id = ? AND key = ? AND title IS NULL",
            title,
            threadId,
            r.key,
          ) > 0 || changed;
      }
      return changed;
    });
  }

  /**
   * A new turn starts: queued calls go, and so do finished subagents older than SUBAGENT_KEEP_MS.
   * Recently finished ones stay in the tree across turns (owner, 2026-11-25); running ones always
   * stay (a background subagent outlives the turn that started it). Returns whether a row went.
   */
  startSubagentTurn(threadId: number): boolean {
    this.run("DELETE FROM subagent_call WHERE thread_id = ?", threadId);
    return (
      this.change(
        "DELETE FROM subagent WHERE thread_id = ? AND status <> 'running' AND ended_at < ?",
        threadId,
        this.subagentCutoff(),
      ) > 0
    );
  }

  /** Finished subagents that ended before this stay out of the tree. */
  private subagentCutoff(): string {
    return new Date(this.clock().getTime() - SUBAGENT_KEEP_MS).toISOString();
  }

  /** The session ended: whatever still ran is cancelled, and queued calls are dropped. */
  cancelSubagents(threadId: number): boolean {
    this.run("DELETE FROM subagent_call WHERE thread_id = ?", threadId);
    return this.finishSubagents(threadId, "cancelled", () => true) > 0;
  }

  /** Forgets the thread's subagents and queued calls (a new session). Returns whether a row went. */
  clearSubagents(threadId: number): boolean {
    this.run("DELETE FROM subagent_call WHERE thread_id = ?", threadId);
    return this.change("DELETE FROM subagent WHERE thread_id = ?", threadId) > 0;
  }

  /**
   * Every thread's running subagents and those that finished within SUBAGENT_KEEP_MS, oldest
   * first, by thread id (for the Desk).
   */
  listSubagents(): Map<number, Subagent[]> {
    const out = new Map<number, Subagent[]>();
    const rows = this.all<Row>(
      `SELECT * FROM subagent WHERE status = 'running' OR ended_at IS NULL OR ended_at >= ?
       ORDER BY started_at, id`,
      this.subagentCutoff(),
    );
    for (const r of rows) {
      const s = camel<Subagent>(r);
      const list = out.get(s.threadId);
      if (list) list.push(s);
      else out.set(s.threadId, [s]);
    }
    return out;
  }

  /**
   * Makes the thread's subagent rows match what the provider reports now (T3 sync, the newest
   * run's): adds, updates and removes, writing only differences. Returns whether anything changed.
   */
  setSubagents(threadId: number, now: readonly SubagentSnapshot[]): boolean {
    return this.tx(() => {
      const have = new Map(
        this.all<Row>("SELECT * FROM subagent WHERE thread_id = ?", threadId).map((r) => {
          const s = camel<Subagent>(r);
          return [s.key, s] as const;
        }),
      );
      let changed = false;
      const text = (v: string | null, max: number) => (v ? oneLine(v, max) || null : null);
      const seen = new Set<string>();
      for (const n of now) {
        if (seen.has(n.key)) continue;
        seen.add(n.key);
        const next = {
          title: text(n.title, MAX_SUBAGENT_TITLE_CHARS),
          agentType: text(n.agentType, MAX_SUBAGENT_TYPE_CHARS),
          model: text(n.model, MAX_SUBAGENT_TYPE_CHARS),
          progress: text(n.progress, MAX_ACTIVITY_CHARS),
          status: n.status,
          startedAt: n.startedAt,
          endedAt: n.status === "running" ? null : (n.endedAt ?? n.startedAt),
          parentKey: n.parentKey && n.parentKey !== n.key ? n.parentKey : null,
        };
        const cur = have.get(n.key);
        if (!cur) {
          this.run(
            `INSERT INTO subagent
               (thread_id, key, title, agent_type, model, progress, status, started_at, ended_at, parent_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            threadId,
            n.key,
            next.title,
            next.agentType,
            next.model,
            next.progress,
            next.status,
            next.startedAt,
            next.endedAt,
            next.parentKey,
          );
          changed = true;
        } else if (
          cur.title !== next.title ||
          cur.agentType !== next.agentType ||
          cur.model !== next.model ||
          cur.progress !== next.progress ||
          cur.status !== next.status ||
          cur.startedAt !== next.startedAt ||
          cur.endedAt !== next.endedAt ||
          cur.parentKey !== next.parentKey
        ) {
          this.run(
            `UPDATE subagent SET title = ?, agent_type = ?, model = ?, progress = ?, status = ?,
               started_at = ?, ended_at = ?, parent_key = ?
             WHERE id = ?`,
            next.title,
            next.agentType,
            next.model,
            next.progress,
            next.status,
            next.startedAt,
            next.endedAt,
            next.parentKey,
            cur.id,
          );
          changed = true;
        }
      }
      for (const [key] of have) {
        if (seen.has(key)) continue;
        this.run("DELETE FROM subagent WHERE thread_id = ? AND key = ?", threadId, key);
        changed = true;
      }
      return changed;
    });
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

  // ---- permission approvals (02, D5) ---------------------------------------

  /**
   * A Claude Code `PermissionRequest` hook asks the owner. Records a pending approval, marks the
   * thread waiting on the owner (notification `agent asked`) and returns the approval. The
   * summary is one short line (`describeToolUse`); the full tool input is never stored.
   */
  requestApproval(
    threadId: number,
    input: {
      toolName: string;
      inputSummary: string;
      hookPid?: number;
      /** Claude Code's `permission_suggestions`, untrusted; cleaned before they are stored. */
      suggestions?: unknown;
    },
  ): Approval {
    const toolName = oneLine(input.toolName, 100) || "tool";
    const summary = oneLine(input.inputSummary, MAX_ACTIVITY_CHARS) || toolName;
    const suggestions = cleanSuggestions(input.suggestions);
    return this.tx(() => {
      const id = this.run(
        `INSERT INTO approval (thread_id, tool_name, input_summary, created_at, hook_pid, suggestions)
         VALUES (?, ?, ?, ?, ?, ?)`,
        threadId,
        toolName,
        summary,
        this.iso(),
        input.hookPid ?? null,
        suggestions.length > 0 ? JSON.stringify(suggestions) : null,
      );
      this.threadWaitingOnOwner(threadId, `Permission to use ${toolName}: ${summary}`);
      return this.approvalRow(id);
    });
  }

  private approvalRow(id: number): Approval {
    const row = this.get<Row>("SELECT * FROM approval WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `approval not found: ${id}`);
    return approvalFromRow(row);
  }

  getApproval(id: number): Approval {
    return this.approvalRow(id);
  }

  /** The thread's approvals nobody has decided yet, oldest first. */
  pendingApprovals(threadId: number): Approval[] {
    return this.all<Row>(
      "SELECT * FROM approval WHERE thread_id = ? AND decided_at IS NULL ORDER BY id",
      threadId,
    ).map(approvalFromRow);
  }

  /** Pending approvals per thread id (for the Desk's counts). */
  pendingApprovalCounts(): Map<number, number> {
    const rows = this.all<{ thread_id: number; n: number }>(
      "SELECT thread_id, COUNT(*) AS n FROM approval WHERE decided_at IS NULL GROUP BY thread_id",
    );
    return new Map(rows.map((r) => [r.thread_id, r.n]));
  }

  /**
   * The owner's decision. Writes the history entry (`authorization` for allow, `owner input` for
   * deny); the waiting hook picks the decision up and moves the thread back to working. With
   * `options.suggestion` (an index into the approval's `suggestions`), the allow also sends that
   * "don't ask again" choice to Claude Code, and the authorization is standing. Throws `conflict`
   * when the approval was already decided or expired, `validation` for a bad suggestion.
   */
  decideApproval(
    id: number,
    decision: "allow" | "deny",
    message: string | undefined,
    actor: Actor,
    options: { suggestion?: number } = {},
  ): Approval {
    ownerOnly(actor, "decide an approval");
    return this.tx(() => {
      const a = this.approvalRow(id);
      if (a.decidedAt !== null) {
        throw new AxiomError("conflict", "this approval was already decided or has expired");
      }
      let choice: PermissionUpdate | undefined;
      if (options.suggestion !== undefined) {
        if (decision !== "allow") {
          throw new AxiomError("validation", "only an allow can carry a permission rule");
        }
        choice = a.suggestions[options.suggestion];
        if (!choice) {
          throw new AxiomError("validation", `no such suggestion: ${options.suggestion}`);
        }
      }
      const note = message?.trim() ? oneLine(message, 500) : null;
      this.run(
        "UPDATE approval SET decided_at = ?, decision = ?, message = ?, applied = ? WHERE id = ?",
        this.iso(),
        decision,
        note,
        choice ? JSON.stringify(updatesToApply(choice)) : null,
        id,
      );
      const th = this.threadRow(a.threadId);
      const what = `${a.toolName}: ${a.inputSummary}`;
      if (decision === "allow" && choice) {
        const rule = describePermissionUpdate(choice);
        this.addEntry(
          th.topicId,
          {
            kind: "authorization",
            body: `Allowed ${what}, and: ${rule}`,
            data: { scope: rule, standing: true },
          },
          actor,
        );
      } else if (decision === "allow") {
        this.addEntry(
          th.topicId,
          {
            kind: "authorization",
            body: `Allowed ${what}`,
            data: { scope: what, standing: false },
          },
          actor,
        );
      } else {
        this.addEntry(
          th.topicId,
          { kind: "owner input", body: `Denied ${what}${note ? `: ${note}` : ""}` },
          actor,
        );
      }
      return this.approvalRow(id);
    });
  }

  /** The hook gave up (timeout, cancelled, error, process gone). A decided approval is kept. */
  expireApproval(id: number): void {
    this.run(
      "UPDATE approval SET decided_at = ?, decision = 'expired' WHERE id = ? AND decided_at IS NULL",
      this.iso(),
      id,
    );
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
      // The next stop reports whatever commands are still running then.
      this.setRunningCommands(threadId, 0);
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
    const n = this.runningCommands(threadId);
    return this.threadEvent(threadId, {
      event: "stopped",
      body: n > 0 ? `Thread stopped, waiting on ${commandCount(n)}` : "Thread stopped",
      data: n > 0 ? { commands: n } : undefined,
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
      // A thread that ends while still running (killed, crashed session) is no longer working,
      // and the background commands it was monitoring end with its session.
      const live =
        th.endedAt === null &&
        (th.status === "wip" || (th.status === "monitoring" && this.runningCommands(threadId) > 0));
      if (th.endedAt === null) {
        this.run(
          "UPDATE thread SET ended_at = ?, end_reason = ? WHERE id = ?",
          this.iso(),
          reason ?? null,
          threadId,
        );
        this.cancelSubagents(threadId);
        this.setRunningCommands(threadId, 0);
        if (live) {
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
      // Only a thread that was still live changes the topic; otherwise a session ending would
      // overwrite a status set by hand (for example the owner marking the topic done).
      if (live) this.recomputeFromThreads(this.topicRow(th.topicId), "thread ended", threadId);
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
      /** Extra fields for the entry's data. */
      data?: Record<string, unknown>;
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
          runningCommands: this.runningCommands(threadId),
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
        data: {
          event: ev.event,
          ...ev.data,
          provider: th.provider,
          providerThreadId: th.providerThreadId,
        },
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

  // ---- Steward (spec 03, 05) ----------------------------------------------

  /** Steward's bookkeeping is written by Steward, Axiom's server or the owner; never by an agent. */
  private stewardWriter(actor: Actor, what: string): void {
    if (actor.kind === "agent") throw new AxiomError("permission", `an agent cannot ${what}`);
  }

  /** The per-topic switch: off means Steward neither watches nor acts on the topic. */
  setTopicStewardEnabled(ref: TopicRef, enabled: boolean, actor: Actor): Topic {
    ownerOnly(actor, "switch Steward on or off for a topic");
    return this.tx(() => {
      const t = this.topicRow(ref);
      this.run("UPDATE topic SET steward_enabled = ? WHERE id = ?", enabled ? 1 : 0, t.id);
      return this.topicRow(t.id);
    });
  }

  getTopicStewardEnabled(ref: TopicRef): boolean {
    return this.topicRow(ref).stewardEnabled;
  }

  /** Steward's settings: the defaults with the stored values laid over them. */
  getStewardSettings(): StewardSettings {
    const stored = this.get<{ value: string }>(
      "SELECT value FROM setting WHERE key = ?",
      STEWARD_SETTING_KEY,
    );
    return mergeDefaults(DEFAULT_STEWARD_SETTINGS, stored ? JSON.parse(stored.value) : undefined);
  }

  /** Lays `changes` over the current settings, validates the whole and stores it. Owner only. */
  setStewardSettings(changes: DeepPartial<StewardSettings>, actor: Actor): StewardSettings {
    ownerOnly(actor, "change Steward's settings");
    const merged = mergeDefaults(this.getStewardSettings(), changes);
    this.setSetting(STEWARD_SETTING_KEY, merged, actor);
    return this.getStewardSettings();
  }

  // -- wakes

  private wakeRow(id: number): StewardWake {
    const row = this.get<Row>("SELECT * FROM steward_wake WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `Steward wake not found: ${id}`);
    const w = camel<StewardWake & { blindSpots: string | null; gathered: string | null }>(row);
    return {
      ...w,
      blindSpots: w.blindSpots === null ? [] : (JSON.parse(w.blindSpots) as StewardBlindSpot[]),
      gathered: w.gathered === null ? null : JSON.parse(w.gathered),
    };
  }

  startStewardWake(
    input: { trigger: StewardWakeTrigger; triggerDetail?: string; lookBackFrom?: string },
    actor: Actor,
  ): StewardWake {
    this.stewardWriter(actor, "start a wake");
    parseWith(stewardWakeTriggerSchema, input.trigger, "wake trigger");
    return this.tx(() =>
      this.wakeRow(
        this.run(
          `INSERT INTO steward_wake (trigger, trigger_detail, started_at, status, look_back_from)
           VALUES (?, ?, ?, 'running', ?)`,
          input.trigger,
          input.triggerDetail ?? null,
          this.iso(),
          input.lookBackFrom ?? null,
        ),
      ),
    );
  }

  finishStewardWake(id: number, input: StewardWakeFinish, actor: Actor): StewardWake {
    this.stewardWriter(actor, "finish a wake");
    return this.tx(() => {
      const w = this.wakeRow(id);
      if (w.status !== "running") {
        throw new AxiomError("conflict", `Steward wake ${id} is already ${w.status}`);
      }
      this.run(
        `UPDATE steward_wake SET status = ?, ended_at = ?, brief = COALESCE(?, brief),
           blind_spots = COALESCE(?, blind_spots), gathered = COALESCE(?, gathered), error = ?
         WHERE id = ?`,
        input.status,
        this.iso(),
        input.brief ?? null,
        input.blindSpots ? JSON.stringify(input.blindSpots) : null,
        input.gathered === undefined ? null : JSON.stringify(input.gathered),
        input.error ?? null,
        id,
      );
      return this.wakeRow(id);
    });
  }

  /** Stores the blind-spot checklist of a running wake (run in code before stage 1). */
  setStewardWakeBlindSpots(id: number, spots: StewardBlindSpot[], actor: Actor): StewardWake {
    this.stewardWriter(actor, "record blind spots");
    return this.tx(() => {
      this.wakeRow(id);
      this.run("UPDATE steward_wake SET blind_spots = ? WHERE id = ?", JSON.stringify(spots), id);
      return this.wakeRow(id);
    });
  }

  /** Stores what stage 1 gathered, for stage 2 to read. */
  setStewardWakeGathered(id: number, gathered: unknown, actor: Actor): StewardWake {
    this.stewardWriter(actor, "record the gathered activity");
    return this.tx(() => {
      this.wakeRow(id);
      this.run("UPDATE steward_wake SET gathered = ? WHERE id = ?", JSON.stringify(gathered), id);
      return this.wakeRow(id);
    });
  }

  // -- scheduler state, watched PRs and stops (ST2)

  /**
   * Notes that the scheduler is alive and enabled. Returns when it has been continuously
   * enabled since: a heartbeat older than `gapMs` (or none) starts a new stretch, which is how a
   * wake knows Steward was off (or the server down) in between.
   */
  stewardHeartbeat(gapMs: number): string {
    return this.tx(() => {
      const now = this.iso();
      const get = (k: string) =>
        this.get<{ value: string }>("SELECT value FROM steward_state WHERE key = ?", k)?.value;
      const beat = get("heartbeat");
      let since = get("enabledSince");
      if (!since || !beat || Date.parse(now) - Date.parse(beat) > gapMs) since = now;
      const put = (k: string, v: string) =>
        this.run(
          "INSERT INTO steward_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          k,
          v,
        );
      put("heartbeat", now);
      put("enabledSince", since);
      return since;
    });
  }

  /** Steward is off: the next stretch of being on starts fresh (a wake then looks back 24 hours). */
  clearStewardHeartbeat(): void {
    this.run("DELETE FROM steward_state WHERE key IN ('heartbeat', 'enabledSince')");
  }

  // -- requests from the CLI (ST10) and the server's own beat

  private requestRow(id: number): StewardRequest {
    return camel<StewardRequest>(this.get<Row>("SELECT * FROM steward_request WHERE id = ?", id));
  }

  /**
   * The CLI's ask for a wake; the server runs it (the CLI never does). `run` is the owner's Run
   * now. `check` (a wake on one topic, for an agent or the owner) is refused while Steward is off,
   * for an unknown or steward-disabled topic, and when a check for the topic was asked for in the
   * last `STEWARD_CHECK_INTERVAL_MS`.
   */
  requestStewardWake(
    input: { kind: "run" | "check"; topic?: TopicRef },
    actor: Actor,
  ): StewardRequest {
    if (actor.kind !== "owner" && actor.kind !== "agent") {
      throw new AxiomError("permission", "only the owner or an agent can ask Steward for a wake");
    }
    if (input.kind === "run") {
      ownerOnly(actor, "run Steward now");
      return this.requestRow(this.insertRequest("run", null, actor));
    }
    if (input.topic === undefined) throw new AxiomError("validation", "a check needs a topic");
    return this.tx(() => {
      if (!this.getStewardSettings().enabled) {
        throw new AxiomError("conflict", "Steward is off, so it cannot check a topic now");
      }
      const t = this.topicRow(input.topic as TopicRef);
      if (!t.stewardEnabled) {
        throw new AxiomError("conflict", `Steward is switched off for ${t.slug}`);
      }
      const last = this.get<{ created_at: string }>(
        "SELECT created_at FROM steward_request WHERE kind = 'check' AND topic = ? ORDER BY id DESC LIMIT 1",
        t.slug,
      );
      if (last) {
        const next = Date.parse(last.created_at) + STEWARD_CHECK_INTERVAL_MS;
        if (next > this.clock().getTime()) {
          throw new AxiomError(
            "conflict",
            `a check of ${t.slug} was asked for at ${last.created_at}; the next one is allowed after ${new Date(next).toISOString()}`,
          );
        }
      }
      return this.requestRow(this.insertRequest("check", t.slug, actor));
    });
  }

  private insertRequest(kind: "run" | "check", topic: string | null, actor: Actor): number {
    return this.run(
      "INSERT INTO steward_request (kind, topic, requested_by, thread_id, created_at) VALUES (?, ?, ?, ?, ?)",
      kind,
      topic,
      actor.kind,
      actor.kind === "agent" ? (actor.threadId ?? null) : null,
      this.iso(),
    );
  }

  /** Requests the server has not picked up yet, oldest first. */
  listStewardRequests(filter: { pending?: boolean; limit?: number } = {}): StewardRequest[] {
    return this.all<Row>(
      `SELECT * FROM steward_request ${filter.pending ? "WHERE handled_at IS NULL" : ""}
       ORDER BY id ${filter.pending ? "" : "DESC"} LIMIT ?`,
      filter.limit ?? 100,
    ).map((r) => camel<StewardRequest>(r));
  }

  /** The server picked a request up (the first call) or learned how it ended (later calls). */
  handleStewardRequest(id: number, result: string, actor: Actor): StewardRequest {
    this.stewardWriter(actor, "handle a request");
    this.run(
      "UPDATE steward_request SET handled_at = COALESCE(handled_at, ?), result = ? WHERE id = ?",
      this.iso(),
      result,
      id,
    );
    return this.requestRow(id);
  }

  /** The scheduler says it is alive; the CLI reads this to tell whether a server is running. */
  setStewardServerBeat(beat: Omit<StewardServerBeat, "at">, actor: Actor): void {
    this.stewardWriter(actor, "record the server's beat");
    this.run(
      "INSERT INTO steward_state (key, value) VALUES ('server', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ ...beat, at: this.iso() }),
    );
  }

  clearStewardServerBeat(): void {
    this.run("DELETE FROM steward_state WHERE key = 'server'");
  }

  /** The server's last beat while it is fresh; null when no server looks to be running. */
  getStewardServerBeat(): StewardServerBeat | null {
    const row = this.get<{ value: string }>("SELECT value FROM steward_state WHERE key = 'server'");
    if (!row) return null;
    const beat = JSON.parse(row.value) as StewardServerBeat;
    return this.clock().getTime() - Date.parse(beat.at) <= beat.freshMs ? beat : null;
  }

  /** Tokens used today per model family against its cap, in the order haiku, sonnet, opus, others. */
  stewardUsageByFamily(day: string = localDay(this.clock())): StewardFamilyUsage[] {
    const caps = this.getStewardSettings().dailyCaps;
    const today = this.stewardUsageForDay(day);
    const families = new Set<string>([
      ...Object.keys(caps),
      ...today.map((u) => modelFamily(u.model)),
    ]);
    const usage = [...families].map<StewardFamilyUsage>((family) => {
      const mine = today.filter((u) => modelFamily(u.model) === family);
      return {
        family,
        models: mine.map((u) => u.model),
        runs: mine.reduce((n, u) => n + u.runs, 0),
        used: mine.reduce((n, u) => n + u.total, 0),
        cap: Object.hasOwn(caps, family) ? (caps[family] ?? null) : null,
      };
    });
    const order = ["haiku", "sonnet", "opus"];
    return usage.sort((a, b) => {
      const [x, y] = [order.indexOf(a.family), order.indexOf(b.family)];
      return (x < 0 ? 99 : x) - (y < 0 ? 99 : y) || a.family.localeCompare(b.family);
    });
  }

  /**
   * Items (open by default) with the branch of their ready fix. A prepared fix that sits inside
   * an open finding is shown on the finding, so it is not listed on its own. Most pressing first:
   * urgent and attention findings, questions, suggestions, info; newest first within each.
   */
  listStewardItemsWithFix(
    filter: { state?: StewardItemState | "all"; topic?: TopicRef; kind?: StewardItemKind } = {},
  ): StewardItemWithFix[] {
    const state = filter.state ?? "open";
    const all = this.listStewardItems({
      ...(state === "all" ? {} : { state }),
      ...(filter.topic !== undefined ? { topic: filter.topic } : {}),
    });
    const open = this.listStewardItems({ state: "open" });
    const openFindings = new Set(open.filter((i) => i.kind === "finding").map((i) => i.id));
    const branchOf = (itemId: number) => this.listStewardSuggestions(itemId)[0]?.branch ?? null;
    const rank = (i: StewardItem): number =>
      i.kind === "finding"
        ? i.level === "urgent"
          ? 0
          : i.level === "attention"
            ? 1
            : 4
        : i.kind === "question"
          ? 2
          : 3;
    return all
      .filter((i) => filter.kind === undefined || i.kind === filter.kind)
      .filter(
        (i) =>
          !(i.kind === "suggestion" && i.parentItemId !== null && openFindings.has(i.parentItemId)),
      )
      .map<StewardItemWithFix>((i) => {
        let fixBranch: string | null = null;
        if (i.kind === "suggestion") fixBranch = branchOf(i.id);
        else if (i.kind === "finding") {
          const fix = open.find((x) => x.kind === "suggestion" && x.parentItemId === i.id);
          fixBranch = fix ? branchOf(fix.id) : null;
        }
        return { ...i, fixBranch };
      })
      .sort((a, b) => rank(a) - rank(b) || b.id - a.id);
  }

  private prRecordRow(row: Row): StewardPrRecord {
    const r = camel<
      Omit<StewardPrRecord, "snapshot" | "active" | "fired"> & {
        snapshot: string;
        active: string;
        fired: string;
      }
    >(row);
    return {
      ...r,
      snapshot: JSON.parse(r.snapshot),
      active: JSON.parse(r.active) as Record<string, string>,
      fired: JSON.parse(r.fired) as StewardPrRecord["fired"],
    };
  }

  getStewardPr(repo: string, number: number): StewardPrRecord | null {
    const row = this.get<Row>(
      "SELECT * FROM steward_pr_snapshot WHERE repo = ? AND number = ?",
      repo,
      number,
    );
    return row ? this.prRecordRow(row) : null;
  }

  listStewardPrs(): StewardPrRecord[] {
    return this.all<Row>("SELECT * FROM steward_pr_snapshot ORDER BY repo, number").map((r) =>
      this.prRecordRow(r),
    );
  }

  /** Stores the latest poll of a PR (the first time creates the row, keeping `firstSeenAt`). */
  saveStewardPr(
    input: {
      repo: string;
      number: number;
      state: string;
      snapshot: unknown;
      active: Record<string, string>;
      fired: StewardPrRecord["fired"];
    },
    actor: Actor,
  ): StewardPrRecord {
    this.stewardWriter(actor, "record a PR snapshot");
    return this.tx(() => {
      const at = this.iso();
      this.run(
        `INSERT INTO steward_pr_snapshot (repo, number, state, snapshot, active, fired, first_seen_at, polled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET state = excluded.state,
           snapshot = excluded.snapshot, active = excluded.active, fired = excluded.fired,
           polled_at = excluded.polled_at`,
        input.repo,
        input.number,
        input.state,
        JSON.stringify(input.snapshot),
        JSON.stringify(input.active),
        JSON.stringify(input.fired.slice(-20)),
        at,
        at,
      );
      return this.getStewardPr(input.repo, input.number) as StewardPrRecord;
    });
  }

  /** The newest entry id (0 when there are none): the starting point for `listThreadStopsSince`. */
  lastEntryId(): number {
    return this.get<{ id: number | null }>("SELECT MAX(id) AS id FROM entry")?.id ?? 0;
  }

  /**
   * Thread stops recorded after entry `afterEntryId` (hooks and the T3 sync both write a
   * `thread event` entry with event `stopped`), with the topic's status now.
   */
  listThreadStopsSince(afterEntryId: number): ThreadStop[] {
    return this.all<Row>(
      `SELECT entry.id AS entry_id, entry.at, entry.thread_id, topic.id AS topic_id,
              topic.slug AS topic_slug, topic.status AS topic_status,
              topic.steward_enabled AS steward_enabled,
              COALESCE(json_extract(entry.data, '$.commands'), 0) AS commands
       FROM entry JOIN topic ON topic.id = entry.topic_id
       WHERE entry.id > ? AND entry.kind = 'thread event'
         AND json_extract(entry.data, '$.event') = 'stopped'
       ORDER BY entry.id`,
      afterEntryId,
    ).map((r) => {
      const t = camel<Omit<ThreadStop, "stewardEnabled"> & { stewardEnabled: number }>(r);
      return { ...t, stewardEnabled: !!t.stewardEnabled };
    });
  }

  /** Every link of one kind with its topic (for example all PRs Steward may watch). */
  listLinksOfKind(kind: LinkKind): (Link & { topicSlug: string })[] {
    return this.all<Row>(
      `SELECT link.*, topic.slug AS topic_slug FROM link JOIN topic ON topic.id = link.topic_id
       WHERE link.kind = ? ORDER BY link.id`,
      kind,
    ).map((r) => camel<Link & { topicSlug: string }>(r));
  }

  getStewardWake(id: number): StewardWake {
    return this.wakeRow(id);
  }

  /** The wake that is running now, if any (one wake at a time). */
  runningStewardWake(): StewardWake | null {
    const row = this.get<{ id: number }>(
      "SELECT id FROM steward_wake WHERE status = 'running' ORDER BY id DESC LIMIT 1",
    );
    return row ? this.wakeRow(row.id) : null;
  }

  /** Newest first. */
  listStewardWakes(limit = 50): StewardWake[] {
    return this.all<{ id: number }>(
      "SELECT id FROM steward_wake ORDER BY id DESC LIMIT ?",
      limit,
    ).map((r) => this.wakeRow(r.id));
  }

  // -- runs (one headless call each)

  private runRow(id: number): StewardRun {
    const row = this.get<Row>("SELECT * FROM steward_run WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `Steward run not found: ${id}`);
    return camel<StewardRun>(row);
  }

  private insertRun(input: StewardRunInput, status: StewardStatus, endedAt: string | null): number {
    if ((input.wakeId === undefined) === (input.chatId === undefined)) {
      throw new AxiomError("validation", "a run belongs to exactly one of a wake and a chat");
    }
    if (!(STEWARD_STAGES as readonly string[]).includes(input.stage)) {
      throw new AxiomError("validation", `unknown stage "${input.stage}"`);
    }
    parseWith(effortSchema, input.effort, "effort");
    return this.run(
      `INSERT INTO steward_run
         (wake_id, chat_id, stage, model, effort, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, started_at, ended_at, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.wakeId ?? null,
      input.chatId ?? null,
      input.stage,
      input.model,
      input.effort,
      input.usage?.inputTokens ?? 0,
      input.usage?.outputTokens ?? 0,
      input.usage?.cacheReadTokens ?? 0,
      input.usage?.cacheCreationTokens ?? 0,
      input.startedAt ?? this.iso(),
      endedAt,
      status,
      input.error ?? null,
    );
  }

  /** Records that a call is starting. Finish it with `finishStewardRun`. */
  startStewardRun(input: StewardRunInput, actor: Actor): StewardRun {
    this.stewardWriter(actor, "record a run");
    return this.tx(() => this.runRow(this.insertRun(input, "running", null)));
  }

  /**
   * Records a call that is already over (for example the second model of a call that used two:
   * its tokens count against that model's cap).
   */
  recordStewardRun(
    input: StewardRunInput & { status: Exclude<StewardStatus, "running"> },
    actor: Actor,
  ): StewardRun {
    this.stewardWriter(actor, "record a run");
    return this.tx(() => this.runRow(this.insertRun(input, input.status, this.iso())));
  }

  finishStewardRun(id: number, input: StewardRunFinish, actor: Actor): StewardRun {
    this.stewardWriter(actor, "finish a run");
    return this.tx(() => {
      const r = this.runRow(id);
      if (r.status !== "running") {
        throw new AxiomError("conflict", `Steward run ${id} is already ${r.status}`);
      }
      const u = input.usage;
      this.run(
        `UPDATE steward_run SET status = ?, ended_at = ?, error = ?, model = ?,
           input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?
         WHERE id = ?`,
        input.status,
        this.iso(),
        input.error ?? null,
        input.model ?? r.model,
        u?.inputTokens ?? r.inputTokens,
        u?.outputTokens ?? r.outputTokens,
        u?.cacheReadTokens ?? r.cacheReadTokens,
        u?.cacheCreationTokens ?? r.cacheCreationTokens,
        id,
      );
      return this.runRow(id);
    });
  }

  getStewardRun(id: number): StewardRun {
    return this.runRow(id);
  }

  listStewardRuns(filter: { wakeId?: number; chatId?: number } = {}): StewardRun[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.wakeId !== undefined) {
      where.push("wake_id = ?");
      params.push(filter.wakeId);
    }
    if (filter.chatId !== undefined) {
      where.push("chat_id = ?");
      params.push(filter.chatId);
    }
    return this.all<Row>(
      `SELECT * FROM steward_run ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
      ...params,
    ).map((r) => camel<StewardRun>(r));
  }

  /**
   * Tokens used per model on a local day (`YYYY-MM-DD`, default today), summed over the runs
   * that started on it. Models are as recorded (for example `claude-haiku-5-5`).
   */
  stewardUsageForDay(day: string = localDay(this.clock())): StewardModelUsage[] {
    const { start, end } = localDayRange(day);
    return this.all<Row>(
      `SELECT model, COUNT(*) AS runs, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_creation_tokens) AS cache_creation_tokens
       FROM steward_run WHERE started_at >= ? AND started_at < ?
       GROUP BY model ORDER BY model`,
      start,
      end,
    ).map((r) => {
      const u = camel<Omit<StewardModelUsage, "total">>(r);
      return { ...u, total: countTokens(u) };
    });
  }

  /**
   * Whether a call on `model` may start: the family's tokens so far today are under its daily cap.
   * A call is refused once the cap is reached; a call that starts under it may end over it.
   */
  stewardCapCheck(model: string, day: string = localDay(this.clock())): StewardCapCheck {
    const family = modelFamily(model);
    const caps = this.getStewardSettings().dailyCaps;
    const cap = Object.hasOwn(caps, family) ? (caps[family] ?? null) : null;
    const used = this.stewardUsageForDay(day)
      .filter((u) => modelFamily(u.model) === family)
      .reduce((sum, u) => sum + u.total, 0);
    return { allowed: cap === null || used < cap, model, family, used, cap };
  }

  // -- items, suggestions, actions

  private itemRow(id: number): StewardItem {
    const row = this.get<Row>(`${ITEM_SELECT} WHERE steward_item.id = ?`, id);
    if (!row) throw new AxiomError("not-found", `Steward item not found: ${id}`);
    return camel<StewardItem>(row);
  }

  addStewardItem(input: StewardItemInput, actor: Actor): StewardItem {
    this.stewardWriter(actor, "add a Steward item");
    parseWith(stewardItemKindSchema, input.kind, "item kind");
    if (input.level !== undefined) parseWith(stewardLevelSchema, input.level, "item level");
    if (input.promotion !== undefined) {
      parseWith(stewardComplexitySchema, input.promotion, "promotion");
    }
    if (!input.title.trim()) throw new AxiomError("validation", "a Steward item needs a title");
    return this.tx(() => {
      const topicId = input.topic === undefined ? null : this.topicRow(input.topic).id;
      if (input.parentItemId !== undefined) this.itemRow(input.parentItemId);
      return this.itemRow(
        this.run(
          `INSERT INTO steward_item
             (wake_id, kind, topic_id, level, title, body, signal, source, fingerprint, entry_id,
              parent_item_id, promotion, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.wakeId ?? null,
          input.kind,
          topicId,
          input.level ?? null,
          input.title.trim(),
          input.body ?? null,
          input.signal ?? null,
          input.source ?? null,
          input.fingerprint ?? null,
          input.entryId ?? null,
          input.parentItemId ?? null,
          input.promotion ?? null,
          this.iso(),
        ),
      );
    });
  }

  getStewardItem(id: number): StewardItem {
    return this.itemRow(id);
  }

  listStewardItems(filter: { state?: StewardItemState; topic?: TopicRef } = {}): StewardItem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.state !== undefined) {
      where.push("steward_item.state = ?");
      params.push(filter.state);
    }
    if (filter.topic !== undefined) {
      where.push("steward_item.topic_id = ?");
      params.push(this.topicRow(filter.topic).id);
    }
    return this.all<Row>(
      `${ITEM_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY steward_item.id`,
      ...params,
    ).map((r) => camel<StewardItem>(r));
  }

  /** The newest item about this subject, in any state (a dismissed one is not raised again). */
  findStewardItemByFingerprint(fingerprint: string): StewardItem | null {
    const row = this.get<Row>(
      `${ITEM_SELECT} WHERE steward_item.fingerprint = ? ORDER BY steward_item.id DESC LIMIT 1`,
      fingerprint,
    );
    return row ? camel<StewardItem>(row) : null;
  }

  /**
   * Moves an open item to `answered` (with the answer), `dismissed`, `adopted`, `discarded` or
   * `undone`; an adopted item can still be `undone`. Anything else is final.
   */
  updateStewardItem(
    id: number,
    change: { state: Exclude<StewardItemState, "open">; answer?: string; resolution?: string },
    actor: Actor,
  ): StewardItem {
    this.stewardWriter(actor, "change a Steward item");
    parseWith(stewardItemStateSchema, change.state, "item state");
    return this.tx(() => {
      const item = this.itemRow(id);
      const allowed =
        (item.state === "open" && (change.state as string) !== "open") ||
        (item.state === "adopted" && change.state === "undone");
      if (!allowed) {
        throw new AxiomError("conflict", `a ${item.state} item cannot become ${change.state}`);
      }
      if (change.state === "answered" && !change.answer?.trim()) {
        throw new AxiomError("validation", "an answered item needs the answer");
      }
      if (change.answer !== undefined && change.state !== "answered") {
        throw new AxiomError("validation", "only an answered item carries an answer");
      }
      if (change.state === "resolved" && !change.resolution?.trim()) {
        throw new AxiomError("validation", "a resolved item needs the reason");
      }
      if (change.resolution !== undefined && change.state !== "resolved") {
        throw new AxiomError("validation", "only a resolved item carries a resolution");
      }
      this.run(
        `UPDATE steward_item SET state = ?, answer = COALESCE(?, answer),
           resolution = COALESCE(?, resolution), resolved_at = ? WHERE id = ?`,
        change.state,
        change.answer?.trim() ?? null,
        change.resolution?.trim() ?? null,
        this.iso(),
        id,
      );
      return this.itemRow(id);
    });
  }

  /** Links the history entry an item wrote. */
  setStewardItemEntry(id: number, entryId: number, actor: Actor): StewardItem {
    this.stewardWriter(actor, "change a Steward item");
    return this.tx(() => {
      this.itemRow(id);
      this.run("UPDATE steward_item SET entry_id = ? WHERE id = ?", entryId, id);
      return this.itemRow(id);
    });
  }

  addStewardSuggestion(
    itemId: number,
    input: {
      repository: string;
      branch: string;
      base: string;
      kind: StewardSuggestionKind;
      worktree?: string;
      complexity?: StewardComplexity;
      diffstat?: string;
      tests?: string;
    },
    actor: Actor,
  ): StewardSuggestion {
    this.stewardWriter(actor, "add a suggestion");
    parseWith(stewardSuggestionKindSchema, input.kind, "suggestion kind");
    if (input.complexity !== undefined) {
      parseWith(stewardComplexitySchema, input.complexity, "complexity");
    }
    return this.tx(() => {
      this.itemRow(itemId);
      const id = this.run(
        `INSERT INTO steward_suggestion
           (item_id, repository, branch, base, worktree, kind, complexity, diffstat, tests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        itemId,
        input.repository,
        input.branch,
        input.base,
        input.worktree ?? null,
        input.kind,
        input.complexity ?? null,
        input.diffstat ?? null,
        input.tests ?? null,
      );
      return camel<StewardSuggestion>(
        this.get<Row>("SELECT * FROM steward_suggestion WHERE id = ?", id),
      );
    });
  }

  /** Sets or clears the quiet note beside an item. */
  setStewardItemNote(id: number, note: string | null, actor: Actor): StewardItem {
    this.stewardWriter(actor, "change a Steward item");
    return this.tx(() => {
      this.itemRow(id);
      this.run("UPDATE steward_item SET note = ? WHERE id = ?", note?.trim() || null, id);
      return this.itemRow(id);
    });
  }

  /**
   * A prepared fix (ST6): a suggestion item inside its finding, its branch row and a history
   * entry on the finding's topic saying a fix is ready.
   */
  addStewardFix(
    findingId: number,
    input: {
      title: string;
      repository: string;
      branch: string;
      base: string;
      worktree: string;
      complexity: StewardComplexity;
      diffstat: string;
      tests: string;
      wakeId?: number;
    },
    actor: Actor,
  ): { item: StewardItem; suggestion: StewardSuggestion } {
    this.stewardWriter(actor, "add a fix");
    return this.tx(() => {
      const finding = this.itemRow(findingId);
      if (finding.kind !== "finding") {
        throw new AxiomError("validation", "a fix belongs to a finding");
      }
      const item = this.addStewardItem(
        {
          kind: "suggestion",
          title: input.title,
          parentItemId: findingId,
          ...(finding.topicSlug ? { topic: finding.topicSlug } : {}),
          ...(input.wakeId !== undefined ? { wakeId: input.wakeId } : {}),
          fingerprint: finding.fingerprint ? `fix:${finding.fingerprint}` : undefined,
        },
        actor,
      );
      const suggestion = this.addStewardSuggestion(
        item.id,
        {
          kind: "fix",
          repository: input.repository,
          branch: input.branch,
          base: input.base,
          worktree: input.worktree,
          complexity: input.complexity,
          diffstat: input.diffstat,
          tests: input.tests,
        },
        actor,
      );
      if (finding.topicId !== null) {
        const entryId = this.insertEntry({
          topicId: finding.topicId,
          author: "steward",
          kind: "finding",
          body: `A fix is ready on ${input.branch} (${input.diffstat}, tests ${input.tests}): ${finding.title}`,
          data: { subtype: "fix ready" },
        });
        this.run("UPDATE steward_item SET entry_id = ? WHERE id = ?", entryId, item.id);
      }
      return { item: this.itemRow(item.id), suggestion };
    });
  }

  /**
   * The owner adopted or discarded a prepared fix (Axiom already did the git work): the item
   * is resolved, the topic's history says so, and the finding keeps a quiet note.
   */
  resolveStewardFix(
    itemId: number,
    state: "adopted" | "discarded",
    detail: string,
    actor: Actor,
  ): StewardItem {
    ownerOnly(actor, `${state === "adopted" ? "adopt" : "discard"} a Steward fix`);
    return this.tx(() => {
      const before = this.itemRow(itemId);
      if (before.kind !== "suggestion") {
        throw new AxiomError("validation", "only a suggestion can be adopted or discarded");
      }
      const item = this.updateStewardItem(itemId, { state }, actor);
      if (item.topicId !== null) {
        this.insertEntry({
          topicId: item.topicId,
          author: "owner",
          kind: "note",
          body: `${state === "adopted" ? "Adopted" : "Discarded"} Steward's fix: ${item.title}. ${detail}`,
        });
      }
      if (item.parentItemId !== null) {
        this.run(
          "UPDATE steward_item SET note = ? WHERE id = ?",
          `fix ${state}: ${detail}`,
          item.parentItemId,
        );
      }
      return item;
    });
  }

  /** The suggestion row of a suggestion item. */
  getStewardSuggestion(itemId: number): StewardSuggestion {
    const s = this.listStewardSuggestions(itemId)[0];
    if (!s) throw new AxiomError("not-found", `no suggestion branch for item ${itemId}`);
    return s;
  }

  listStewardSuggestions(itemId: number): StewardSuggestion[] {
    return this.all<Row>(
      "SELECT * FROM steward_suggestion WHERE item_id = ? ORDER BY id",
      itemId,
    ).map((r) => camel<StewardSuggestion>(r));
  }

  private actionRow(id: number): StewardAction {
    const row = this.get<Row>("SELECT * FROM steward_action WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `Steward action not found: ${id}`);
    const a = camel<StewardAction & { data: string | null }>(row);
    return { ...a, data: a.data === null ? null : JSON.parse(a.data) };
  }

  /** Records something Steward did on its own that can be undone. */
  recordStewardAction(
    input: { itemId: number; kind: StewardActionKind; data?: unknown },
    actor: Actor,
  ): StewardAction {
    this.stewardWriter(actor, "record an action");
    if (!(STEWARD_ACTION_KINDS as readonly string[]).includes(input.kind)) {
      throw new AxiomError("validation", `unknown action kind "${input.kind}"`);
    }
    return this.tx(() => {
      this.itemRow(input.itemId);
      return this.actionRow(
        this.run(
          "INSERT INTO steward_action (item_id, kind, data, done_at) VALUES (?, ?, ?, ?)",
          input.itemId,
          input.kind,
          input.data === undefined ? null : JSON.stringify(input.data),
          this.iso(),
        ),
      );
    });
  }

  markStewardActionUndone(id: number, actor: Actor): StewardAction {
    this.stewardWriter(actor, "undo an action");
    return this.tx(() => {
      const a = this.actionRow(id);
      if (a.undoneAt !== null) throw new AxiomError("conflict", `action ${id} is already undone`);
      this.run("UPDATE steward_action SET undone_at = ? WHERE id = ?", this.iso(), id);
      return this.actionRow(id);
    });
  }

  listStewardActions(filter: { itemId?: number } = {}): StewardAction[] {
    const rows =
      filter.itemId === undefined
        ? this.all<{ id: number }>("SELECT id FROM steward_action ORDER BY id")
        : this.all<{ id: number }>(
            "SELECT id FROM steward_action WHERE item_id = ? ORDER BY id",
            filter.itemId,
          );
    return rows.map((r) => this.actionRow(r.id));
  }

  // -- Steward's results (ST3): findings, tidying, topic updates and the owner's reactions

  /** What a level raises: urgent a `steward urgent` notification, attention a `monitor problem`. */
  private notifyFinding(topicId: number, level: StewardLevel | null, title: string): void {
    if (level === "urgent") {
      this.insertNotification(topicId, null, "steward urgent", `Steward: ${title}`);
    } else if (level === "attention") {
      // The existing "a monitor found a problem" mechanism of 01: the topic is highlighted and
      // the notification says why.
      this.insertNotification(topicId, null, "monitor problem", `Steward: ${title}`);
    }
  }

  /**
   * A finding: an item, and for a finding on a topic a `finding` history entry by Steward linked
   * from the item. An `urgent` or `attention` finding on a topic also raises its notification.
   */
  recordStewardFinding(
    input: {
      wakeId?: number;
      topic?: TopicRef;
      level: StewardLevel;
      signal?: string;
      title: string;
      body?: string;
      fingerprint?: string;
      promotion?: StewardComplexity;
    },
    actor: Actor,
  ): StewardItem {
    this.stewardWriter(actor, "record a finding");
    return this.tx(() => {
      const item = this.addStewardItem(
        {
          kind: "finding",
          title: input.title,
          level: input.level,
          ...(input.wakeId !== undefined ? { wakeId: input.wakeId } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.body ? { body: input.body } : {}),
          ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
          ...(input.promotion ? { promotion: input.promotion } : {}),
        },
        actor,
      );
      if (item.topicId === null) return item;
      const entryId = this.insertEntry({
        topicId: item.topicId,
        author: "steward",
        kind: "finding",
        body: item.body ? `${item.title}\n\n${item.body}` : item.title,
        data: input.signal ? { subtype: input.signal } : undefined,
      });
      this.run("UPDATE steward_item SET entry_id = ? WHERE id = ?", entryId, item.id);
      this.notifyFinding(item.topicId, input.level, item.title);
      return this.itemRow(item.id);
    });
  }

  /**
   * The same finding seen again while still open: its text, level and promotion are refreshed
   * instead of a second item being added. A changed level is also written to the topic's history,
   * and a rise to `urgent` or `attention` raises that notification.
   */
  refreshStewardFinding(
    id: number,
    input: {
      wakeId?: number;
      level: StewardLevel;
      title: string;
      body?: string;
      promotion?: StewardComplexity;
    },
    actor: Actor,
  ): StewardItem {
    this.stewardWriter(actor, "update a finding");
    return this.tx(() => {
      const item = this.itemRow(id);
      if (item.state !== "open") {
        throw new AxiomError("conflict", `a ${item.state} item cannot be updated`);
      }
      const title = input.title.trim() || item.title;
      this.run(
        `UPDATE steward_item SET title = ?, body = ?, level = ?, promotion = ?,
           wake_id = COALESCE(?, wake_id) WHERE id = ?`,
        title,
        input.body ?? item.body,
        input.level,
        input.promotion ?? item.promotion,
        input.wakeId ?? null,
        id,
      );
      if (item.level !== input.level && item.topicId !== null) {
        this.insertEntry({
          topicId: item.topicId,
          author: "steward",
          kind: "finding",
          body: `Steward changed the level of "${title}" from ${item.level ?? "none"} to ${input.level}.`,
          data: item.signal ? { subtype: item.signal } : undefined,
        });
        const rank = { info: 0, attention: 1, urgent: 2 } as const;
        const was = item.level === null ? -1 : rank[item.level];
        if (rank[input.level] > was) this.notifyFinding(item.topicId, input.level, title);
      }
      return this.itemRow(id);
    });
  }

  /**
   * Steward changes a status by a mechanical rule (03, Tidying): through the normal status path,
   * marked as Steward's in the history entry, with an info item for the view and an action that
   * can be undone.
   */
  stewardTidyStatus(
    input: {
      wakeId?: number;
      topic: TopicRef;
      to: TopicStatus;
      reason: string;
      title: string;
      body?: string;
      fingerprint?: string;
    },
    actor: Actor,
  ): { item: StewardItem; action: StewardAction } {
    this.stewardWriter(actor, "tidy a topic");
    const to = parseWith(topicStatusSchema, input.to, "status");
    const denied = manualStatusError({ kind: "steward" }, to);
    if (denied) throw new AxiomError("permission", denied);
    return this.tx(() => {
      const t = this.topicRow(input.topic);
      const entryId = this.applyTopicStatus(t, to, input.reason, null, true);
      if (entryId === null) throw new AxiomError("conflict", `${t.slug} is already ${to}`);
      const item = this.addStewardItem(
        {
          kind: "finding",
          topic: t.id,
          level: "info",
          signal: "tidy",
          title: input.title,
          body: input.body ?? input.reason,
          entryId,
          ...(input.wakeId !== undefined ? { wakeId: input.wakeId } : {}),
          ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
        },
        actor,
      );
      const action = this.recordStewardAction(
        { itemId: item.id, kind: "status change", data: { topic: t.slug, from: t.status, to } },
        actor,
      );
      return { item, action };
    });
  }

  /**
   * Puts back what a `status change` action changed, but only while the topic is still at the
   * status Steward set (otherwise the owner or an agent has moved on: refused, with the reason).
   */
  undoStewardAction(id: number, actor: Actor): StewardAction {
    ownerOnly(actor, "undo a Steward action");
    return this.tx(() => {
      const a = this.actionRow(id);
      if (a.undoneAt !== null) throw new AxiomError("conflict", `action ${id} is already undone`);
      if (a.kind !== "status change") {
        throw new AxiomError("validation", `a "${a.kind}" action cannot be undone yet`);
      }
      const d = a.data as { topic: string; from: TopicStatus | null; to: TopicStatus };
      const t = this.topicRow(d.topic);
      if (t.status !== d.to) {
        throw new AxiomError(
          "conflict",
          `cannot undo: Steward set ${t.slug} to ${d.to}, but it is now ${t.status ?? "none"}`,
        );
      }
      this.applyTopicStatus(t, d.from, "undid Steward's change", null);
      const undone = this.markStewardActionUndone(id, actor);
      const item = this.itemRow(a.itemId);
      if (item.state === "open") this.updateStewardItem(item.id, { state: "undone" }, actor);
      return undone;
    });
  }

  /**
   * Steward rebased the owner's branch in place (ST7; Axiom already did the git work): an info
   * finding on the topic with a history entry by Steward, and a `rebase in place` action holding
   * the tips and the backup ref, so the owner can undo it.
   */
  recordStewardRebase(
    input: {
      wakeId?: number;
      topic: TopicRef;
      title: string;
      body?: string;
      /** The history entry's text. */
      entry: string;
      fingerprint: string;
      data: unknown;
    },
    actor: Actor,
  ): { item: StewardItem; action: StewardAction } {
    this.stewardWriter(actor, "record a rebase");
    return this.tx(() => {
      const t = this.topicRow(input.topic);
      const entryId = this.insertEntry({
        topicId: t.id,
        author: "steward",
        kind: "finding",
        body: input.entry,
        data: { subtype: "rebase in place" },
      });
      const item = this.addStewardItem(
        {
          kind: "finding",
          topic: t.id,
          level: "info",
          signal: "rebase",
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          entryId,
          fingerprint: input.fingerprint,
          ...(input.wakeId !== undefined ? { wakeId: input.wakeId } : {}),
        },
        actor,
      );
      const action = this.recordStewardAction(
        { itemId: item.id, kind: "rebase in place", data: input.data },
        actor,
      );
      return { item, action };
    });
  }

  /**
   * A rebased copy of the owner's branch (ST7): a standalone suggestion with its branch row and
   * a history entry by Steward on the topic.
   */
  addStewardRebaseCopy(
    input: {
      wakeId?: number;
      topic: TopicRef;
      title: string;
      fingerprint: string;
      repository: string;
      branch: string;
      base: string;
      worktree: string;
      diffstat: string;
    },
    actor: Actor,
  ): { item: StewardItem; suggestion: StewardSuggestion } {
    this.stewardWriter(actor, "add a rebased copy");
    return this.tx(() => {
      const t = this.topicRow(input.topic);
      const item = this.addStewardItem(
        {
          kind: "suggestion",
          topic: t.id,
          title: input.title,
          fingerprint: input.fingerprint,
          ...(input.wakeId !== undefined ? { wakeId: input.wakeId } : {}),
        },
        actor,
      );
      const suggestion = this.addStewardSuggestion(
        item.id,
        {
          kind: "rebase copy",
          repository: input.repository,
          branch: input.branch,
          base: input.base,
          worktree: input.worktree,
          diffstat: input.diffstat,
        },
        actor,
      );
      const entryId = this.insertEntry({
        topicId: t.id,
        author: "steward",
        kind: "finding",
        body: `A rebased copy is ready on ${input.branch} (${input.diffstat}): ${input.title}`,
        data: { subtype: "rebase copy ready" },
      });
      this.run("UPDATE steward_item SET entry_id = ? WHERE id = ?", entryId, item.id);
      return { item: this.itemRow(item.id), suggestion };
    });
  }

  /**
   * The owner undid an in-place rebase (Axiom already moved the branch back): the action is marked
   * undone, its item `undone`, and the topic's history says so.
   */
  markStewardRebaseUndone(id: number, detail: string, actor: Actor): StewardAction {
    ownerOnly(actor, "undo a Steward action");
    return this.tx(() => {
      const a = this.actionRow(id);
      if (a.kind !== "rebase in place") {
        throw new AxiomError("validation", `a "${a.kind}" action is not a rebase`);
      }
      const undone = this.markStewardActionUndone(id, actor);
      const item = this.itemRow(a.itemId);
      if (item.state === "open") this.updateStewardItem(item.id, { state: "undone" }, actor);
      if (item.topicId !== null) {
        this.insertEntry({
          topicId: item.topicId,
          author: "owner",
          kind: "note",
          body: `Undid Steward's rebase: ${item.title}. ${detail}`,
        });
      }
      return undone;
    });
  }

  /**
   * Steward changes a topic's goal or status note (from an answer or a clear fact). The change
   * goes through the normal update, with a `note` entry by Steward saying why, and an info item.
   * Returns null when nothing differs.
   */
  stewardUpdateTopic(
    input: {
      wakeId?: number;
      topic: TopicRef;
      goal?: string;
      statusNote?: string;
      because: string;
    },
    actor: Actor,
  ): StewardItem | null {
    this.stewardWriter(actor, "update a topic");
    return this.tx(() => {
      const t = this.topicRow(input.topic);
      const goal = input.goal?.trim();
      const note = input.statusNote?.trim();
      const parts: string[] = [];
      const changes: { goal?: string; statusNote?: string } = {};
      if (goal && goal !== t.goal) {
        changes.goal = goal;
        parts.push(`goal: "${goal}"${t.goal ? ` (was: "${t.goal}")` : ""}`);
      }
      if (note && note !== t.statusNote) {
        changes.statusNote = note;
        parts.push(`status note: "${note}"${t.statusNote ? ` (was: "${t.statusNote}")` : ""}`);
      }
      if (parts.length === 0) return null;
      this.updateTopic(t.id, changes, actor);
      const what =
        changes.goal && changes.statusNote
          ? "goal and status note"
          : changes.goal
            ? "goal"
            : "status note";
      const body = `Steward updated the ${what}: ${parts.join("; ")}. Why: ${input.because.trim()}`;
      const entryId = this.insertEntry({
        topicId: t.id,
        author: "steward",
        kind: "note",
        body,
      });
      return this.addStewardItem(
        {
          kind: "finding",
          topic: t.id,
          level: "info",
          signal: "topic update",
          title: `Updated the ${what} of ${t.slug}`,
          body: `${parts.join("; ")}. Why: ${input.because.trim()}`,
          entryId,
          ...(input.wakeId !== undefined ? { wakeId: input.wakeId } : {}),
        },
        actor,
      );
    });
  }

  /**
   * Steward rewrites one of its open items after feedback (SF1): a finding's title, body and
   * level (a level change goes through `refreshStewardFinding`, with its history line and
   * notification), a question's text. Nothing to change returns the item as it is.
   */
  stewardReviseItem(
    id: number,
    change: { title?: string; body?: string; level?: StewardLevel },
    actor: Actor,
  ): StewardItem {
    this.stewardWriter(actor, "revise a Steward item");
    if (change.level !== undefined) parseWith(stewardLevelSchema, change.level, "item level");
    return this.tx(() => {
      const item = this.itemRow(id);
      if (item.state !== "open") {
        throw new AxiomError("conflict", `#${id} is ${item.state}, so it cannot be revised`);
      }
      const title = change.title?.trim() || item.title;
      const body = change.body !== undefined ? change.body.trim() || null : item.body;
      if (item.kind === "finding") {
        return this.refreshStewardFinding(
          id,
          {
            level: change.level ?? item.level ?? "info",
            title,
            ...(body !== null ? { body } : {}),
          },
          actor,
        );
      }
      if (change.level !== undefined && item.kind === "question") {
        throw new AxiomError("validation", "a question has no level");
      }
      this.run("UPDATE steward_item SET title = ?, body = ? WHERE id = ?", title, body, id);
      return this.itemRow(id);
    });
  }

  /**
   * Steward closes one of its open items (SF1): it is no longer true, or the owner said it is
   * handled. Unlike the owner's dismissal it says why; like it, the same subject is not raised
   * again unless it changes. A finding that wrote a history entry gets a note there too.
   */
  stewardResolveItem(id: number, reason: string, actor: Actor): StewardItem {
    this.stewardWriter(actor, "resolve a Steward item");
    return this.tx(() => {
      const item = this.updateStewardItem(id, { state: "resolved", resolution: reason }, actor);
      if (item.topicId !== null && item.kind !== "suggestion") {
        this.insertEntry({
          topicId: item.topicId,
          author: "steward",
          kind: "note",
          body: `Steward closed its ${item.kind}: ${item.title}. Why: ${reason.trim()}`,
        });
      }
      return item;
    });
  }

  /**
   * The owner answered a question somewhere else (in the chat, or in an answer to another item)
   * and Steward records it on the question (SF1): the item becomes `answered`, keeping the
   * owner's words.
   */
  stewardRecordAnswer(id: number, ownerWords: string, actor: Actor): StewardItem {
    this.stewardWriter(actor, "record an answer");
    const item = this.itemRow(id);
    if (item.kind !== "question") {
      throw new AxiomError("validation", "only a question can be answered");
    }
    return this.updateStewardItem(id, { state: "answered", answer: ownerWords }, actor);
  }

  /** The owner answers a question: the item becomes `answered` and keeps the answer. */
  answerStewardQuestion(id: number, text: string, actor: Actor): StewardItem {
    ownerOnly(actor, "answer a Steward question");
    const item = this.itemRow(id);
    if (item.kind !== "question") {
      throw new AxiomError("validation", "only a question can be answered");
    }
    return this.updateStewardItem(id, { state: "answered", answer: text }, actor);
  }

  /**
   * The owner dismisses an item. A finding that wrote a history entry gets a note there too, which
   * is how Steward knows not to raise it again.
   */
  dismissStewardItem(id: number, actor: Actor): StewardItem {
    ownerOnly(actor, "dismiss a Steward item");
    return this.tx(() => {
      const item = this.updateStewardItem(id, { state: "dismissed" }, actor);
      if (item.topicId !== null && item.entryId !== null && item.kind === "finding") {
        this.insertEntry({
          topicId: item.topicId,
          author: "owner",
          kind: "note",
          body: `Dismissed Steward's finding: ${item.title}`,
        });
      }
      return item;
    });
  }

  // -- memory

  private memoryRow(id: number): StewardMemory {
    const row = this.get<Row>("SELECT * FROM steward_memory WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `Steward memory item not found: ${id}`);
    return camel<StewardMemory>(row);
  }

  /** Steward may add, change, retire and delete its own memory (03 autonomy rule), as may the owner. */
  private memoryWriter(actor: Actor, what: string): void {
    if (actor.kind !== "owner" && actor.kind !== "steward") {
      throw new AxiomError("permission", `only the owner or Steward can ${what}`);
    }
  }

  private memoryTextLength(text: string, actor: Actor): void {
    if (actor.kind === "owner" && text.trim().length > OWNER_MEMORY_TEXT_MAX) {
      throw new AxiomError(
        "validation",
        `a memory item is at most ${OWNER_MEMORY_TEXT_MAX} characters`,
      );
    }
  }

  addStewardMemory(input: StewardMemoryInput, actor: Actor): StewardMemory {
    this.memoryWriter(actor, "add to Steward's memory");
    parseWith(stewardMemoryScopeSchema, input.scope, "memory scope");
    const source = actor.kind === "owner" ? "owner" : input.source;
    parseWith(stewardMemorySourceSchema, source, "memory source");
    if (actor.kind === "steward" && source === "owner") {
      throw new AxiomError("validation", "Steward's own memory items are not from the owner");
    }
    if (!input.text.trim()) throw new AxiomError("validation", "a memory item needs text");
    this.memoryTextLength(input.text, actor);
    if (input.scope === "attached") {
      parseWith(stewardAttachedKindSchema, input.attachedKind, "attached kind");
      if (!input.attachedKey?.trim()) {
        throw new AxiomError("validation", "attached memory needs the key it is attached to");
      }
    } else if (input.attachedKind !== undefined || input.attachedKey !== undefined) {
      throw new AxiomError("validation", `${input.scope} memory is not attached to anything`);
    }
    const now = this.iso();
    return this.tx(() =>
      this.memoryRow(
        this.run(
          `INSERT INTO steward_memory
             (scope, attached_kind, attached_key, text, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          input.scope,
          input.attachedKind ?? null,
          input.attachedKey?.trim() ?? null,
          input.text.trim(),
          source,
          now,
          now,
        ),
      ),
    );
  }

  getStewardMemory(id: number): StewardMemory {
    return this.memoryRow(id);
  }

  /**
   * Changes an item's text. The owner's edit makes it the owner's (`source` owner); Steward's edit
   * records where it came from (`source`, default `wake`) but never takes an item over from the
   * owner, so the owner's items stay safe from Steward's deletes.
   */
  updateStewardMemory(
    id: number,
    text: string,
    actor: Actor,
    source?: StewardMemorySource,
  ): StewardMemory {
    this.memoryWriter(actor, "change Steward's memory");
    if (!text.trim()) throw new AxiomError("validation", "a memory item needs text");
    this.memoryTextLength(text, actor);
    if (source !== undefined) parseWith(stewardMemorySourceSchema, source, "memory source");
    if (actor.kind === "steward" && source === "owner") {
      throw new AxiomError("validation", "Steward's own memory items are not from the owner");
    }
    return this.tx(() => {
      const m = this.memoryRow(id);
      const next = actor.kind === "owner" || m.source === "owner" ? "owner" : (source ?? m.source);
      this.run(
        "UPDATE steward_memory SET text = ?, source = ?, updated_at = ? WHERE id = ?",
        text.trim(),
        next,
        this.iso(),
        id,
      );
      return this.memoryRow(id);
    });
  }

  /** Runs `fn` as one unit: if it throws, everything it wrote inside is rolled back. */
  inTransaction<T>(fn: () => T): T {
    return this.tx(fn);
  }

  /** The index lines the last tidy-up wrote (what the general memory holds), newest write only. */
  getStewardMemoryIndex(): { lines: string[]; at: string } | null {
    const v = this.getSetting("stewardMemoryIndex") as { lines: string[]; at: string } | undefined;
    return v ?? null;
  }

  setStewardMemoryIndex(lines: string[], actor: Actor): void {
    this.memoryWriter(actor, "write the memory index");
    this.run(
      "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      "stewardMemoryIndex",
      JSON.stringify({ lines: lines.map((l) => l.trim()).filter(Boolean), at: this.iso() }),
    );
  }

  /** Keeps the item but stops loading it. */
  retireStewardMemory(id: number, actor: Actor): StewardMemory {
    this.memoryWriter(actor, "retire a memory item");
    return this.tx(() => {
      const m = this.memoryRow(id);
      if (m.retiredAt === null) {
        const now = this.iso();
        this.run(
          "UPDATE steward_memory SET retired_at = ?, updated_at = ? WHERE id = ?",
          now,
          now,
          id,
        );
      }
      return this.memoryRow(id);
    });
  }

  /** Loads a retired item again, with its original source. Owner only. */
  restoreStewardMemory(id: number, actor: Actor): StewardMemory {
    ownerOnly(actor, "restore a memory item");
    return this.tx(() => {
      this.memoryRow(id);
      this.run(
        "UPDATE steward_memory SET retired_at = NULL, updated_at = ? WHERE id = ?",
        this.iso(),
        id,
      );
      return this.memoryRow(id);
    });
  }

  deleteStewardMemory(id: number, actor: Actor): void {
    this.memoryWriter(actor, "delete a memory item");
    this.tx(() => {
      this.memoryRow(id);
      this.run("DELETE FROM steward_memory WHERE id = ?", id);
    });
  }

  /** Active items by default (not retired), oldest first. */
  listStewardMemory(options: ListStewardMemoryOptions = {}): StewardMemory[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeRetired) where.push("retired_at IS NULL");
    if (options.scope !== undefined) {
      where.push("scope = ?");
      params.push(options.scope);
    }
    if (options.attachedKind !== undefined) {
      where.push("attached_kind = ?");
      params.push(options.attachedKind);
    }
    if (options.attachedKey !== undefined) {
      where.push("attached_key = ?");
      params.push(options.attachedKey);
    }
    return this.all<Row>(
      `SELECT * FROM steward_memory ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
      ...params,
    ).map((r) => camel<StewardMemory>(r));
  }

  // -- chat

  startStewardChat(input: { model: string; effort: Effort }, actor: Actor): StewardChat {
    this.stewardWriter(actor, "start a chat");
    parseWith(effortSchema, input.effort, "effort");
    if (!input.model.trim()) throw new AxiomError("validation", "a chat needs a model");
    return this.tx(() =>
      this.chatRow(
        this.run(
          "INSERT INTO steward_chat (started_at, model, effort) VALUES (?, ?, ?)",
          this.iso(),
          input.model.trim(),
          input.effort,
        ),
      ),
    );
  }

  /** The owner picks another model or effort in the middle of a chat; the next turn uses it. */
  updateStewardChat(
    id: number,
    input: { model?: string; effort?: Effort },
    actor: Actor,
  ): StewardChat {
    this.stewardWriter(actor, "change a chat");
    if (input.effort !== undefined) parseWith(effortSchema, input.effort, "effort");
    if (input.model !== undefined && !input.model.trim()) {
      throw new AxiomError("validation", "a chat needs a model");
    }
    return this.tx(() => {
      const c = this.chatRow(id);
      this.run(
        "UPDATE steward_chat SET model = ?, effort = ? WHERE id = ?",
        input.model?.trim() ?? c.model,
        input.effort ?? c.effort,
        id,
      );
      return this.chatRow(id);
    });
  }

  private chatRow(id: number): StewardChat {
    const row = this.get<Row>("SELECT * FROM steward_chat WHERE id = ?", id);
    if (!row) throw new AxiomError("not-found", `Steward chat not found: ${id}`);
    return camel<StewardChat>(row);
  }

  getStewardChat(id: number): StewardChat {
    return this.chatRow(id);
  }

  /** Newest first. */
  listStewardChats(limit = 50): StewardChat[] {
    return this.all<Row>("SELECT * FROM steward_chat ORDER BY id DESC LIMIT ?", limit).map((r) =>
      camel<StewardChat>(r),
    );
  }

  addStewardMessage(
    chatId: number,
    input: {
      role: StewardMessageRole;
      text: string;
      memoryItemId?: number;
      meta?: StewardMessageMeta;
    },
    actor: Actor,
  ): StewardMessage {
    this.stewardWriter(actor, "add a chat message");
    parseWith(stewardMessageRoleSchema, input.role, "message role");
    if (!input.text.trim()) throw new AxiomError("validation", "a message needs text");
    return this.tx(() => {
      this.chatRow(chatId);
      if (input.memoryItemId !== undefined) this.memoryRow(input.memoryItemId);
      const id = this.run(
        "INSERT INTO steward_message (chat_id, role, text, at, memory_item_id, meta) VALUES (?, ?, ?, ?, ?, ?)",
        chatId,
        input.role,
        input.text,
        this.iso(),
        input.memoryItemId ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      );
      return messageOf(this.get<Row>("SELECT * FROM steward_message WHERE id = ?", id));
    });
  }

  listStewardMessages(chatId: number): StewardMessage[] {
    return this.all<Row>("SELECT * FROM steward_message WHERE chat_id = ? ORDER BY id", chatId).map(
      messageOf,
    );
  }

  // ---- settings -----------------------------------------------------------

  getSetting(key: string): unknown {
    if (key === STEWARD_SETTING_KEY) return this.getStewardSettings();
    const row = this.get<{ value: string }>("SELECT value FROM setting WHERE key = ?", key);
    if (row) return JSON.parse(row.value);
    if (key === "mutedKinds") return [];
    if (key === "staleAfterDays") return DEFAULT_STALE_AFTER_DAYS;
    if (key === "summaries") return { enabled: true };
    if (key === "approvalTimeoutSec") return DEFAULT_APPROVAL_TIMEOUT_SEC;
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

/** "1 background command", "2 background commands". */
function commandCount(n: number): string {
  return `${n} background command${n === 1 ? "" : "s"}`;
}
