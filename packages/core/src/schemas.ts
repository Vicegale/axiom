import { z } from "zod";
import {
  type EntryKind,
  LINK_KINDS,
  MONITOR_STATES,
  NOTIFICATION_KINDS,
  PROVIDERS,
  REF_TYPES,
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

export const settingSchemas = {
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
