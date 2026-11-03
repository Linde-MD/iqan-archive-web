import { describe, expect, it } from 'vitest';
import { createProject, type ProjectGraph } from '../src/domain/model';
import { createBranch, release, setNodeParents, updateBranch, updateNode } from '../src/domain/graph';

function fixture(): ProjectGraph {
  const graph = createProject('工程', '123');
  const p = graph.project.id;
  graph.nodes = ['A', 'B'].map(id => ({ id, projectId: p, version: id, description: '', taskId: null, releasedAt: null }));
  graph.edges = [{ id: 'e', projectId: p, parentId: 'A', childId: 'B' }];
  graph.tasks = [{ id: 't', projectId: p, name: '任务', description: '', externalTaskId: '1479' }];
  return graph;
}

describe('节点与分支编辑', () => {
  it('父节点集合可替换并保留其他图数据及未变化父边身份', () => {
    const graph = fixture();
    graph.nodes.push({ id: 'C', projectId: graph.project.id, version: 'C', description: '', taskId: null, releasedAt: null });
    const next = setNodeParents(graph, 'B', ['C']);
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({ parentId: 'C', childId: 'B' });
    expect(next.nodes).toEqual(graph.nodes);
    expect(next.branches).toEqual(graph.branches);
    expect(graph.edges[0]).toMatchObject({ id: 'e', parentId: 'A', childId: 'B' });
  });

  it('父节点合并保留既有边且拒绝重复、自引用、悬空和成环关系', () => {
    const graph = fixture();
    graph.nodes.push({ id: 'C', projectId: graph.project.id, version: 'C', description: '', taskId: null, releasedAt: null });
    const next = setNodeParents(graph, 'B', ['A', 'C']);
    expect(next.edges.map(edge => edge.id)).toContain('e');
    expect(next.edges.filter(edge => edge.childId === 'B').map(edge => edge.parentId).sort()).toEqual(['A', 'C']);
    expect(() => setNodeParents(graph, 'B', ['A', 'A'])).toThrow('不能重复');
    expect(() => setNodeParents(graph, 'B', ['B'])).toThrow('自己的父节点');
    expect(() => setNodeParents(graph, 'B', ['missing'])).toThrow('节点不存在');
    expect(() => setNodeParents(graph, 'A', ['B'])).toThrow('成环');
  });

  it('已放行 child 的父边不可修改', () => {
    const released = release(fixture(), 'B', '2026-01-01T00:00:00.000Z');
    expect(() => setNodeParents(released, 'B', [])).toThrow('已放行版本的父边已锁定');
  });

  it('updateNode 修改版本/说明/任务引用，保持身份', () => {
    const next = updateNode(fixture(), 'A', { version: 'v1', description: ' 说明 ', taskId: 't' });
    expect(next.nodes[0]!.id).toBe('A');
    expect(next.nodes[0]!.version).toBe('v1');
    expect(next.nodes[0]!.description).toBe('说明');
    expect(next.nodes[0]!.taskId).toBe('t');
  });

  it('已放行节点的版本号锁定，说明仍可改', () => {
    const released = release(fixture(), 'B', '2026-01-01T00:00:00.000Z');
    expect(() => updateNode(released, 'A', { version: 'x' })).toThrow('已锁定');
    const next = updateNode(released, 'A', { description: '补充' });
    expect(next.nodes[0]!.description).toBe('补充');
  });

  it('悬空任务引用被拒绝，任务置空合法', () => {
    expect(() => updateNode(fixture(), 'A', { taskId: 'missing' })).toThrow('任务不存在');
    expect(updateNode(fixture(), 'A', { taskId: null }).nodes[0]!.taskId).toBeNull();
  });

  it('updateBranch 修改名称/说明/颜色，不隐式改头', () => {
    let graph = fixture();
    graph = createBranch(graph, { id: 'b', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'A' });
    const next = updateBranch(graph, 'b', { name: ' 主干 ', description: '说明', color: '#166534' });
    expect(next.branches[0]!.name).toBe('主干');
    expect(next.branches[0]!.description).toBe('说明');
    expect(next.branches[0]!.color).toBe('#166534');
    expect(next.branches[0]!.headId).toBe('A');
  });

  it('非法颜色被拒绝，不存在的分支抛错', () => {
    expect(() => updateBranch(fixture(), 'missing', { name: 'x' })).toThrow('分支不存在');
    const base = fixture();
    const withBranch = createBranch(base, { id: 'b', projectId: base.project.id, name: '主线', description: '', color: '#2563eb', headId: 'A' });
    expect(() => updateBranch(withBranch, 'b', { color: 'red' })).toThrow('六位十六进制');
  });

  it('显式移动分支头允许回退、前进及游离放行版本，其他数据不变并拒绝悬空头', () => {
    let graph = fixture();
    graph.nodes.push({ ...graph.nodes[0]!, id: 'C', version: 'C', releasedAt: '2026-01-01T00:00:00.000Z' });
    graph = createBranch(graph, { id: 'b', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'A' });
    for (const headId of ['B', 'A', 'C']) {
      const next = updateBranch(graph, 'b', { headId });
      expect(next.branches[0]!.headId).toBe(headId);
      expect(next.nodes).toEqual(graph.nodes);
      expect(next.edges).toEqual(graph.edges);
      expect(next.tasks).toEqual(graph.tasks);
      expect(graph.branches[0]!.headId).toBe('A');
    }
    expect(() => updateBranch(graph, 'b', { headId: 'missing' })).toThrow('头节点不存在');
  });
});
