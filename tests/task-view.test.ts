import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { layoutGitGraph } from '../src/domain/git-graph';
import { projectTaskViewLayout, sortTasksByExternalId, taskViewRuns } from '../src/domain/task-view';

function fixture() {
  const graph = createProject('任务视图', '123');
  const projectId = graph.project.id;
  graph.tasks = [
    { id: 'task-a', projectId, name: '任务 A', description: '', externalTaskId: '001', statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [] },
    { id: 'task-b', projectId, name: '任务 B', description: '', externalTaskId: null, statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [] },
    { id: 'task-empty', projectId, name: '空任务', description: '', externalTaskId: '2', statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [] },
  ];
  graph.nodes = [
    { id: 'a1', projectId, version: 'V1', description: '', taskId: 'task-a', releasedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'a2', projectId, version: 'V2', description: '', taskId: 'task-a', releasedAt: null },
    { id: 'b1', projectId, version: 'V3', description: '', taskId: 'task-b', releasedAt: null },
    { id: 'a3', projectId, version: 'V4', description: '', taskId: 'task-a', releasedAt: null },
    { id: 'free', projectId, version: 'V5', description: '', taskId: null, releasedAt: null },
    { id: 'isolated-task', projectId, version: 'V6', description: '', taskId: 'task-a', releasedAt: null },
  ];
  graph.edges = [
    { id: 'e1', projectId, parentId: 'a1', childId: 'a2' },
    { id: 'e2', projectId, parentId: 'a2', childId: 'b1' },
    { id: 'e3', projectId, parentId: 'b1', childId: 'a3' },
  ];
  graph.branches = [
    { id: 'main', projectId, name: '主线', description: '', color: '#2563eb', headId: 'a3' },
  ];
  return graph;
}

describe('分支内连续任务节点投影', () => {
  it('按外部任务 ID 的数值顺序排序，无 ID 任务排在末尾', () => {
    const graph = fixture();
    graph.tasks.push({
      id: 'task-ten', projectId: graph.project.id, name: '任务 10', description: '', externalTaskId: '10',
      statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null,
      startDate: null, dueDate: null, sortOrder: 0, comments: [],
    });
    expect(sortTasksByExternalId(graph.tasks).map(task => task.id)).toEqual([
      'task-a', 'task-empty', 'task-ten', 'task-b',
    ]);
  });

  it('只把同一轨道内连续且任务相同的版本组成任务段', () => {
    const graph = fixture();
    const layout = layoutGitGraph(graph, 'oldest');
    const runs = taskViewRuns(graph, layout);

    expect(runs.map(run => [run.task.id, run.branch.id, run.nodeIds])).toEqual([
      ['task-a', 'main', ['a1', 'a2']],
      ['task-b', 'main', ['b1']],
      ['task-a', 'main', ['a3']],
    ]);
    expect(runs.flatMap(run => run.nodeIds)).not.toContain('isolated-task');
  });

  it('按任务段内实际版本放行状态汇总全部、部分和未放行', () => {
    const graph = fixture();
    graph.nodes.find(node => node.id === 'a2')!.releasedAt = '2026-01-02T00:00:00.000Z';
    graph.nodes.find(node => node.id === 'a3')!.releasedAt = '2026-01-03T00:00:00.000Z';
    const runs = taskViewRuns(graph, layoutGitGraph(graph, 'oldest'));
    expect(runs.find(run => run.nodeIds.includes('a1'))).toMatchObject({ releasedCount: 2, releaseState: 'all' });
    expect(runs.find(run => run.nodeIds.includes('b1'))).toMatchObject({ releasedCount: 0, releaseState: 'none' });

    graph.nodes.find(node => node.id === 'a2')!.releasedAt = null;
    const partial = taskViewRuns(graph, layoutGitGraph(graph, 'oldest'))
      .find(run => run.nodeIds.includes('a1'));
    expect(partial).toMatchObject({ releasedCount: 1, releaseState: 'partial' });
  });

  it('折叠时在图内以任务节点替代连续版本，展开时保留版本节点和分组边界', () => {
    const graph = fixture();
    const before = structuredClone(graph);
    const layout = layoutGitGraph(graph, 'oldest');
    const runs = taskViewRuns(graph, layout);
    const firstRun = runs[0]!;

    const collapsed = projectTaskViewLayout(layout, runs, new Set());
    expect(collapsed.rows.map(row => [row.kind, row.node.id])).toEqual([
      ['task-summary', 'a1'],
      ['task-summary', 'b1'],
      ['task-summary', 'a3'],
      ['version', 'free'],
      ['version', 'isolated-task'],
    ]);
    expect(collapsed.edges.map(edge => [
      collapsed.rows[edge.fromRow]?.node.id,
      collapsed.rows[edge.toRow]?.node.id,
    ])).toEqual([['a1', 'b1'], ['b1', 'a3']]);

    const expanded = projectTaskViewLayout(layout, runs, new Set([firstRun.id]));
    expect(expanded.rows.map(row => [row.kind, row.node.id, row.groupPosition])).toEqual([
      ['task-header', 'a1', undefined],
      ['version', 'a1', 'first'],
      ['version', 'a2', 'last'],
      ['task-summary', 'b1', undefined],
      ['task-summary', 'a3', undefined],
      ['version', 'free', undefined],
      ['version', 'isolated-task', undefined],
    ]);
    expect(expanded.edges.map(edge => [
      expanded.rows[edge.fromRow]?.node.id,
      expanded.rows[edge.toRow]?.node.id,
    ])).toEqual([['a1', 'a2'], ['a2', 'b1'], ['b1', 'a3']]);
    expect(graph).toEqual(before);
  });

  it('共享祖先只按所选轨道连续区间聚合，不跨过不同任务或孤立版本', () => {
    const graph = fixture();
    graph.edges.push({ id: 'e-direct', projectId: graph.project.id, parentId: 'a1', childId: 'b1' });
    graph.branches.push({
      id: 'feature',
      projectId: graph.project.id,
      name: '功能分支',
      description: '',
      color: '#db2777',
      headId: 'b1',
    });
    const layout = layoutGitGraph(graph, 'oldest');
    const runs = taskViewRuns(graph, layout);

    expect(runs.map(run => [run.branch.id, run.nodeIds])).toEqual([
      ['main', ['a1', 'a2']],
      ['main', ['b1']],
      ['main', ['a3']],
    ]);
    const collapsed = projectTaskViewLayout(layout, runs, new Set());
    expect(collapsed.rows.filter(row => row.kind === 'task-summary').map(row => row.branchHeads.map(branch => branch.id)))
      .toEqual([[], ['feature'], ['main']]);
    expect(collapsed.edges.filter(edge =>
      collapsed.rows[edge.fromRow]?.node.id === 'a1' && collapsed.rows[edge.toRow]?.node.id === 'b1'))
      .toHaveLength(2);
  });

  it('排序改变后相同任务段仍保留稳定身份', () => {
    const graph = fixture();
    const oldestRuns = taskViewRuns(graph, layoutGitGraph(graph, 'oldest'));
    const newestRuns = taskViewRuns(graph, layoutGitGraph(graph, 'newest'));
    expect(newestRuns.find(run => run.nodeIds.includes('a1'))?.id)
      .toBe(oldestRuns.find(run => run.nodeIds.includes('a1'))?.id);
  });
});
