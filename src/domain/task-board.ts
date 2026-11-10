import { validateGraph } from './graph';
import { requireCondition, type ProjectGraph, type Task } from './model';

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