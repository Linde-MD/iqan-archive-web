import type { Branch, ProjectGraph, Task } from './model';
import { GIT_GRAPH, type GitGraphEdge, type GitGraphLayout, type GitGraphRow } from './git-graph';

export interface TaskRun {
  id: string;
  task: Task;
  branch: Branch;
  nodeIds: string[];
}

export interface TaskViewRow extends GitGraphRow {
  key: string;
  kind: 'version' | 'task-summary' | 'task-header';
  taskRun?: TaskRun;
  groupPosition?: 'single' | 'first' | 'middle' | 'last';
}

export interface TaskViewLayout extends Omit<GitGraphLayout, 'rows' | 'edges' | 'height'> {
  rows: TaskViewRow[];
  edges: GitGraphEdge[];
  height: number;
}

export function taskViewRuns(graph: ProjectGraph, layout: GitGraphLayout): TaskRun[] {
  const taskById = new Map(graph.tasks.map(task => [task.id, task]));
  const runs: TaskRun[] = [];
  let current: TaskRun | undefined;

  for (const row of layout.rows) {
    const task = row.node.taskId ? taskById.get(row.node.taskId) : undefined;
    const memberships = layout.memberships.get(row.node.id) ?? [];
    const branch = row.isolated
      ? undefined
      : layout.branchTracks.find(candidate => memberships.some(item => item.id === candidate.id));
    if (!task || !branch) {
      current = undefined;
      continue;
    }

    if (current?.task.id === task.id && current.branch.id === branch.id) {
      current.nodeIds.push(row.node.id);
      continue;
    }

    current = {
      id: `task-run:${branch.id}:${task.id}:${row.node.id}`,
      task,
      branch,
      nodeIds: [row.node.id],
    };
    runs.push(current);
  }

  return runs.map(run => ({
    ...run,
    id: `task-run:${run.branch.id}:${run.task.id}:${[...run.nodeIds].sort().join(':')}`,
  }));
}

export function projectTaskViewLayout(
  layout: GitGraphLayout,
  runs: readonly TaskRun[],
  expandedRunIds: ReadonlySet<string>,
): TaskViewLayout {
  const runAtRow = new Map<number, TaskRun>();
  const sourceRowByNodeId = new Map(layout.rows.map(row => [row.node.id, row]));
  for (const run of runs) {
    const firstId = run.nodeIds[0];
    if (!firstId) continue;
    const first = sourceRowByNodeId.get(firstId);
    if (first) runAtRow.set(first.rowIndex, run);
  }

  const rows: TaskViewRow[] = [];
  const projectedRowByNodeId = new Map<string, TaskViewRow>();
  const handledNodeIds = new Set<string>();
  const appendRow = (row: TaskViewRow) => {
    row.rowIndex = rows.length;
    rows.push(row);
  };
  const appendVersion = (
    source: GitGraphRow,
    taskRun: TaskRun,
    groupPosition: NonNullable<TaskViewRow['groupPosition']>,
  ) => {
    const row: TaskViewRow = {
      ...source,
      key: `version:${source.node.id}`,
      kind: 'version',
      taskRun,
      groupPosition,
    };
    appendRow(row);
    projectedRowByNodeId.set(source.node.id, row);
  };

  for (const source of layout.rows) {
    if (handledNodeIds.has(source.node.id)) continue;
    const run = runAtRow.get(source.rowIndex);
    if (!run) {
      appendRow({ ...source, key: `version:${source.node.id}`, kind: 'version' });
      projectedRowByNodeId.set(source.node.id, rows.at(-1)!);
      handledNodeIds.add(source.node.id);
      continue;
    }

    run.nodeIds.forEach(id => handledNodeIds.add(id));
    const expanded = expandedRunIds.has(run.id);
    if (expanded) {
      appendRow({
        ...source,
        key: `task-header:${run.id}`,
        kind: 'task-header',
        taskRun: run,
      });
      run.nodeIds.forEach((nodeId, index) => {
        const row = sourceRowByNodeId.get(nodeId);
        if (!row) return;
        const groupPosition = run.nodeIds.length === 1
          ? 'single' : index === 0 ? 'first' : index === run.nodeIds.length - 1 ? 'last' : 'middle';
        appendVersion(row, run, groupPosition);
      });
      continue;
    }

    const nodeRows = run.nodeIds.flatMap(nodeId => {
      const row = sourceRowByNodeId.get(nodeId);
      return row ? [row] : [];
    });
    const headIds = new Set(nodeRows.flatMap(row => row.branchHeads.map(branch => branch.id)));
    const row: TaskViewRow = {
      ...source,
      key: `task-summary:${run.id}`,
      kind: 'task-summary',
      taskRun: run,
      branchHeads: layout.branchTracks.filter(branch => headIds.has(branch.id)),
    };
    appendRow(row);
    for (const nodeId of run.nodeIds) projectedRowByNodeId.set(nodeId, row);
  }

  const edges: GitGraphEdge[] = [];
  for (const edge of layout.edges) {
    const from = projectedRowByNodeId.get(edge.parentId);
    const to = projectedRowByNodeId.get(edge.childId);
    if (!from || !to || from.rowIndex === to.rowIndex) continue;
    edges.push({
      ...edge,
      id: `task-view-edge:${edges.length}`,
      fromRow: from.rowIndex,
      toRow: to.rowIndex,
      fromLane: from.laneIndex,
      toLane: to.laneIndex,
    });
  }

  const labelWidth = runs.reduce((width, run) => Math.max(
    width,
    run.task.name.length * 9
      + (run.task.externalTaskId?.length ?? 0) * 9
      + run.nodeIds.reduce((sum, id) => sum + (sourceRowByNodeId.get(id)?.node.version.length ?? 0) * 9, 0)
      + 360,
  ), layout.width - layout.trackWidth);

  return {
    ...layout,
    rows,
    edges,
    height: rows.length * GIT_GRAPH.rowHeight,
    width: layout.trackWidth + labelWidth,
  };
}
