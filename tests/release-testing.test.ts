import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { createProject, type ProjectGraph } from '../src/domain/model';
import { applyDeletion, cancelReleaseTesting, planDeletion, release, revokeRelease, setNodeParents, startReleaseTesting, updateNode, validateGraph } from '../src/domain/graph';
import { changeVersionRelations } from '../src/domain/relations';
import { parseProjectSnapshot, serializeProjectSnapshot } from '../src/domain/project-snapshot';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

const time = '2026-01-02T00:00:00.000Z';

function fixture(): ProjectGraph {
  const graph = createProject('测试流程', '123');
  const projectId = graph.project.id;
  graph.nodes = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => ({
    id, projectId, version: id, description: '', taskId: null, releasedAt: null, testingAt: null,
  }));
  graph.edges = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['D', 'E']]
    .map(([parentId, childId]) => ({ id: `${parentId}${childId}`, projectId, parentId: parentId!, childId: childId! }));
  return graph;
}

describe('放行测试状态', () => {
  it('沿合并的全部父边传播，遇已放行节点停止，不影响其他分支，重复设置保留时间', () => {
    const graph = release(fixture(), 'B', time);
    const next = startReleaseTesting(graph, 'D', '2026-01-03T00:00:00.000Z');
    expect(next.nodes.map(node => [node.id, node.releasedAt, node.testingAt])).toEqual([
      ['A', time, null], ['B', time, null], ['C', null, '2026-01-03T00:00:00.000Z'],
      ['D', null, '2026-01-03T00:00:00.000Z'], ['E', null, null], ['F', null, null],
    ]);
    expect(startReleaseTesting(next, 'D', '2026-01-04T00:00:00.000Z')).toEqual(next);
    expect(() => startReleaseTesting(next, 'B', time)).toThrow('已放行');
  });

  it('测试中的版本可改名并设置新父版本，保留原祖先并自动补齐新父链', () => {
    let graph = startReleaseTesting(fixture(), 'D', time);
    graph = updateNode(graph, 'D', { version: 'D2' });
    graph = setNodeParents(graph, 'D', ['B', 'C', 'F'], time);
    expect(graph.nodes.find(node => node.id === 'F')!.testingAt).toBe(time);
    expect(graph.nodes.find(node => node.id === 'D')!.version).toBe('D2');
    expect(() => setNodeParents(graph, 'A', ['D'])).toThrow('成环');
  });

  it('取消测试仅回退目标及测试中后代，直接放行和撤销放行均保持原语义', () => {
    let graph = startReleaseTesting(fixture(), 'E', time);
    graph = cancelReleaseTesting(graph, 'D');
    expect(graph.nodes.map(node => [node.id, node.testingAt])).toEqual([
      ['A', time], ['B', time], ['C', time], ['D', null], ['E', null], ['F', null],
    ]);
    graph = release(graph, 'D', '2026-01-04T00:00:00.000Z');
    expect(graph.nodes.find(node => node.id === 'D')!.releasedAt).not.toBeNull();
    graph = startReleaseTesting(graph, 'E', time);
    graph = revokeRelease(graph, 'D');
    expect(graph.nodes.filter(node => ['D', 'E'].includes(node.id)).every(node => node.testingAt === null && node.releasedAt === null)).toBe(true);
    expect(graph.nodes.find(node => node.id === 'A')!.releasedAt).not.toBeNull();
  });

  it('删除重连和批量线性关联时补齐测试祖先', () => {
    let graph = startReleaseTesting(fixture(), 'E', time);
    const plan = planDeletion(graph, 'D');
    plan.childParents.E = ['F'];
    graph = applyDeletion(graph, plan, null, time);
    expect(graph.nodes.find(node => node.id === 'F')!.testingAt).toBe(time);
    let isolated = fixture();
    isolated.edges = [];
    isolated = startReleaseTesting(isolated, 'B', time);
    isolated = changeVersionRelations(isolated, ['A', 'B'], 'linear', time);
    expect(isolated.nodes.find(node => node.id === 'A')!.testingAt).toBe(time);
  });

  it('拒绝测试闭包和时间非法的数据', () => {
    const graph = fixture();
    graph.nodes.find(node => node.id === 'D')!.testingAt = time;
    expect(() => validateGraph(graph)).toThrow('祖先必须处于测试中或已放行');
    graph.nodes.find(node => node.id === 'D')!.testingAt = 'invalid';
    expect(() => validateGraph(graph)).toThrow('测试时间无效');
  });

  it('事务持久化、快照往返、revision 冲突及撤销重做恢复测试状态', async () => {
    const db = new ArchiveDatabase(`testing-${crypto.randomUUID()}`);
    try {
      const repo = new ArchiveRepository(db);
      const original = await repo.create('状态事务', '123');
      const node = { ...fixture().nodes[0]!, id: 'one', projectId: original.project.id };
      const added = await repo.addNode(original.project.id, original.project.revision, node, [], null);
      const tested = await repo.startTesting(original.project.id, added.project.revision, node.id);
      await expect(repo.startTesting(original.project.id, added.project.revision, node.id)).rejects.toThrow('其他标签页');
      expect(tested.nodes[0]!.testingAt).not.toBeNull();
      const snap = await repo.snapshot(original.project.id);
      const parsed = parseProjectSnapshot(JSON.parse(serializeProjectSnapshot(snap)));
      expect(parsed.nodes[0]!.testingAt).toBe(tested.nodes[0]!.testingAt);
      const imported = await repo.importSnapshot(parsed);
      expect(imported.copied).toBe(true);
      expect((await repo.get(imported.graph.project.id)).nodes[0]!.testingAt).toBe(tested.nodes[0]!.testingAt);
      const undone = await repo.restoreUndo(original.project.id, tested.project.revision, added);
      const redone = await repo.restoreUndo(original.project.id, undone.project.revision, tested);
      expect(redone.nodes[0]!.testingAt).toBe(tested.nodes[0]!.testingAt);
      db.close();
      await db.open();
      expect((await repo.get(original.project.id)).nodes[0]!.testingAt).toBe(tested.nodes[0]!.testingAt);
    } finally {
      await db.delete();
    }
  });

  it('v11 数据库和 v6 快照迁移保留放行状态并初始化测试时间', async () => {
    const name = `testing-migration-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(11).stores({
      projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId',
      branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]',
      directoryBindings: '[projectId+role], projectId', archiveRoots: 'id',
    });
    const graph = release(fixture(), 'D', time);
    const oldNodes = graph.nodes.map(({ testingAt: _testingAt, ...node }) => node);
    await old.table('projects').add(graph.project);
    await old.table('nodes').bulkAdd(oldNodes);
    await old.table('edges').bulkAdd(graph.edges);
    old.close();
    const db = new ArchiveDatabase(name);
    try {
      const repo = new ArchiveRepository(db);
      const migrated = await repo.get(graph.project.id);
      expect(migrated.nodes).toEqual(graph.nodes);
      const snapshot = await repo.snapshot(graph.project.id);
      const legacy = { ...snapshot, schemaVersion: 6, graph: { ...snapshot.graph, nodes: oldNodes } };
      expect(parseProjectSnapshot(legacy).nodes).toEqual(graph.nodes);
    } finally {
      await db.delete();
    }
  });
});
