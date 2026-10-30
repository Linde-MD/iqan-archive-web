import type { ProjectGraph, VersionNode } from './model';
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

export function compareVersionNodes(a: VersionNode, b: VersionNode, order: VersionOrder): number {
  return (order === 'oldest' ? 1 : -1) * (compareVersions(a.version, b.version) || compareText(a.id, b.id));
}

/** Parent constraints take precedence over version order in the flat list. */
export function orderedVersionNodes(graph: ProjectGraph, order: VersionOrder): VersionNode[] {
  validateGraph(graph);
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  const children = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const edge of graph.edges) {
    indegree.set(edge.childId, indegree.get(edge.childId)! + 1);
    children.get(edge.parentId)!.push(edge.childId);
  }
  const ready = graph.nodes.filter(node => indegree.get(node.id) === 0);
  const result: VersionNode[] = [];
  while (ready.length) {
    ready.sort((a, b) => compareVersionNodes(a, b, order));
    const node = ready.shift()!;
    result.push(node);
    for (const id of children.get(node.id)!) {
      indegree.set(id, indegree.get(id)! - 1);
      if (indegree.get(id) === 0) ready.push(byId.get(id)!);
    }
  }
  return result;
}
