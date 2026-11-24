import { validateGraph } from './graph';
import { normalizeExternalTaskId, orderedBranches, requireCondition, type ProjectGraph, type Task, type VersionNode } from './model';
import { orderedVersionNodes, type VersionOrder } from './version-order';
import type { ProjectBoardView, TaskSummary, VersionSummary } from './project-views';

export type TaskSearchMode = 'id' | 'keyword' | 'assignee';
export type TaskScope = 'all' | 'mine';

export interface RelatedVersionGroup<T extends VersionSummary = VersionNode> {
  id: string;
  label: string;
  context: string | null;
  nodes: T[];
}

export function projectRelatedVersions<T extends VersionSummary>(
  graph: { nodes: T[]; edges: ProjectGraph['edges']; branches: ProjectGraph['branches']; tasks: readonly Pick<Task, 'id' | 'parentTaskId'>[] },
  taskId: string, includeChildren: boolean, order: VersionOrder,
): RelatedVersionGroup<T>[] {
  const taskIds = new Set([taskId]);
  if (includeChildren) {
    const children = new Map<string, string[]>();
    for (const task of graph.tasks) {
      if (!task.parentTaskId) continue;
      const siblings = children.get(task.parentTaskId) ?? [];
      siblings.push(task.id);
      children.set(task.parentTaskId, siblings);
    }
    const pending = [taskId];
    while (pending.length) {
      for (const id of children.get(pending.pop()!) ?? []) {
        if (taskIds.has(id)) continue;
        taskIds.add(id);
        pending.push(id);
      }
    }
  }
  const selected = new Set(graph.nodes.filter(node => node.taskId && taskIds.has(node.taskId)).map(node => node.id));
  if (!selected.size) return [];

  const oldest = orderedVersionNodes(graph, 'oldest');
  const parents = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const incident = new Set<string>();
  for (const edge of graph.edges) {
    parents.get(edge.childId)!.push(edge.parentId);
    incident.add(edge.parentId);
    incident.add(edge.childId);
  }
  const nearest = new Map<string, Set<string>>();
  const previous = new Map<string, Set<string>>();
  const next = new Map<string, Set<string>>();
  const ancestorCache = new Map<string, Set<string>>();
  const history = (id: string) => {
    if (!ancestorCache.has(id)) {
      const result = new Set<string>();
      const pending = [id];
      while (pending.length) {
        const current = pending.pop()!;
        if (result.has(current)) continue;
        result.add(current);
        pending.push(...(parents.get(current) ?? []));
      }
      ancestorCache.set(id, result);
    }
    return ancestorCache.get(id)!;
  };
  for (const node of oldest) {
    const candidates = new Set((parents.get(node.id) ?? []).flatMap(id => [...(nearest.get(id) ?? [])]));
    if (!selected.has(node.id)) {
      nearest.set(node.id, candidates);
      continue;
    }
    for (const id of candidates) {
      if ([...candidates].some(other => other !== id && history(other).has(id))) candidates.delete(id);
    }
    previous.set(node.id, candidates);
    for (const id of candidates) {
      const successors = next.get(id) ?? new Set<string>();
      successors.add(node.id);
      next.set(id, successors);
    }
    nearest.set(node.id, new Set([node.id]));
  }

  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const groups: RelatedVersionGroup<T>[] = [];
  for (const node of oldest) {
    if (!selected.has(node.id)) continue;
    const prior = [...(previous.get(node.id) ?? [])];
    if (prior.length === 1 && (next.get(prior[0]!)?.size ?? 0) === 1) continue;
    const nodes = [node];
    let current = node.id;
    while ((next.get(current)?.size ?? 0) === 1) {
      const child = [...next.get(current)!][0]!;
      if (previous.get(child)?.size !== 1) break;
      nodes.push(nodeById.get(child)!);
      current = child;
    }
    const matchingBranches = orderedBranches(graph.branches)
      .filter(branch => nodes.every(item => history(branch.headId).has(item.id)));
    const context = (next.get(current)?.size ?? 0) > 1 ? '共同历史'
      : (previous.get(node.id)?.size ?? 0) > 1 ? '合并后路径'
        : !incident.has(node.id) ? '游离版本' : null;
    const label = matchingBranches.map(branch => branch.name).join('、') || '未命名分支';
    groups.push({ id: node.id, label, context, nodes });
  }
  if (order === 'newest') {
    const rank = new Map(orderedVersionNodes(graph, order).map((node, index) => [node.id, index]));
    for (const group of groups) group.nodes.reverse();
    groups.sort((a, b) => rank.get(a.nodes[0]!.id)! - rank.get(b.nodes[0]!.id)!);
  }
  return groups;
}

export type TaskIdSearch =
  | { kind: 'empty' }
  | { kind: 'exact'; value: string }
  | { kind: 'range'; start: string; end: string }
  | { kind: 'invalid'; message: string };

function compareNumericIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  return normalizedLeft.length - normalizedRight.length
    || (normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0);
}

export function suggestNextTaskId(tasks: readonly Pick<Task, 'externalTaskId'>[]): string | null {
  let maximum = '0';
  for (const task of tasks) {
    if (task.externalTaskId !== null && compareNumericIds(task.externalTaskId, maximum) > 0) {
      maximum = task.externalTaskId;
    }
  }
  const next = (BigInt(maximum) + 1n).toString();
  return next.length <= 16 ? next : null;
}

export function validateNewTaskId(tasks: readonly Pick<Task, 'externalTaskId'>[], value: string | null): string {
  const normalized = normalizeExternalTaskId(value);
  requireCondition(normalized !== null, 'TASK_ID_REQUIRED', '新建任务必须填写 Task ID。');
  requireCondition(!tasks.some(task => task.externalTaskId === normalized), 'DUPLICATE_TASK_ID', `Task ID 已被其他任务使用：${normalized}`);
  return normalized;
}

export function parseTaskIdSearch(query: string): TaskIdSearch {
  const value = query.trim();
  if (!value) return { kind: 'empty' };
  if (/^\d{1,16}$/.test(value)) return { kind: 'exact', value };
  const range = /^(\d{1,16})\s*-\s*(\d{1,16})$/.exec(value);
  if (!range) {
    return { kind: 'invalid', message: '请输入 1–16 位数字 ID，或起止 ID 范围，例如 100-199。' };
  }
  if (compareNumericIds(range[1]!, range[2]!) > 0) {
    return { kind: 'invalid', message: 'ID 范围的起始值不能大于结束值。' };
  }
  return { kind: 'range', start: range[1]!, end: range[2]! };
}

export function matchesTaskIdSearch(taskId: string | null, search: TaskIdSearch): boolean {
  if (search.kind === 'empty') return true;
  if (!taskId) return false;
  if (search.kind === 'exact') return taskId === search.value;
  if (search.kind === 'range') {
    return compareNumericIds(taskId, search.start) >= 0 && compareNumericIds(taskId, search.end) <= 0;
  }
  return false;
}

export function filterProjectTasks<T extends Task | TaskSummary>(
  tasks: readonly T[], scope: TaskScope, accountId: string | null,
  searchMode: TaskSearchMode, query: string, assigneeSearchById: ReadonlyMap<string, string>,
): T[] {
  const search = query.trim().toLocaleLowerCase();
  const idSearch = searchMode === 'id' ? parseTaskIdSearch(query) : null;
  return tasks.filter(task => {
    if (scope === 'mine' && (!accountId || task.assigneeId !== accountId)) return false;
    if (!search) return true;
    if (idSearch) return matchesTaskIdSearch(task.externalTaskId, idSearch);
    if (searchMode === 'assignee') {
      const assignee = task.assigneeId ? assigneeSearchById.get(task.assigneeId) ?? '' : '';
      return assignee.toLocaleLowerCase().includes(search);
    }
    requireCondition('description' in task, 'TASK_SEARCH_DETAIL', '全文搜索需要先加载完整项目。');
    return `${task.name} ${task.description}`.toLocaleLowerCase().includes(search);
  });
}

export interface TaskListRow<T extends Task | TaskSummary = Task> {
  task: T;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  matches: boolean;
}

export function compareTaskListIds(left: Pick<Task, 'id' | 'name' | 'externalTaskId'>, right: Pick<Task, 'id' | 'name' | 'externalTaskId'>): number {
  if (left.externalTaskId === null && right.externalTaskId !== null) return 1;
  if (left.externalTaskId !== null && right.externalTaskId === null) return -1;
  const numeric = left.externalTaskId !== null && right.externalTaskId !== null
    ? compareNumericIds(right.externalTaskId, left.externalTaskId) : 0;
  return numeric || (left.externalTaskId ?? '').localeCompare(right.externalTaskId ?? '')
    || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function projectTaskList<T extends Task | TaskSummary>(
  tasks: readonly T[],
  matchedIds: ReadonlySet<string>,
  nested: boolean,
  expandedIds: ReadonlySet<string>,
  filterActive: boolean,
  collapsedFilterIds: ReadonlySet<string>,
): TaskListRow<T>[] {
  if (!nested) {
    return tasks.filter(task => matchedIds.has(task.id)).sort(compareTaskListIds)
      .map(task => ({ task, depth: 0, hasChildren: false, expanded: false, matches: true }));
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const included = new Set(matchedIds);
  const autoExpanded = new Set<string>();
  if (filterActive) {
    for (const id of matchedIds) {
      let parentId = byId.get(id)?.parentTaskId ?? null;
      while (parentId && !autoExpanded.has(parentId)) {
        const parent = byId.get(parentId);
        if (!parent) break;
        included.add(parentId);
        autoExpanded.add(parentId);
        parentId = parent.parentTaskId;
      }
    }
  }
  const children = new Map<string | null, T[]>();
  for (const task of tasks) {
    if (!included.has(task.id)) continue;
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task);
    children.set(task.parentTaskId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareTaskListIds);
  const rows: TaskListRow<T>[] = [];
  const pending = (children.get(null) ?? []).map(task => ({ task, depth: 0 })).reverse();
  while (pending.length) {
    const { task, depth } = pending.pop()!;
    const descendants = children.get(task.id) ?? [];
    const expanded = filterActive
      ? (autoExpanded.has(task.id) || expandedIds.has(task.id)) && !collapsedFilterIds.has(task.id)
      : expandedIds.has(task.id);
    rows.push({ task, depth, hasChildren: descendants.length > 0, expanded, matches: matchedIds.has(task.id) });
    if (expanded) {
      for (let index = descendants.length - 1; index >= 0; index--) {
        pending.push({ task: descendants[index]!, depth: depth + 1 });
      }
    }
  }
  return rows;
}

export function tasksInLane<T extends Pick<Task, 'statusOptionId' | 'sortOrder' | 'name' | 'id'>>(graph: { tasks: T[] }, statusOptionId: string | null): T[] {
  return graph.tasks
    .filter(task => task.statusOptionId === statusOptionId)
    .sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
}

export function projectBoardDrop(
  graph: ProjectBoardView, taskId: string, targetStatusOptionId: string | null,
  targetTaskId: string | null, afterTarget: boolean,
): ProjectBoardView {
  const next = structuredClone(graph);
  const source = next.tasks.find(task => task.id === taskId);
  requireCondition(source, 'TASK_REFERENCE', '要移动的任务不存在。');
  requireCondition(targetStatusOptionId === null || next.project.statusOptions.some(option => option.id === targetStatusOptionId),
    'TASK_STATUS_REFERENCE', '目标 Status 不存在。');
  if (targetTaskId === taskId) return next;
  const lane = tasksInLane(next, targetStatusOptionId);
  const targetIndex = targetTaskId === null ? lane.length : lane.findIndex(task => task.id === targetTaskId);
  requireCondition(targetIndex >= 0, 'TASK_ORDER_TARGET', '任务排序目标无效或已移动。');
  const insertAfter = targetTaskId !== null && (source.statusOptionId === targetStatusOptionId
    ? lane.findIndex(task => task.id === taskId) < targetIndex : afterTarget);
  const destination = lane.filter(task => task.id !== taskId);
  const insertion = targetTaskId === null ? destination.length : destination.findIndex(task => task.id === targetTaskId) + (insertAfter ? 1 : 0);
  const oldStatus = source.statusOptionId;
  source.statusOptionId = targetStatusOptionId;
  destination.splice(insertion, 0, source);
  destination.forEach((task, index) => { task.sortOrder = index; });
  if (oldStatus !== targetStatusOptionId) tasksInLane(next, oldStatus).forEach((task, index) => { task.sortOrder = index; });
  return next;
}

export function moveTaskInBoard(
  graph: ProjectGraph,
  taskId: string,
  targetStatusOptionId: string | null,
  beforeTaskId: string | null,
): ProjectGraph {
  validateGraph(graph);
  requireCondition(
    targetStatusOptionId === null || graph.project.statusOptions.some(option => option.id === targetStatusOptionId),
    'TASK_STATUS_REFERENCE',
    '目标 Status 不存在。',
  );
  const task = graph.tasks.find(candidate => candidate.id === taskId);
  requireCondition(task, 'TASK_REFERENCE', '要移动的任务不存在。');
  if (beforeTaskId !== null) {
    const target = graph.tasks.find(candidate => candidate.id === beforeTaskId);
    requireCondition(target && target.id !== taskId && target.statusOptionId === targetStatusOptionId,
      'TASK_ORDER_TARGET', '任务排序目标无效或已移动。');
  }

  const next = structuredClone(graph);
  const moving = next.tasks.find(candidate => candidate.id === taskId)!;
  const previousStatusOptionId = moving.statusOptionId;
  const destination = next.tasks
    .filter(candidate => candidate.statusOptionId === targetStatusOptionId && candidate.id !== taskId)
    .sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
  const insertionIndex = beforeTaskId === null
    ? destination.length
    : destination.findIndex(candidate => candidate.id === beforeTaskId);
  destination.splice(insertionIndex, 0, moving);
  moving.statusOptionId = targetStatusOptionId;
  destination.forEach((candidate, index) => { candidate.sortOrder = index; });

  if (previousStatusOptionId !== targetStatusOptionId) {
    tasksInLane(next, previousStatusOptionId)
      .forEach((candidate, index) => { candidate.sortOrder = index; });
  }
  validateGraph(next);
  return next;
}

export function projectTaskDrop(
  graph: ProjectGraph,
  taskId: string,
  targetStatusOptionId: string | null,
  targetTaskId: string | null,
  afterTarget: boolean,
): ProjectGraph {
  if (targetTaskId === taskId) return graph;
  const source = graph.tasks.find(task => task.id === taskId);
  requireCondition(source, 'TASK_REFERENCE', '要移动的任务不存在。');
  const lane = tasksInLane(graph, targetStatusOptionId);
  const targetIndex = targetTaskId === null ? lane.length : lane.findIndex(task => task.id === targetTaskId);
  requireCondition(targetIndex >= 0, 'TASK_ORDER_TARGET', '任务排序目标无效或已移动。');
  const insertAfter = targetTaskId !== null && (source.statusOptionId === targetStatusOptionId
    ? lane.findIndex(task => task.id === taskId) < targetIndex
    : afterTarget);
  const destination = lane.filter(task => task.id !== taskId);
  const insertionIndex = targetTaskId === null ? destination.length
    : destination.findIndex(task => task.id === targetTaskId) + (insertAfter ? 1 : 0);
  return moveTaskInBoard(graph, taskId, targetStatusOptionId, destination[insertionIndex]?.id ?? null);
}