import { validateGraph } from './graph';
import type { ProjectGraph } from './model';
import { compareVersionNodes, type VersionOrder } from './version-order';

export interface Point {
  x: number;
  y: number;
}

export interface GraphLayout {
  positions: Map<string, Point>;
  width: number;
  height: number;
}

export const LAYOUT = {
  nodeWidth: 200,
  nodeHeight: 56,
  horizontalGap: 96,
  verticalGap: 44,
} as const;

/**
 * Layered DAG layout (Sugiyama first pass).
 * Depth is the longest path from any root, so merge targets land after all
 * their parents. Within a level nodes are ordered by the average index of
 * their parents to reduce edge crossings. Deterministic and free of external
 * dependencies.
 */
export function layoutDag(graph: ProjectGraph, versionOrder: VersionOrder = 'oldest'): GraphLayout {
  validateGraph(graph);
  const nodeIds = [...graph.nodes].sort((a, b) => compareVersionNodes(a, b, versionOrder)).map(node => node.id);
  if (nodeIds.length === 0) {
    return { positions: new Map(), width: 0, height: 0 };
  }
  const children = new Map(nodeIds.map(id => [id, [] as string[]]));
  const parents = new Map(nodeIds.map(id => [id, [] as string[]]));
  for (const edge of graph.edges) {
    children.get(edge.parentId)!.push(edge.childId);
    parents.get(edge.childId)!.push(edge.parentId);
  }
  const indegree = new Map(nodeIds.map(id => [id, 0]));
  for (const edge of graph.edges) indegree.set(edge.childId, indegree.get(edge.childId)! + 1);
  const depth = new Map<string, number>();
  const queue = nodeIds.filter(id => indegree.get(id) === 0);
  for (const id of queue) depth.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    const current = depth.get(id)!;
    for (const child of children.get(id)!) {
      depth.set(child, Math.max(depth.get(child) ?? 0, current + 1));
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }
  const levels = new Map<number, string[]>();
  for (const [id, level] of depth) {
    const list = levels.get(level) ?? [];
    list.push(id);
    levels.set(level, list);
  }
  const maxDepth = Math.max(0, ...depth.values());
  const order = new Map<string, number>();
  for (const [index, id] of (levels.get(0) ?? []).entries()) order.set(id, index);
  for (let level = 1; level <= maxDepth; level++) {
    const ids = (levels.get(level) ?? []).slice();
    const average = (id: string) => {
      const ps = parents.get(id)!;
      if (ps.length === 0) return 0;
      return ps.reduce((sum, parent) => sum + (order.get(parent) ?? 0), 0) / ps.length;
    };
    ids.sort((a, b) => {
      const diff = average(a) - average(b);
      return diff !== 0 ? diff : nodeIds.indexOf(a) - nodeIds.indexOf(b);
    });
    ids.forEach((id, index) => order.set(id, index));
  }
  let maxLevelCount = 0;
  for (const ids of levels.values()) maxLevelCount = Math.max(maxLevelCount, ids.length);
  const positions = new Map<string, Point>();
  for (const id of nodeIds) {
    const level = depth.get(id)!;
    positions.set(id, {
      x: level * (LAYOUT.nodeWidth + LAYOUT.horizontalGap),
      y: order.get(id)! * (LAYOUT.nodeHeight + LAYOUT.verticalGap),
    });
  }
  const width = (maxDepth + 1) * LAYOUT.nodeWidth + maxDepth * LAYOUT.horizontalGap;
  const height = maxLevelCount * LAYOUT.nodeHeight + (maxLevelCount - 1) * LAYOUT.verticalGap;
  return { positions, width, height };
}
