/**
 * Claude Code's "don't ask again" choices for a permission request (02, Q12; docs/plan/desk.md,
 * D13).
 *
 * The `PermissionRequest` hook's input carries `permission_suggestions`: the same choices the
 * terminal prompt offers ("Yes, and don't ask again for `npm run *` in this project", "accept all
 * edits this session", ...). The owner can pick one on the Desk card; the hook then answers allow
 * with `updatedPermissions`, and Claude Code applies it.
 *
 * Verified 2026-11-26 with `claude -p` 2.1.325: an `addRules` update with destination `session`
 * stops later prompts at once; destination `localSettings` writes `.claude/settings.local.json`
 * but does not cover the running session (the next matching call still asked), so a saved rule is
 * sent twice, once for the session and once for the file. `setMode` `acceptEdits` works;
 * `bypassPermissions` is ignored from a hook, so it is never offered.
 */
import { z } from "zod";

const MAX_SUGGESTIONS = 6;
const MAX_TEXT = 500;

const text = z.string().min(1).max(MAX_TEXT);
const destination = z.enum(["session", "localSettings", "projectSettings", "userSettings"]);
export type PermissionDestination = z.infer<typeof destination>;

const rule = z.object({ toolName: text, ruleContent: text.optional() });

/** One update Claude Code accepts in a hook's `updatedPermissions` (the kinds Axiom passes on). */
export const permissionUpdateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addRules"),
    rules: z.array(rule).min(1).max(10),
    behavior: z.literal("allow"),
    destination,
  }),
  z.object({
    type: z.literal("setMode"),
    // `bypassPermissions` is ignored from a hook; `plan` and `dontAsk` are not "allow" choices.
    mode: z.literal("acceptEdits"),
    destination,
  }),
  z.object({
    type: z.literal("addDirectories"),
    directories: z.array(text).min(1).max(10),
    destination,
  }),
]);
export type PermissionUpdate = z.infer<typeof permissionUpdateSchema>;

/**
 * The suggestions worth offering, from the hook's untrusted input: the kinds above, extra fields
 * dropped, duplicates and anything else left out. Never throws.
 */
export function cleanSuggestions(raw: unknown): PermissionUpdate[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionUpdate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = permissionUpdateSchema.safeParse(item);
    if (!parsed.success) continue;
    const key = JSON.stringify(parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

const WHERE: Record<PermissionDestination, string> = {
  session: "for this session",
  localSettings: "in this project",
  projectSettings: "in this project (shared settings)",
  userSettings: "in every project",
};

const ruleText = (r: { toolName: string; ruleContent?: string }) =>
  r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;

/** The choice as the card and the history say it, e.g. "Always allow Bash(npm run *) in this project". */
export function describePermissionUpdate(u: PermissionUpdate): string {
  switch (u.type) {
    case "addRules":
      return `Always allow ${u.rules.map(ruleText).join(", ")} ${WHERE[u.destination]}`;
    case "setMode":
      return `Accept all edits ${WHERE[u.destination]}`;
    case "addDirectories":
      return `Allow access to ${u.directories.join(", ")} ${WHERE[u.destination]}`;
  }
}

/**
 * What the hook sends for a chosen suggestion: the suggestion itself, plus a session copy when it
 * is saved to a settings file, since a saved rule does not reach the running session.
 */
export function updatesToApply(choice: PermissionUpdate): PermissionUpdate[] {
  if (choice.destination === "session" || choice.type === "setMode") return [choice];
  return [{ ...choice, destination: "session" }, choice];
}
