import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, type ProjectGraph, type ProjectSnapshot } from '../src/domain/model';
import { MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ENTITIES, parseProjectSnapshot, readProjectSnapshotFile, serializeProjectSnapshot } from '../src/domain/project-snapshot';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

const databases: ArchiveDatabase[] = [];
function repository() {
  const db = new ArchiveDatabase(`snapshot-${crypto.randomUUID()}`);
  databases.push(db);
  return new ArchiveRepository(db);
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())); });

function graphFixture(prefix = ''): ProjectGraph {
  const graph = createProject('测试工程', '001');
  const projectId = graph.project.id;
  const releasedAt = '2026-01-01T00:00:00.000Z';
  graph.nodes = [
    { id: `${prefix}node-root`, projectId, version: 'R', description: '根版本', taskId: null, releasedAt },
    { id: `${prefix}node-a`, projectId, version: 'A', description: '', taskId: null, releasedAt },
    { id: `${prefix}node-b`, projectId, version: 'B', description: '', taskId: null, releasedAt },
    { id: `${prefix}node-merge`, projectId, version: 'M', description: '合并版本', taskId: `${prefix}task-1`, releasedAt },
    { id: `${prefix}node-next`, projectId, version: 'D', description: '后续版本', taskId: null, releasedAt: null },
  ];
  graph.edges = [
    [`${prefix}node-root`, `${prefix}node-a`],
    [`${prefix}node-root`, `${prefix}node-b`],
    [`${prefix}node-a`, `${prefix}node-merge`],
    [`${prefix}node-b`, `${prefix}node-merge`],
    [`${prefix}node-merge`, `${prefix}node-next`],
  ].map(([parentId, childId], index) => ({ id: `${prefix}edge-${index}`, projectId, parentId: parentId!, childId: childId! }));
  graph.branches = [
    { id: `${prefix}branch-main`, projectId, name: '主线', description: '', color: '#2563eb', headId: `${prefix}node-next` },
    { id: `${prefix}branch-maintenance`, projectId, name: '维护线', description: '', color: '#166534', headId: `${prefix}node-b` },
  ];
  graph.tasks = [{ id: `${prefix}task-1`, projectId, name: '任务', description: '', externalTaskId: '001' }];
  return graph;
}

function snapshot(graph: ProjectGraph): ProjectSnapshot {
  return {
    schemaVersion: 3,
    graph: {
      project: {
        id: graph.project.id, name: graph.project.name,
        partNumber: graph.project.partNumber, revision: graph.project.revision,
      },
      nodes: graph.nodes,
      edges: graph.edges,
      branches: graph.branches,
      tasks: graph.tasks,
    },
  };
}

describe('项目 JSON 快照验证', () => {
  it('仅解析 schemaVersion 3，并生成不带目录信息的有效图', () => {
    const graph = graphFixture();
    const parsed = parseProjectSnapshot(snapshot(graph));
    expect(parsed).toEqual({ ...graph, project: { ...graph.project, engineeringDirectoryHint: '', wordDirectoryHint: '' } });
    expect(parseProjectSnapshot(JSON.parse(serializeProjectSnapshot(snapshot(graph))))).toEqual(parsed);
  });

  it('拒绝未知版本、额外字段、错误类型、无效关系及不合法 Task ID', () => {
    const source = snapshot(graphFixture());
    expect(() => parseProjectSnapshot({ ...source, schemaVersion: 4 })).toThrow('schemaVersion 3');
    expect(() => parseProjectSnapshot({ ...source, executable: 'no' })).toThrow('字段');
    expect(() => parseProjectSnapshot({ ...source, graph: { ...source.graph, extra: true } })).toThrow('字段');
    expect(() => parseProjectSnapshot({ ...source, graph: { ...source.graph, nodes: [{ ...source.graph.nodes[0], releasedAt: 12 }] } })).toThrow('文本或 null');
    const dangling = structuredClone(source);
    dangling.graph.edges[0]!.parentId = 'missing';
    expect(() => parseProjectSnapshot(dangling)).toThrow('不存在');
    const invalidTask = structuredClone(source);
    invalidTask.graph.tasks[0]!.externalTaskId = '1479-1';
    expect(() => parseProjectSnapshot(invalidTask)).toThrow('任务 task-1 的 externalTaskId');
    const duplicateTaskId = structuredClone(source);
    duplicateTaskId.graph.tasks.push({ ...duplicateTaskId.graph.tasks[0]!, id: 'task-2' });
    expect(() => parseProjectSnapshot(duplicateTaskId)).toThrow('externalTaskId 与其他任务重复');
  });

  it('在实体解析前执行实体数限制', () => {
    const source = snapshot(graphFixture());
    const oversized = { ...source, graph: { ...source.graph, nodes: Array.from({ length: MAX_SNAPSHOT_ENTITIES + 1 }, () => null) } };
    expect(() => parseProjectSnapshot(oversized)).toThrow(`${MAX_SNAPSHOT_ENTITIES}`);
    source.graph.nodes.length = MAX_SNAPSHOT_ENTITIES + 1;
    expect(() => serializeProjectSnapshot(source)).toThrow(`${MAX_SNAPSHOT_ENTITIES}`);
  });

  it('拒绝超大、非法 UTF-8 和非法 JSON 文件', async () => {
    await expect(readProjectSnapshotFile({
      size: MAX_SNAPSHOT_BYTES + 1,
      async arrayBuffer() { throw new Error('must not read'); },
    })).rejects.toThrow('20 MiB');
    await expect(readProjectSnapshotFile(new File([new Uint8Array([0xff])], 'invalid.json'))).rejects.toThrow('UTF-8');
    await expect(readProjectSnapshotFile(new File(['{'], 'invalid.json'))).rejects.toThrow('有效的 JSON');
  });

  it('导入时保留无冲突身份；ID 冲突时复制并重映射全部内部引用', async () => {
    const repo = repository();
    const source = graphFixture();
    const first = await repo.importSnapshot(source);
    expect(first.copied).toBe(false);
    expect(first.graph.project.id).toBe(source.project.id);

    const second = await repo.importSnapshot(source);
    expect(second.copied).toBe(true);
    expect(second.graph.project.id).not.toBe(source.project.id);
    expect(second.graph.project.revision).toBe(0);
    expect(second.graph.nodes.map(node => node.id)).not.toContain('node-root');
    expect(second.graph.edges[0]).toMatchObject({
      projectId: second.graph.project.id,
      parentId: second.graph.nodes[0]!.id,
      childId: second.graph.nodes[1]!.id,
    });
    expect(second.graph.nodes.find(node => node.version === 'M')!.taskId).toBe(second.graph.tasks[0]!.id);
    expect(second.graph.branches.find(branch => branch.name === '主线')!.headId).toBe(second.graph.nodes.find(node => node.version === 'D')!.id);

    const samePartNumber = graphFixture('other-');
    const third = await repo.importSnapshot(samePartNumber);
    expect(third.copied).toBe(false);
    expect(third.graph.project.partNumber).toBe(source.project.partNumber);

    const internalIdCollision = graphFixture();
    internalIdCollision.project.id = crypto.randomUUID();
    for (const item of [...internalIdCollision.nodes, ...internalIdCollision.edges, ...internalIdCollision.branches, ...internalIdCollision.tasks]) {
      item.projectId = internalIdCollision.project.id;
    }
    const fourth = await repo.importSnapshot(internalIdCollision);
    expect(fourth.copied).toBe(true);
    expect(fourth.graph.nodes.map(node => node.id)).not.toContain('node-root');
    expect(await repo.listProjects()).toHaveLength(4);
  });

  it('不导入目录绑定，跨表写入失败时回滚全部实体', async () => {
    const repo = repository();
    const source = graphFixture();
    await repo.db.table('directoryBindings').put({
      projectId: source.project.id,
      role: 'engineering',
      handle: { name: 'old-root' },
    });
    const result = await repo.importSnapshot(source);
    expect(result.copied).toBe(true);
    expect(await repo.db.directoryBindings.where('projectId').equals(result.graph.project.id).count()).toBe(0);
    expect(await repo.db.directoryBindings.where('projectId').equals(source.project.id).count()).toBe(1);

    const failing = repository();
    const next = graphFixture();
    failing.db.tasks.hook('creating', () => { throw new Error('模拟事务失败'); });
    await expect(failing.importSnapshot(next)).rejects.toThrow('模拟事务失败');
    expect(await failing.db.projects.get(next.project.id)).toBeUndefined();
    expect(await failing.db.nodes.where('projectId').equals(next.project.id).count()).toBe(0);
    expect(await failing.db.edges.where('projectId').equals(next.project.id).count()).toBe(0);
    expect(await failing.db.branches.where('projectId').equals(next.project.id).count()).toBe(0);
    expect(await failing.db.tasks.where('projectId').equals(next.project.id).count()).toBe(0);
  });
});
