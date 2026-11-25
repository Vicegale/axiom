/**
 * Layered left-to-right layout for the task dependency graph (09). Pure: no DOM, no clock.
 *
 * A task's layer is the length of the longest chain of prerequisites before it, so every arrow
 * points to the right. Inside a layer the order is improved by a few barycenter sweeps to cut
 * crossings. Small on purpose (tens of tasks), so no layout library.
 */

export interface GraphInput {
  key: string;
  dependsOn: readonly string[];
}

export interface GraphNode {
  key: string;
  layer: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  /** The prerequisite. */
  from: string;
  /** The task that waits for it. */
  to: string;
  /** SVG path from the prerequisite's right edge to the waiting task's left edge. */
  d: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const NODE_W = 156;
export const NODE_H = 46;
const GAP_X = 52;
const GAP_Y = 14;
const PAD = 20;

export function layoutGraph(tasks: readonly GraphInput[]): GraphLayout {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layerFor = (key: string): number => {
    const known = layerOf.get(key);
    if (known !== undefined) return known;
    // Axiom rejects cycles; the guard only keeps a corrupt payload from recursing forever.
    if (visiting.has(key)) return 0;
    visiting.add(key);
    let layer = 0;
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      if (byKey.has(dep)) layer = Math.max(layer, layerFor(dep) + 1);
    }
    visiting.delete(key);
    layerOf.set(key, layer);
    return layer;
  };
  for (const t of tasks) layerFor(t.key);

  const depth = Math.max(-1, ...layerOf.values()) + 1;
  const columns: string[][] = Array.from({ length: depth }, () => []);
  for (const t of tasks) columns[layerOf.get(t.key) ?? 0]?.push(t.key);

  // Neighbours in the layers on either side, for the barycenter sweeps.
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byKey.has(dep)) continue;
      before.set(t.key, [...(before.get(t.key) ?? []), dep]);
      after.set(dep, [...(after.get(dep) ?? []), t.key]);
    }
  }
  const slot = new Map<string, number>();
  const index = () => {
    for (const col of columns) col.forEach((k, i) => void slot.set(k, i));
  };
  index();
  const sweep = (col: string[], neighbours: Map<string, string[]>) => {
    const score = (k: string) => {
      const ns = neighbours.get(k) ?? [];
      if (!ns.length) return slot.get(k) ?? 0;
      return ns.reduce((sum, n) => sum + (slot.get(n) ?? 0), 0) / ns.length;
    };
    const order = new Map(col.map((k, i) => [k, i]));
    col.sort((a, b) => score(a) - score(b) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
    index();
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < columns.length; i++) sweep(columns[i] as string[], before);
    for (let i = columns.length - 2; i >= 0; i--) sweep(columns[i] as string[], after);
  }

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const colHeight = (n: number) => n * NODE_H + (n - 1) * GAP_Y;
  const nodes: GraphNode[] = [];
  const at = new Map<string, GraphNode>();
  columns.forEach((col, layer) => {
    const top = PAD + (colHeight(tallest) - colHeight(col.length)) / 2;
    col.forEach((key, i) => {
      const node = { key, layer, x: PAD + layer * (NODE_W + GAP_X), y: top + i * (NODE_H + GAP_Y) };
      nodes.push(node);
      at.set(key, node);
    });
  });

  const edges: GraphEdge[] = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      const a = at.get(dep);
      const b = at.get(t.key);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const bend = Math.max(GAP_X / 2, (x2 - x1) / 2);
      edges.push({
        from: dep,
        to: t.key,
        d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`,
      });
    }
  }

  return {
    nodes,
    edges,
    width: PAD * 2 + Math.max(1, depth) * NODE_W + Math.max(0, depth - 1) * GAP_X,
    height: PAD * 2 + colHeight(tallest),
  };
}
