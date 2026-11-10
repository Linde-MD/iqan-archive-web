import { orderedBranches, type Branch, type Edge, type ProjectGraph, type VersionNode } from './model';
import { compareVersionNodes, compareVersions, type VersionOrder } from './version-order';

export const GIT_GRAPH = {
  headerHeight: 40,
  rowHeight: 56,
  laneGap: 26,
  laneStart: 14,
  labelMinWidth: 720,
} as const;

export interface GitGraphRow {
  node: VersionNode;
  rowIndex: number;
  laneIndex: number;
  isolated: boolean;
  branchHeads: Branch[];
}

export interface GitGraphEdge extends Edge {
  color: string;
  fromRow: number;
  toRow: number;
  fromLane: number;
  toLane: number;
}

export function gitGraphEdgePath(edge: GitGraphEdge): string {
  const startX = GIT_GRAPH.laneStart + edge.fromLane * GIT_GRAPH.laneGap;
  const endX = GIT_GRAPH.laneStart + edge.toLane * GIT_GRAPH.laneGap;
  const startY = GIT_GRAPH.headerHeight + edge.fromRow * GIT_GRAPH.rowHeight + GIT_GRAPH.rowHeight / 2;
  const endY = GIT_GRAPH.headerHeight + edge.toRow * GIT_GRAPH.rowHeight + GIT_GRAPH.rowHeight / 2;
  if (startX === endX) return `M ${startX} ${startY} L ${endX} ${endY}`;
  const step = Math.sign(endY - startY) * Math.min(GIT_GRAPH.rowHeight, Math.abs(endY - startY));
  if (endX > startX) {
    const turnY = startY + step;
    const midY = startY + step / 2;
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${turnY} L ${endX} ${endY}`;
  }
  const turnY = endY - step;
  const midY = endY - step / 2;
  return `M ${startX} ${startY} L ${startX} ${turnY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
}

export interface GitGraphLayout {
  rows: GitGraphRow[];
  edges: GitGraphEdge[];
  branchTracks: Branch[];
  trackCount: number;
  trackWidth: number;
  width: number;
  height: number;
  memberships: Map<string, Branch[]>;
}

function branchHistory(branch: Branch, parents: Map<string, string[]>): Set<string> {
  const history = new Set<string>();
  const pending = [branch.headId];
  while (pending.length) {
    const id = pending.pop()!;
    if (history.has(id)) continue;
    history.add(id);
    pending.push(...(parents.get(id) ?? []));
  }
  return history;
}

function branchTrackHistory(
  branch: Branch,
  parents: Map<string, string[]>,
  memberships: Map<string, Branch[]>,
): Set<string> {
  const history = branchHistory(branch, parents);
  const trackRows = new Set<string>();
  for (const id of history) {
    const nodeBranches = memberships.get(id) ?? [];
    const branchHead = id === branch.headId;
    const exclusive = nodeBranches.length === 1 && nodeBranches[0]!.id === branch.id;
    if (!branchHead && !exclusive) continue;
    trackRows.add(id);
    for (const parentId of parents.get(id) ?? []) {
      const parentBranches = memberships.get(parentId) ?? [];
      if (history.has(parentId) && parentBranches.some(item => item.id !== branch.id))
        trackRows.add(parentId);
    }
  }
  return trackRows;
}

function orderedNodes(graph: ProjectGraph, order: VersionOrder): VersionNode[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const adjacent = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const degree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    const from = order === 'oldest' ? edge.parentId : edge.childId;
    const to = order === 'oldest' ? edge.childId : edge.parentId;
    adjacent.get(from)!.push(to);
    degree.set(to, degree.get(to)! + 1);
  }
  const ready = graph.nodes.filter(node => degree.get(node.id) === 0);
  const result: VersionNode[] = [];
  while (ready.length) {
    ready.sort((a, b) => compareVersionNodes(a, b, order));
    const node = ready.shift()!;
    result.push(node);
    for (const id of adjacent.get(node.id)!) {
      degree.set(id, degree.get(id)! - 1);
      if (degree.get(id) === 0) ready.push(byId.get(id)!);
    }
  }
  return result;
}

export function layoutGitGraph(
  graph: ProjectGraph,
  order: VersionOrder,
  branchIds: readonly string[] | null = null,
  hideIsolated = false,
  visibleNodeIds: ReadonlySet<string> | null = null,
): GitGraphLayout {
  const selectedIds = branchIds === null ? null : new Set(branchIds);
  const allBranches = orderedBranches(graph.branches);
  const branchTracks = selectedIds === null
    ? allBranches
    : allBranches.filter(branch => selectedIds.has(branch.id));
  const parents = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const children = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const incident = new Set<string>();
  for (const edge of graph.edges) {
    parents.get(edge.childId)!.push(edge.parentId);
    children.get(edge.parentId)!.push(edge.childId);
    incident.add(edge.parentId);
    incident.add(edge.childId);
  }
  const allMemberships = new Map<string, Branch[]>();
  for (const branch of allBranches) {
    for (const id of branchHistory(branch, parents)) {
      const branches = allMemberships.get(id) ?? [];
      branches.push(branch);
      allMemberships.set(id, branches);
    }
  }
  const memberships = new Map(
    [...allMemberships].map(([id, branches]) => [
      id,
      selectedIds === null ? branches : branches.filter(branch => selectedIds.has(branch.id)),
    ]),
  );
  const visible = new Set<string>();
  if (selectedIds === null) {
    for (const node of graph.nodes) visible.add(node.id);
  } else {
    for (const branch of branchTracks) {
      for (const id of branchHistory(branch, parents)) visible.add(id);
    }
    for (const node of graph.nodes) if (!incident.has(node.id)) visible.add(node.id);
  }

  if (visibleNodeIds) {
    for (const id of visible) if (!visibleNodeIds.has(id)) visible.delete(id);
  }

  if (hideIsolated) {
    for (const id of visible) if (!incident.has(id)) visible.delete(id);
  }
  const allRows = orderedNodes(graph, order).filter(node => visible.has(node.id));
  const rowIndexById = new Map(allRows.map((node, rowIndex) => [node.id, rowIndex]));
  const branchIntervals = branchTracks.flatMap((branch, branchOrder) => {
    const rowIndexes = [...branchTrackHistory(branch, parents, memberships)]
      .flatMap(id => rowIndexById.has(id) ? [rowIndexById.get(id)!] : []);
    if (!rowIndexes.length) return [];
    return [{
      branch,
      branchOrder,
      start: Math.min(...rowIndexes),
      end: Math.max(...rowIndexes),
    }];
  }).sort((left, right) => left.start - right.start || left.branchOrder - right.branchOrder);
  const backboneBranch = branchTracks.find(branch => allRows.some(node => {
    const nodeBranches = memberships.get(node.id) ?? [];
    return nodeBranches.length > 1 && nodeBranches.some(item => item.id === branch.id);
  }));
  const backboneInterval = branchIntervals.find(interval => interval.branch.id === backboneBranch?.id);
  const firstReusableLane = backboneInterval ? 1 : 0;
  const trackEnds: number[] = backboneInterval ? [backboneInterval.end] : [];
  const trackPriorities: number[] = backboneInterval ? [backboneInterval.branchOrder] : [];
  const provisionalBranchLanes = new Map<string, number>();
  if (backboneInterval) provisionalBranchLanes.set(backboneInterval.branch.id, 0);
  for (const interval of branchIntervals) {
    if (interval.branch.id === backboneInterval?.branch.id) continue;
    let laneIndex = -1;
    for (let candidate = firstReusableLane; candidate < trackEnds.length; candidate++) {
      if (trackEnds[candidate]! < interval.start) {
        laneIndex = candidate;
        break;
      }
    }
    if (laneIndex < 0) laneIndex = Math.max(firstReusableLane, trackEnds.length);
    trackEnds[laneIndex] = interval.end;
    trackPriorities[laneIndex] = Math.min(trackPriorities[laneIndex] ?? interval.branchOrder, interval.branchOrder);
    provisionalBranchLanes.set(interval.branch.id, laneIndex);
  }
  const secondaryLaneOrder = trackPriorities
    .map((priority, laneIndex) => ({ priority, laneIndex }))
    .filter(({ laneIndex }) => laneIndex >= firstReusableLane)
    .sort((left, right) => left.priority - right.priority || left.laneIndex - right.laneIndex)
    .map(item => item.laneIndex);
  const laneRemap = new Map<number, number>();
  if (backboneInterval) laneRemap.set(0, 0);
  secondaryLaneOrder.forEach((laneIndex, index) => laneRemap.set(laneIndex, firstReusableLane + index));
  const branchLaneById = new Map<string, number>();
  for (const [branchId, laneIndex] of provisionalBranchLanes)
    branchLaneById.set(branchId, laneRemap.get(laneIndex)!);
  const branchLaneCount = firstReusableLane + secondaryLaneOrder.length;
  const unbranchedLanes = new Map<string, number>();
  let nextUnbranchedLane = branchLaneCount;
  for (const node of allRows) {
    if (!incident.has(node.id) || (memberships.get(node.id)?.length ?? 0) > 0) continue;
    const nodeParents = parents.get(node.id) ?? [];
    if (nodeParents.length !== 1) {
      unbranchedLanes.set(node.id, nextUnbranchedLane++);
      continue;
    }

    const parentId = nodeParents[0]!;
    const siblings = (children.get(parentId) ?? []).filter(id => visible.has(id));
    const parentHasBranch = (memberships.get(parentId)?.length ?? 0) > 0;
    const inheritedLane = unbranchedLanes.get(parentId);
    if (siblings.length === 1 && !parentHasBranch && inheritedLane !== undefined) {
      unbranchedLanes.set(node.id, inheritedLane);
    } else {
      unbranchedLanes.set(node.id, nextUnbranchedLane++);
    }
  }
  const isolatedLane = Math.max(branchLaneCount + 1, nextUnbranchedLane);
  const trackCount = isolatedLane + 1;
  const rows = allRows.map((node, rowIndex): GitGraphRow => {
    const isolated = !incident.has(node.id);
    const nodeBranches = memberships.get(node.id) ?? [];
    const headBranch = branchTracks.find(branch => branch.headId === node.id && branchLaneById.has(branch.id));
    const membershipBranch = nodeBranches.find(branch => branchLaneById.has(branch.id));
    const headTrack = headBranch ? branchLaneById.get(headBranch.id)! : -1;
    const membershipTrack = membershipBranch ? branchLaneById.get(membershipBranch.id)! : -1;
    const branchHeads = branchTracks.filter(branch => branch.headId === node.id);
    return {
      node,
      rowIndex,
      laneIndex: isolated ? isolatedLane
        : headTrack >= 0 ? headTrack
          : membershipTrack >= 0 ? membershipTrack
            : unbranchedLanes.get(node.id) ?? branchLaneCount,
      isolated,
      branchHeads,
    };
  });
  const rowById = new Map(rows.map(row => [row.node.id, row]));
  const edges = graph.edges.flatMap(edge => {
    const parent = rowById.get(edge.parentId);
    const child = rowById.get(edge.childId);
    if (!parent || !child) return [];
    const branch = (memberships.get(child.node.id) ?? []).find(item =>
      (memberships.get(parent.node.id) ?? []).some(parentBranch => parentBranch.id === item.id));
    return [{
      ...edge,
      color: branch?.color ?? '#8799b2',
      fromRow: parent.rowIndex,
      toRow: child.rowIndex,
      fromLane: parent.laneIndex,
      toLane: child.laneIndex,
    }];
  });
  const trackWidth = GIT_GRAPH.laneStart + trackCount * GIT_GRAPH.laneGap + 14;
  const longestLabel = rows.reduce<number>((width, row) => {
    const branchesWidth = row.branchHeads.reduce((sum, branch) => sum + branch.name.length * 8 + 30, 0);
    return Math.max(width, row.node.version.length * 9 + Math.min(row.node.description.length * 7, 640) + branchesWidth);
  }, GIT_GRAPH.labelMinWidth);
  return {
    rows,
    edges,
    branchTracks,
    trackCount,
    trackWidth,
    width: trackWidth + longestLabel,
    height: rows.length * GIT_GRAPH.rowHeight,
    memberships,
  };
}

export function recommendedParentNodes(
  graph: ProjectGraph,
  version: string,
  excludedNodeId: string | null,
): VersionNode[] {
  const descendants = new Set<string>();
  if (excludedNodeId) {
    const children = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
    for (const edge of graph.edges) children.get(edge.parentId)!.push(edge.childId);
    const pending = [...(children.get(excludedNodeId) ?? [])];
    while (pending.length) {
      const id = pending.pop()!;
      if (descendants.has(id)) continue;
      descendants.add(id);
      pending.push(...(children.get(id) ?? []));
    }
  }
  const candidates = graph.nodes.filter(node => node.id !== excludedNodeId && !descendants.has(node.id));
  const byVersion = [...candidates].sort((a, b) => compareVersions(a.version, b.version) || a.id.localeCompare(b.id));
  const indexById = new Map(byVersion.map((node, index) => [node.id, index]));
  const insertion = byVersion.findIndex(node => compareVersions(node.version, version) >= 0);
  const targetIndex = insertion < 0 ? byVersion.length : insertion;
  return candidates.sort((a, b) => {
    const aIndex = indexById.get(a.id)!;
    const bIndex = indexById.get(b.id)!;
    const distance = Math.abs(aIndex - targetIndex) - Math.abs(bIndex - targetIndex);
    return distance || compareVersions(a.version, b.version) || a.id.localeCompare(b.id);
  });
}
