import { requireCondition, type Edge, type ProjectGraph, type VersionNode } from './model';
import { validateGraph } from './graph';

export type VersionOrder = 'oldest' | 'newest';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNumber(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  return left.length - right.length || compareText(left, right);
}

function naturalCompare(a: string, b: string): number {
  const left = a.match(/\d+|\D+/g) ?? [];
  const right = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!;
    const y = right[i]!;
    const diff = /^\d+$/.test(x) && /^\d+$/.test(y) ? compareNumber(x, y) : compareText(x, y);
    if (diff) return diff;
  }
  return left.length - right.length || compareText(a, b);
}

function parseVersion(value: string) {
  const text = value.trim();
  if (!/^[Vv]\d/.test(text)) return null;
  const date = /[ \t]+(\d{8})(?=$|[ \t-])/.exec(text);
  const core = date ? text.slice(0, date.index) : text;
  const suffix = date ? text.slice(date.index + date[0].length).replace(/^[- \t]+/, '') : '';
  const body = core.slice(1);
  const parts: string[] = [];
  let start = 0;
  // Only major/middle/minor boundaries split; SP-1 belongs to the minor marker.
  for (const separator of body.matchAll(/[.-](?=\d)/g)) {
    if (parts.length === 2) break;
    parts.push(body.slice(start, separator.index));
    start = separator.index + 1;
  }
  parts.push(body.slice(start));
  const levels: { number: string; marker: string }[] = [];
  for (const part of parts) {
    const match = /^(\d+)(?:[- \t]*([A-Za-z][A-Za-z0-9 .\t-]*))?$/.exec(part);
    if (!match) return null;
    levels.push({ number: match[1]!, marker: (match[2] ?? '').trim() });
  }
  while (levels.length < 3) levels.push({ number: '0', marker: '' });
  return { levels, date: date?.[1] ?? '0', suffix };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left && right) {
    for (let i = 0; i < 3; i++) {
      const x = left.levels[i]!;
      const y = right.levels[i]!;
      const diff = compareNumber(x.number, y.number) || naturalCompare(x.marker, y.marker);
      if (diff) return diff;
    }
    const diff = compareNumber(left.date, right.date) || naturalCompare(left.suffix, right.suffix);
    if (diff) return diff;
  } else if (left || right) {
    return left ? -1 : 1;
  }
  return naturalCompare(a, b);
}

export function compareVersionNodes(a: Pick<VersionNode, 'id' | 'version'>, b: Pick<VersionNode, 'id' | 'version'>, order: VersionOrder): number {
  return (order === 'oldest' ? 1 : -1) * (compareVersions(a.version, b.version) || compareText(a.id, b.id));
}

/** Topology takes precedence; newest-first visits children before parents. */
export function orderedVersionNodes<T extends Pick<VersionNode, 'id' | 'version'>>(
  graph: { nodes: readonly T[]; edges: readonly Pick<Edge, 'id' | 'parentId' | 'childId'>[] }, order: VersionOrder,
): T[] {
  if (!('kind' in graph) && 'project' in graph && 'branches' in graph && 'tasks' in graph) validateGraph(graph as unknown as ProjectGraph);
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  requireCondition(indegree.size === graph.nodes.length && graph.nodes.every(node => node.id.trim() && node.version.trim()),
    'DUPLICATE_ID', '版本身份无效或重复。');
  const adjacent = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const edgeIds = new Set<string>(), pairs = new Set<string>();
  for (const edge of graph.edges) {
    requireCondition(edge.id.trim() && !edgeIds.has(edge.id), 'DUPLICATE_ID', '关系 ID 为空或重复。');
    edgeIds.add(edge.id);
    requireCondition(byId.has(edge.parentId) && byId.has(edge.childId), 'NODE_REFERENCE', '父边引用了不存在的节点。');
    const pair = JSON.stringify([edge.parentId, edge.childId]);
    requireCondition(!pairs.has(pair), 'DUPLICATE_EDGE', '父边重复。');
    pairs.add(pair);
    const from = order === 'oldest' ? edge.parentId : edge.childId;
    const to = order === 'oldest' ? edge.childId : edge.parentId;
    indegree.set(to, indegree.get(to)! + 1);
    adjacent.get(from)!.push(to);
  }
  const ready = graph.nodes.filter(node => indegree.get(node.id) === 0);
  const result: T[] = [];
  while (ready.length) {
    ready.sort((a, b) => compareVersionNodes(a, b, order));
    const node = ready.shift()!;
    result.push(node);
    for (const id of adjacent.get(node.id)!) {
      indegree.set(id, indegree.get(id)! - 1);
      if (indegree.get(id) === 0) ready.push(byId.get(id)!);
    }
  }
  requireCondition(result.length === graph.nodes.length, 'CYCLE', '版本关系不能成环。');
  return result;
}
