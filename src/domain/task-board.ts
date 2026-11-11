import { validateGraph } from './graph';
import { requireCondition, type ProjectGraph, type Task } from './model';

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