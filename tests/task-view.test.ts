import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { layoutGitGraph } from '../src/domain/git-graph';
import { taskViewGroups, visibleTaskViewNodeIds } from '../src/domain/task-view';

function fixture() {
  const graph = createProject('任务视图', '123');
  const projectId = graph.project.id;
  graph.tasks = [
    { id: 'task-a', projectId, name: '任务 A', description: '', externalTaskId: '001' },
    { id: 'task-b', projectId, name: '任务 B', description: '', externalTaskId: null },
    { id: 'task-empty', projectId, name: '空任务', description: '', externalTaskId: '2' },
  ];
  graph.nodes = [
    { id: 'a1', projectId, version: 'V1', description: '', taskId: 'task-a', releasedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b1', projectId, version: 'V2', description: '', taskId: 'task-b', releasedAt: null },
    { id: 'a2', projectId, version: 'V3', description: '', taskId: 'task-a', releasedAt: null },
    { id: 'free', projectId, version: 'V4', description: '', taskId: null, releasedAt: null },
  ];
  graph.edges = [
    { id: 'e1', projectId, parentId: 'a1', childId: 'b1' },
    { id: 'e2', projectId, parentId: 'b1', childId: 'a2' },
  ];
  graph.branches = [
    { id: 'main', projectId, name: '主线', description: '', color: '#2563eb', headId: 'a2' },
  ];
  return graph;
}

describe('任务聚合视图投影', () => {
  it('聚合标题数据按任务提供版本数，包含无版本任务和完整外部编号', () => {
    const graph = fixture();
    const before = structuredClone(graph);
    expect(taskViewGroups(graph).map(({ task, versionCount }) => [
      task.id, task.name, task.externalTaskId, versionCount,
    ])).toEqual([
      ['task-a', '任务 A', '001', 2],
      ['task-b', '任务 B', null, 1],
      ['task-empty', '空任务', '2', 0],
    ]);
    expect(graph).toEqual(before);
  });

  it('折叠隐藏任务版本但始终保留未关联版本，展开任务只展示对应节点', () => {
    const graph = fixture();
    expect([...visibleTaskViewNodeIds(graph, [])]).toEqual(['free']);
    expect([...visibleTaskViewNodeIds(graph, ['task-a'])]).toEqual(['a1', 'a2', 'free']);
    expect([...visibleTaskViewNodeIds(graph, ['task-a', 'task-b'])]).toEqual(['a1', 'b1', 'a2', 'free']);
    expect([...visibleTaskViewNodeIds(graph, graph.tasks.map(task => task.id))]).toEqual(graph.nodes.map(node => node.id));
  });

  it('收起任务只改变可见投影，保留真实节点关系且边仍映射实际端点', () => {
    const graph = fixture();
    const before = structuredClone(graph);
    const visibleIds = visibleTaskViewNodeIds(graph, ['task-a']);
    const layout = layoutGitGraph(graph, 'oldest', null, false, visibleIds);
    expect(layout.rows.map(row => row.node.id)).toEqual(['a1', 'a2', 'free']);
    expect(layout.edges).toEqual([]);
    expect(graph).toEqual(before);
    const expanded = layoutGitGraph(graph, 'oldest', null, false, visibleTaskViewNodeIds(graph, ['task-a', 'task-b']));
    expect(expanded.edges.map(edge => [expanded.rows[edge.fromRow]?.node.id, expanded.rows[edge.toRow]?.node.id]))
      .toEqual([['a1', 'b1'], ['b1', 'a2']]);
  });
});
