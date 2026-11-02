import { validateGraph } from './graph';
import type { ProjectGraph } from './model';
import { compareVersionNodes, type VersionOrder } from './version-order';

export interface Point {
  x: number;
  y: number;
}

export interface NodeSize {
  width: number;
  height: number;
}

export interface GraphLayout {
  positions: Map<string, Point>;
  nodeSizes: Map<string, NodeSize>;
  width: number;
  height: number;
}

export const LAYOUT = {
  nodeWidth: 296,
  nodeHeight: 76,
  versionLineHeight: 20,
  versionLineCapacity: 31,
  horizontalGap: 112,
  verticalGap: 48,
} as const;

export function versionLines(version: string): string[] {
  const lines: string[] = [];
  let characters: string[] = [];
  let lineWidth = 0;
  for (const character of version) {
    const width = (character.codePointAt(0) ?? 0) >= 0x2e80 ? 1.75 : 1;
    if (characters.length && lineWidth + width > LAYOUT.versionLineCapacity) {
      let lastSpace = -1;
      for (let index = characters.length - 1; index >= 0; index--) {
        if (/\s/u.test(characters[index]!)) {
          lastSpace = index;
          break;
        }
      }
      const lastHyphen = characters.lastIndexOf('-');
      const breakAt = lastSpace >= 0 ? lastSpace : lastHyphen;
      if (breakAt >= 0) {
        lines.push(characters.slice(0, breakAt + 1).join(''));
        characters = characters.slice(breakAt + 1);
        lineWidth = characters.reduce((sum, value) => sum + ((value.codePointAt(0) ?? 0) >= 0x2e80 ? 1.75 : 1), 0);
      } else {
        lines.push(characters.join(''));
        characters = [];
        lineWidth = 0;
      }
    }
    characters.push(character);
    lineWidth += width;
  }
  if (characters.length || lines.length === 0) lines.push(characters.join(''));
  return lines;
}

export function nodeSizeForVersion(version: string): NodeSize {
  return {
    width: LAYOUT.nodeWidth,
    height: LAYOUT.nodeHeight + (versionLines(version).length - 1) * LAYOUT.versionLineHeight,
  };
}

export function relationForDropPoint(
  position: Point,
  point: Point,
  order: VersionOrder,
  size: NodeSize = { width: LAYOUT.nodeWidth, height: LAYOUT.nodeHeight },
): 'parent' | 'child' {
  const left = position.x;
  const right = left + size.width;
  const top = position.y;
  const bottom = top + size.height;
  const dx = Math.max(left - point.x, 0, point.x - right);
  const dy = Math.max(top - point.y, 0, point.y - bottom);
  if (dx === 0 && dy === 0) return 'child';

  if (dy >= dx) {
    if (point.y < top) return order === 'oldest' ? 'parent' : 'child';
    return order === 'oldest' ? 'child' : 'parent';
  }
  return point.x < left ? 'parent' : 'child';
}

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
    return { positions: new Map(), nodeSizes: new Map(), width: 0, height: 0 };
  }
  const nodeSizes = new Map(graph.nodes.map(node => [node.id, nodeSizeForVersion(node.version)]));
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
  const rowHeights: number[] = Array.from({ length: maxLevelCount }, () => LAYOUT.nodeHeight);
  for (const ids of levels.values()) {
    for (const id of ids) {
      const row = order.get(id)!;
      rowHeights[row] = Math.max(rowHeights[row]!, nodeSizes.get(id)!.height);
    }
  }
  const rowOffsets: number[] = [];
  let height = 0;
  for (const [index, rowHeight] of rowHeights.entries()) {
    rowOffsets.push(height);
    height += rowHeight;
    if (index < rowHeights.length - 1) height += LAYOUT.verticalGap;
  }
  const positions = new Map<string, Point>();
  for (const id of nodeIds) {
    const level = depth.get(id)!;
    positions.set(id, {
      x: level * (LAYOUT.nodeWidth + LAYOUT.horizontalGap),
      y: rowOffsets[order.get(id)!]!,
    });
  }
  const width = (maxDepth + 1) * LAYOUT.nodeWidth + maxDepth * LAYOUT.horizontalGap;
  return { positions, nodeSizes, width, height };
}
