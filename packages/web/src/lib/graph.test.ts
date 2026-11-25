import { describe, expect, it } from "vitest";
import { layoutGraph, NODE_W } from "./graph";

const t = (key: string, ...dependsOn: string[]) => ({ key, dependsOn });

describe("layoutGraph", () => {
  it("puts prerequisites in earlier columns, by longest chain", () => {
    const g = layoutGraph([t("A"), t("B", "A"), t("C", "B"), t("D", "A", "C")]);
    const layer = Object.fromEntries(g.nodes.map((n) => [n.key, n.layer]));
    expect(layer).toEqual({ A: 0, B: 1, C: 2, D: 3 });
    const x = Object.fromEntries(g.nodes.map((n) => [n.key, n.x]));
    expect(x.A as number).toBeLessThan(x.B as number);
    expect(g.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["A>B", "A>D", "B>C", "C>D"]);
  });

  it("never overlaps two nodes of one column, and every edge runs left to right", () => {
    const g = layoutGraph([
      t("S0"),
      t("S1", "S0"),
      t("S2", "S1"),
      t("S3", "S2"),
      t("S4", "S1"),
      t("S5", "S4"),
      t("S5b", "S5"),
      t("S6", "S3", "S4"),
      t("S7", "S2", "S3", "S5"),
    ]);
    const seen = new Set<string>();
    for (const n of g.nodes) {
      const k = `${n.x}:${n.y}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      expect(n.x + NODE_W).toBeLessThanOrEqual(g.width);
      expect(n.y).toBeLessThan(g.height);
    }
    const at = new Map(g.nodes.map((n) => [n.key, n]));
    for (const e of g.edges) {
      expect((at.get(e.from) as { x: number }).x).toBeLessThan((at.get(e.to) as { x: number }).x);
    }
    expect(g.nodes).toHaveLength(9);
  });

  it("copes with no tasks, unknown dependencies and independent tasks", () => {
    expect(layoutGraph([]).nodes).toEqual([]);
    const g = layoutGraph([t("A", "ghost"), t("B")]);
    expect(g.edges).toEqual([]);
    expect(g.nodes.map((n) => n.layer)).toEqual([0, 0]);
  });
});
