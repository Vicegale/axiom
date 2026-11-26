import type { Link, TaskDetail, TopicDetail } from "@axiom/core";
import { describe, expect, it } from "vitest";
import { briefing } from "./briefing.js";

const topic = (over: Partial<TopicDetail> = {}): TopicDetail =>
  ({
    slug: "fix-import",
    title: "Fix the importer",
    status: "idle",
    statusNote: null,
    goal: null,
    links: [],
    ...over,
  }) as TopicDetail;

const task = (key: string, status: TaskDetail["status"], waiting = false): TaskDetail =>
  ({
    key,
    title: `Task ${key}`,
    status,
    waiting,
    dependsOn: [],
    dependents: [],
  }) as unknown as TaskDetail;

const link = (kind: string, target: string): Link => ({ kind, target }) as Link;

describe("briefing", () => {
  it("names the topic, says it is attached, and ends with the owner's message", () => {
    const b = briefing(topic(), [], "Mark this done.");
    expect(b).toMatch(/^\[Axiom\] This thread is tracked in Axiom/);
    expect(b).toContain('- Topic: `fix-import`, "Fix the importer" (status: idle).');
    expect(b).toContain("`axiom thread attach fix-import`");
    expect(b).toContain("- Tasks: none yet.");
    expect(b.endsWith("Message from the owner:\n\nMark this done.")).toBe(true);
  });

  it("adds the goal, status note, open tasks and where the work lives", () => {
    const b = briefing(
      topic({
        goal: "Imports never drop rows",
        statusNote: "Parser done",
        links: [link("repository", "/w/app"), link("artifact", "/tmp/x.html"), link("pr", "o/r#3")],
      }),
      [task("S1", "done"), task("S2", "wip"), task("S3", "to do", true)],
      "Go on",
    );
    expect(b).toContain("- Goal: Imports never drop rows");
    expect(b).toContain("- Status note: Parser done");
    expect(b).toContain(
      "- Tasks: 1 of 3 done.\n  - S2 (wip): Task S2\n  - S3 (to do, waiting): Task S3",
    );
    expect(b).toContain("- Links: repository /w/app; pr o/r#3");
    expect(b).not.toContain("artifact");
  });

  it("lists at most eight open tasks", () => {
    const tasks = Array.from({ length: 11 }, (_, i) => task(`T${i}`, "to do"));
    const b = briefing(topic(), tasks, "x");
    expect(b).toContain("  - T7 (to do)");
    expect(b).not.toContain("  - T8 (to do)");
    expect(b).toContain("  - and 3 more open.");
  });

  it("lists the topic's open Steward items compactly, with a ready fix", () => {
    const item = (over: Record<string, unknown>) =>
      ({
        kind: "finding",
        level: "attention",
        title: "CI is red",
        fixBranch: null,
        ...over,
      }) as never;
    const b = briefing(topic(), [], "x", [
      item({ fixBranch: "steward/fix-ci" }),
      item({ kind: "question", level: null, title: "Keep the flag?" }),
    ]);
    expect(b).toContain("axiom steward items --topic fix-import");
    expect(b).toContain("  - finding, attention: CI is red, fix ready on steward/fix-ci");
    expect(b).toContain("  - question: Keep the flag?");
    expect(briefing(topic(), [], "x")).not.toContain("Steward");
  });
});
