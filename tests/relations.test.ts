import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createProject, type ProjectGraph } from '../src/domain/model';
import { release } from '../src/domain/graph';
import { changeVersionRelations } from '../src/domain/relations';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

function fixture() {
  const graph = createProject('批量关联', '1479');
  graph.nodes = ['V1.0-10', 'V1.0-2', 'V1.0-1', 'V1.0-3'].map((version, index) => ({
    id: `n${index}`, projectId: graph.project.id, version,
    description: '保留说明', taskId: null, releasedAt: null,
  }));
  graph.branches = [{
    id: 'main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'n0',
  }];
  return graph;
}

function edgeRelations(edges: ProjectGraph['edges']) {
  return edges
    .map(({ parentId, childId }) => JSON.stringify([parentId, childId]))
    .sort();
}

describe('批量父子关联', () => {
  it('按自然版本号旧到新串联，与选择顺序无关且保留全部其他数据', () => {
    const graph = fixture();
    const next = changeVersionRelations(graph, ['n0', 'n3', 'n2', 'n1'], 'linear');
    expect(next.edges.map(edge => [edge.parentId, edge.childId])).toEqual([
      ['n2', 'n1'], ['n1', 'n3'], ['n3', 'n0'],
    ]);
    expect(next.nodes).toEqual(graph.nodes);
    expect(next.branches).toEqual(graph.branches);
    expect(next.tasks).toEqual(graph.tasks);
    expect(graph.edges).toEqual([]);
  });

  it('清除所有入边及出边，包括与未选版本的边，保留无关边身份', () => {
    const graph = fixture();
    graph.edges = [['n2', 'n1'], ['n1', 'n0'], ['n2', 'n3']].map(([parentId, childId], index) => ({
      id: `e${index}`, projectId: graph.project.id, parentId: parentId!, childId: childId!,
    }));
    const next = changeVersionRelations(graph, ['n1', 'n0'], 'clear');
    expect(next.edges).toEqual([graph.edges[2]]);
    expect(next.nodes).toEqual(graph.nodes);
    expect(next.branches).toEqual(graph.branches);
    expect(graph.edges).toHaveLength(3);
  });

  it('拒绝少于两个、重复及不存在的选择', () => {
    for (const ids of [[], ['n0'], ['n0', 'n0'], ['n0', 'missing']]) {
      expect(() => changeVersionRelations(fixture(), ids, 'linear')).toThrow();
    }
  });

  it('拒绝已有入边或出边的节点，不提交部分线性链', () => {
    const graph = changeVersionRelations(fixture(), ['n2', 'n1'], 'linear');
    for (const ids of [['n2', 'n0'], ['n1', 'n3']]) {
      expect(() => changeVersionRelations(graph, ids, 'linear')).toThrow('游离版本');
    }
    expect(graph.edges).toHaveLength(1);
    expect(() => changeVersionRelations(fixture(), ['n2', 'n1'], 'clear')).toThrow('没有可清除');
  });

  it('清除关系不能修改已放行子版本的父边，即使子版本未选中', () => {
    const graph = release(changeVersionRelations(fixture(), ['n2', 'n1'], 'linear'), 'n1', '2026-11-03T00:00:00Z');
    expect(() => changeVersionRelations(graph, ['n2', 'n0'], 'clear')).toThrow('已锁定');
    expect(graph.edges).toHaveLength(1);
  });

  it('已放行游离版本可作线性链根，但不能新增其父边', () => {
    const graph = release(fixture(), 'n2', '2026-11-03T00:00:00Z');
    expect(changeVersionRelations(graph, ['n2', 'n1'], 'linear').edges).toHaveLength(1);
    const other = release(fixture(), 'n1', '2026-11-03T00:00:00Z');
    expect(() => changeVersionRelations(other, ['n2', 'n1'], 'linear')).toThrow();
  });

  it('事务持久化、修订冲突回滚及撤销/重做恢复', async () => {
    const db = new ArchiveDatabase(`relations-${crypto.randomUUID()}`);
    const repo = new ArchiveRepository(db);
    try {
      const initial = fixture();
      await db.projects.add(initial.project);
      const graph = await repo.save(initial);
      const linked = await repo.changeRelations(graph.project.id, graph.project.revision, ['n2', 'n1', 'n0'], 'linear');
      expect(edgeRelations((await repo.get(graph.project.id)).edges)).toEqual(edgeRelations(linked.edges));
      await expect(repo.changeRelations(graph.project.id, graph.project.revision, ['n2', 'n1'], 'clear')).rejects.toThrow('其他标签页');
      expect(edgeRelations((await repo.get(graph.project.id)).edges)).toEqual(edgeRelations(linked.edges));
      const cleared = await repo.changeRelations(graph.project.id, linked.project.revision, ['n2', 'n1'], 'clear');
      expect(cleared.edges).toEqual([]);
      const undone = await repo.restoreUndo(graph.project.id, cleared.project.revision, linked);
      expect(undone.edges).toEqual(linked.edges);
      const redone = await repo.restoreUndo(graph.project.id, undone.project.revision, cleared);
      expect(redone.edges).toEqual([]);
      const locked = await repo.release(graph.project.id, redone.project.revision, 'n1');
      await expect(repo.changeRelations(graph.project.id, locked.project.revision, ['n2', 'n1'], 'linear')).rejects.toThrow();
      expect(await repo.get(graph.project.id)).toEqual(locked);
    } finally {
      await db.delete();
    }
  });
});
