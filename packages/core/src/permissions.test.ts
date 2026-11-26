import { describe, expect, it } from "vitest";
import { cleanSuggestions, describePermissionUpdate, updatesToApply } from "./permissions.js";

// What Claude Code 2.1.325 sent in `permission_suggestions` (2026-11-26).
const NPM_RULE = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "npm run *" }],
  behavior: "allow",
  destination: "localSettings",
};
const ACCEPT_EDITS = { type: "setMode", mode: "acceptEdits", destination: "session" };
const DIRS = { type: "addDirectories", directories: ["/work/other"], destination: "session" };

/** The one cleaned update of a suggestion that must survive cleaning. */
function clean(raw: unknown) {
  const [u] = cleanSuggestions([raw]);
  if (!u) throw new Error("suggestion was dropped");
  return u;
}

describe("cleanSuggestions", () => {
  it("keeps the kinds Axiom passes on, drops extra fields and duplicates", () => {
    expect(cleanSuggestions([{ ...NPM_RULE, extra: 1 }, NPM_RULE, ACCEPT_EDITS, DIRS])).toEqual([
      NPM_RULE,
      ACCEPT_EDITS,
      DIRS,
    ]);
  });

  it("drops what is not an allow choice or cannot work from a hook", () => {
    expect(
      cleanSuggestions([
        { ...NPM_RULE, behavior: "deny" },
        { type: "setMode", mode: "bypassPermissions", destination: "session" },
        { type: "setMode", mode: "plan", destination: "session" },
        {
          type: "removeRules",
          rules: [{ toolName: "Bash" }],
          behavior: "allow",
          destination: "session",
        },
        { ...NPM_RULE, destination: "cliArg" },
        { ...NPM_RULE, rules: [{ toolName: "Bash", ruleContent: "x".repeat(501) }] },
        "nonsense",
        null,
      ]),
    ).toEqual([]);
    expect(cleanSuggestions(undefined)).toEqual([]);
    expect(cleanSuggestions({ type: "addRules" })).toEqual([]);
  });

  it("keeps at most six", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...DIRS, directories: [`/d${i}`] }));
    expect(cleanSuggestions(many)).toHaveLength(6);
  });
});

describe("describePermissionUpdate", () => {
  it("says the choice the way the terminal prompt does", () => {
    expect(describePermissionUpdate(clean(NPM_RULE))).toBe(
      "Always allow Bash(npm run *) in this project",
    );
    expect(describePermissionUpdate(clean(ACCEPT_EDITS))).toBe("Accept all edits for this session");
    expect(describePermissionUpdate(clean(DIRS))).toBe(
      "Allow access to /work/other for this session",
    );
    const toolOnly = clean({
      type: "addRules",
      rules: [{ toolName: "WebFetch" }],
      behavior: "allow",
      destination: "userSettings",
    });
    expect(describePermissionUpdate(toolOnly)).toBe("Always allow WebFetch in every project");
  });
});

describe("updatesToApply", () => {
  it("adds a session copy to a saved rule, which would not reach the running session", () => {
    const rule = clean(NPM_RULE);
    expect(updatesToApply(rule)).toEqual([{ ...NPM_RULE, destination: "session" }, NPM_RULE]);
  });

  it("sends a session choice and a mode change as they are", () => {
    expect(updatesToApply(clean(ACCEPT_EDITS))).toEqual([ACCEPT_EDITS]);
    expect(updatesToApply(clean(DIRS))).toEqual([DIRS]);
  });
});
