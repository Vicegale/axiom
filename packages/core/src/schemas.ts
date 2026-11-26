import { z } from "zod";
import {
  EFFORT_LEVELS,
  type EntryKind,
  LINK_KINDS,
  MONITOR_STATES,
  NOTIFICATION_KINDS,
  PR_SIGNALS,
  PROVIDERS,
  REF_TYPES,
  STEWARD_ATTACHED_KINDS,
  STEWARD_COMPLEXITIES,
  STEWARD_ITEM_KINDS,
  STEWARD_ITEM_STATES,
  STEWARD_LEVELS,
  STEWARD_MEMORY_SCOPES,
  STEWARD_MEMORY_SOURCES,
  STEWARD_MESSAGE_ROLES,
  STEWARD_SUGGESTION_KINDS,
  STEWARD_WAKE_TRIGGERS,
  TASK_STATUSES,
  TOPIC_STATUSES,
  WORK_ITEM_STATUSES,
} from "./constants.js";
import { AxiomError } from "./errors.js";

export const topicStatusSchema = z.enum(TOPIC_STATUSES);
export const workItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const providerSchema = z.enum(PROVIDERS);
export const linkKindSchema = z.enum(LINK_KINDS);
export const monitorStateSchema = z.enum(MONITOR_STATES);
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** Lowercase kebab-case: `axiom-spec`, `pr-12`. */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case (a-z, 0-9, single dashes)");

/** A task key: `S7`, `KC3`, `S5b`. Letters, digits, dot, dash, underscore. */
export const taskKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "task key may use letters, digits, '.', '_' and '-'")
  .max(40);

export const refSchema = z.strictObject({
  type: z.enum(REF_TYPES),
  value: z.string().min(1),
});
export const refsSchema = z.array(refSchema);

export const jiraSchema = z.strictObject({ key: z.string().min(1), url: z.string().min(1) });

const emptyData = z.strictObject({}).optional();
const looseData = z.looseObject({}).optional();

/** Per-kind schema for `entry.data` (08, 05). */
export const entryDataSchemas: Record<EntryKind, z.ZodType> = {
  note: emptyData,
  decision: z.strictObject({ why: z.string().optional() }).optional(),
  finding: z.strictObject({ subtype: z.string().optional() }).optional(),
  verification: z.strictObject({
    result: z.enum(["pass", "fail", "partial"]),
    evidence: z.array(z.string()).optional(),
  }),
  "owner input": emptyData,
  authorization: z.strictObject({ scope: z.string().min(1), standing: z.boolean() }),
  "next steps": emptyData,
  // A topic status change, or (with `task`) a task status change written by Axiom (01, Tasks).
  "status change": z.union([
    z.strictObject({
      from: topicStatusSchema.nullable(),
      to: topicStatusSchema.nullable(),
      reason: z.string().optional(),
      /** Set when Steward made the change (03: every change Steward makes is marked as its own). */
      by: z.literal("steward").optional(),
    }),
    z.strictObject({
      task: taskKeySchema,
      from: taskStatusSchema,
      to: taskStatusSchema,
      by: z.enum(["owner", "agent", "axiom"]),
    }),
  ]),
  "topic created": looseData,
  "thread event": looseData,
  "git event": looseData,
  "deploy event": looseData,
};

export const effortSchema = z.enum(EFFORT_LEVELS);
export const stewardWakeTriggerSchema = z.enum(STEWARD_WAKE_TRIGGERS);
export const stewardItemKindSchema = z.enum(STEWARD_ITEM_KINDS);
export const stewardLevelSchema = z.enum(STEWARD_LEVELS);
export const stewardItemStateSchema = z.enum(STEWARD_ITEM_STATES);
export const stewardSuggestionKindSchema = z.enum(STEWARD_SUGGESTION_KINDS);
export const stewardComplexitySchema = z.enum(STEWARD_COMPLEXITIES);
export const stewardMemoryScopeSchema = z.enum(STEWARD_MEMORY_SCOPES);
export const stewardAttachedKindSchema = z.enum(STEWARD_ATTACHED_KINDS);
export const stewardMemorySourceSchema = z.enum(STEWARD_MEMORY_SOURCES);
export const stewardMessageRoleSchema = z.enum(STEWARD_MESSAGE_ROLES);

const stageModelSchema = z.strictObject({ model: z.string().min(1), effort: effortSchema });
const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM");

/**
 * Steward's settings (03 Decisions), stored under the `steward` key of `setting`. `complexity`
 * maps a promoted task's rating to a model and effort, or to null for "report only".
 */
export const stewardSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  workingHours: z.strictObject({
    start: clockTimeSchema,
    end: clockTimeSchema,
    /** ISO weekdays: 1 is Monday, 7 is Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1),
  }),
  wakeIntervalMin: z.number().int().min(1),
  ghPollIntervalMin: z.number().int().min(1),
  stages: z.strictObject({ gather: stageModelSchema, decide: stageModelSchema }),
  complexity: z.strictObject({
    simple: stageModelSchema.nullable(),
    medium: stageModelSchema.nullable(),
    hard: stageModelSchema.nullable(),
  }),
  /** Daily token caps by model family (`haiku`, `sonnet`, `opus`); a family without one is uncapped. */
  dailyCaps: z.record(z.string().min(1), z.number().int().positive()),
  /** Minutes a decide or promoted call may run. Gather has no limit. */
  stageTimeoutMin: z.number().int().positive(),
  memoryCoreTokens: z.number().int().positive(),
  prSignals: z.array(z.enum(PR_SIGNALS)),
  /** Sources to read: GitHub through `gh`, and the connectors of the machine's Claude Code. */
  sources: z.strictObject({
    github: z.boolean(),
    slack: z.boolean(),
    googleDrive: z.boolean(),
    /** The read tools of every other connected connector (Jira, Confluence, Gmail...; SF2). */
    otherConnectors: z.boolean(),
  }),
});
export type StewardSettings = z.infer<typeof stewardSettingsSchema>;

/** Steward starts off: the owner turns it on (it spends tokens). */
export const DEFAULT_STEWARD_SETTINGS: StewardSettings = {
  enabled: false,
  workingHours: { start: "09:00", end: "19:00", days: [1, 2, 3, 4, 5] },
  wakeIntervalMin: 30,
  ghPollIntervalMin: 10,
  stages: {
    gather: { model: "haiku", effort: "low" },
    decide: { model: "sonnet", effort: "low" },
  },
  complexity: {
    simple: { model: "sonnet", effort: "medium" },
    medium: { model: "opus", effort: "high" },
    hard: null,
  },
  dailyCaps: { haiku: 5_000_000, sonnet: 1_500_000, opus: 400_000 },
  stageTimeoutMin: 10,
  memoryCoreTokens: 2000,
  prSignals: [...PR_SIGNALS],
  sources: { github: true, slack: true, googleDrive: true, otherConnectors: true },
};

export const settingSchemas = {
  steward: stewardSettingsSchema,
  mutedKinds: z.array(notificationKindSchema),
  staleAfterDays: z.number().int().positive(),
  summaries: z.strictObject({ enabled: z.boolean() }),
  approvalTimeoutSec: z.number().int().min(10).max(600),
  t3Cli: z.string().min(1),
  claudeCli: z.string().min(1),
  t3Pin: z.strictObject({ serverVersion: z.string().min(1), migration: z.number().int().min(0) }),
} as const;

export function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
      .join("; ");
    throw new AxiomError("validation", `Invalid ${what}: ${detail}`);
  }
  return result.data;
}
