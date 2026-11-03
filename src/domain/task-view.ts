import type { ProjectGraph, Task } from './model';

export interface TaskViewGroup {
  task: Task;
  versionCount: number;
}

export function taskViewGroups(graph: ProjectGraph): TaskViewGroup[] {
  const versionCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.taskId) versionCounts.set(node.taskId, (versionCounts.get(node.taskId) ?? 0) + 1);
  }
  return graph.tasks.map(task => ({ task, versionCount: versionCounts.get(task.id) ?? 0 }));
}

export function visibleTaskViewNodeIds(
  graph: ProjectGraph,
  expandedTaskIds: readonly string[],
): Set<string> {
  const expanded = new Set(expandedTaskIds);
  const taskIds = new Set(graph.tasks.map(task => task.id));
  return new Set(graph.nodes
    .filter(node => node.taskId === null || !taskIds.has(node.taskId) || expanded.has(node.taskId))
    .map(node => node.id));
}
