import { validateGraph } from './graph';
import { normalizeExternalTaskId, requireCondition, type ProjectGraph, type Task } from './model';

export type TaskSearchMode = 'id' | 'keyword' | 'assignee';

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

export function suggestNextTaskId(tasks: readonly Task[]): string | null {
  let maximum = '0';
  for (const task of tasks) {
    if (task.externalTaskId !== null && compareNumericIds(task.externalTaskId, maximum) > 0) {
      maximum = task.externalTaskId;
    }
  }
  const next = (BigInt(maximum) + 1n).toString();
  return next.length <= 16 ? next : null;
}

export function validateNewTaskId(tasks: readonly Task[], value: string | null): string {
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

export interface TaskListRow {
  task: Task;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  matches: boolean;
}

export function compareTaskListIds(left: Task, right: Task): number {
  if (left.externalTaskId === null && right.externalTaskId !== null) return 1;
  if (left.externalTaskId !== null && right.externalTaskId === null) return -1;
  const numeric = left.externalTaskId !== null && right.externalTaskId !== null
    ? compareNumericIds(right.externalTaskId, left.externalTaskId) : 0;
  return numeric || (left.externalTaskId ?? '').localeCompare(right.externalTaskId ?? '')
    || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function projectTaskList(
  tasks: readonly Task[],
  matchedIds: ReadonlySet<string>,
  nested: boolean,
  expandedIds: ReadonlySet<string>,
  filterActive: boolean,
  collapsedFilterIds: ReadonlySet<string>,
): TaskListRow[] {
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
  const children = new Map<string | null, Task[]>();
  for (const task of tasks) {
    if (!included.has(task.id)) continue;
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task);
    children.set(task.parentTaskId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareTaskListIds);
  const rows: TaskListRow[] = [];
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

export function tasksInLane(graph: ProjectGraph, statusOptionId: string | null): Task[] {
  return graph.tasks
    .filter(task => task.statusOptionId === statusOptionId)
    .sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
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