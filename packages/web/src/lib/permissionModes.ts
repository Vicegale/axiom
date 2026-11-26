import type { PermissionMode } from "../api";
import type { ChipOption } from "../components/desk/ChipMenu";

/**
 * The permission modes the composer offers for a Claude Code run (`claude --permission-mode`;
 * server `sending.ts`). "Ask" is Claude Code's default: every prompt comes to the card.
 */
export const PERMISSION_MODE_OPTIONS: (ChipOption & { value: PermissionMode })[] = [
  { value: "manual", label: "Ask", hint: "Asks before edits and commands, on the card" },
  { value: "acceptEdits", label: "Accept edits", hint: "File edits run; other commands ask" },
  { value: "auto", label: "Auto", hint: "Claude Code runs what it judges safe, asks for the rest" },
  { value: "plan", label: "Plan", hint: "Plans only; changes nothing" },
  {
    value: "bypassPermissions",
    label: "Bypass",
    hint: "Never asks: anything runs, destructive commands too",
    separated: true,
  },
];

export const permissionModeLabel = (mode: PermissionMode | null | undefined): string =>
  PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? "Ask";

/** Why a T3 thread has no choice here. */
export const T3_PERMISSIONS_HINT =
  "T3 keeps its own permission mode for a thread, and its CLI cannot set one; change it in T3.";
