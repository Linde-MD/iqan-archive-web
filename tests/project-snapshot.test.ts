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
  graph.project.priorityOptions = [{ id: `${prefix}priority-high`, name: '高', indicatorCount: 3, indicatorColor: '#f05252' }];
  graph.project.assigneeOptions = [{ id: `${prefix}assignee-owner`, name: '负责人' }];
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
  graph.tasks = [{
    id: `${prefix}task-1`, projectId, name: '任务', description: '', externalTaskId: '001',
    statusOptionId: graph.project.statusOptions[0]!.id,
    typeOptionId: graph.project.typeOptions[0]!.id,
    priorityOptionId: graph.project.priorityOptions[0]!.id,
    assigneeId: graph.project.assigneeOptions[0]!.id,
    startDate: '2026-01-02', dueDate: '2026-01-03', sortOrder: 0,
    comments: [{ id: `${prefix}comment-1`, text: '**完成**', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }],
  }];
  return graph;
}

function snapshot(graph: ProjectGraph): ProjectSnapshot {
  return {
    schemaVersion: 5,
    graph: {
      project: {
        id: graph.project.id, name: graph.project.name,
        partNumber: graph.project.partNumber, revision: graph.project.revision,
        statusOptions: graph.project.statusOptions, typeOptions: graph.project.typeOptions,
        priorityOptions: graph.project.priorityOptions, assigneeOptions: graph.project.assigneeOptions,
      },
      nodes: graph.nodes,
      edges: graph.edges,
      branches: graph.branches,
      tasks: graph.tasks,
    },
  };
}

describe('项目 JSON 快照验证', () => {
  it('解析 schemaVersion 5 并往返任务选项、日期和 Markdown 评论', () => {
    const graph = graphFixture();
    const parsed = parseProjectSnapshot(snapshot(graph));
    expect(parsed).toEqual({
      ...graph,
      project: { ...graph.project, engineeringDirectoryHint: '', wordDirectoryHint: '' },
      branches: graph.branches.map((branch, order) => ({ ...branch, order })),
    });
    expect(parseProjectSnapshot(JSON.parse(serializeProjectSnapshot(snapshot(graph))))).toEqual(parsed);
  });

  it('显式迁移 schemaVersion 3，保留图与任务并为新字段设空值', () => {
    const graph = graphFixture();
    const current = snapshot(graph);
    const legacy = {
      schemaVersion: 3,
      graph: {
        ...current.graph,
        project: {
          id: graph.project.id, name: graph.project.name,
          partNumber: graph.project.partNumber, revision: graph.project.revision,
        },
        tasks: graph.tasks.map(({ id, projectId, name, description, externalTaskId }) => ({
          id, projectId, name, description, externalTaskId,
        })),
      },
    };
    const migrated = parseProjectSnapshot(legacy);
    expect(migrated.nodes).toEqual(graph.nodes);
    expect(migrated.edges).toEqual(graph.edges);
    expect(migrated.tasks[0]).toMatchObject({
      id: 'task-1', externalTaskId: '001', statusOptionId: null, typeOptionId: null,
      priorityOptionId: null, assigneeId: null, startDate: null, dueDate: null, sortOrder: 0, comments: [],
    });
    expect(migrated.project.statusOptions.map(option => option.name)).toEqual([
      'Backlog', 'Pending', 'In Progress', 'release pending', 'Done',
    ]);
    expect(migrated.project.typeOptions).toHaveLength(7);
    expect(migrated.project.priorityOptions.map(option => option.name)).toEqual(['最高', '较高', '普通', '最低', '较低']);
    expect(migrated.project.assigneeOptions).toEqual([]);
    expect(() => parseProjectSnapshot({ ...legacy, schemaVersion: 2 })).toThrow('仅支持 schemaVersion 3、4 和 5');
  });

  it('显式迁移 schemaVersion 4 的优先级名称并补齐标记；空列表安装默认档位', () => {
    const graph = graphFixture();
    const current = snapshot(graph);
    const legacy = {
      schemaVersion: 4,
      graph: {
        ...current.graph,
        project: {
          ...current.graph.project,
          priorityOptions: [{ id: 'legacy-priority', name: '紧急' }],
        },
        tasks: current.graph.tasks.map(task => ({ ...task, priorityOptionId: 'legacy-priority' })),
      },
    };
    const migrated = parseProjectSnapshot(legacy);
    expect(migrated.project.priorityOptions).toEqual([
      { id: 'legacy-priority', name: '紧急', indicatorCount: 3, indicatorColor: '#f05252' },
    ]);

    const emptyLegacy = structuredClone(legacy);
    emptyLegacy.graph.project.priorityOptions = [];
    (emptyLegacy.graph.tasks[0] as { priorityOptionId: string | null }).priorityOptionId = null;
    expect(parseProjectSnapshot(emptyLegacy).project.priorityOptions.map(option => option.name)).toEqual([
      '最高', '较高', '普通', '最低', '较低',
    ]);
  });

  it('以分支数组顺序往返显示优先级，快照不暴露本地排序字段', () => {
    const graph = graphFixture();
    const source = snapshot(graph);
    source.graph.branches.reverse();
    const serialized = serializeProjectSnapshot(source);
    const wireBranches = JSON.parse(serialized).graph.branches as Array<Record<string, unknown>>;
    expect(wireBranches.map(branch => branch.id)).toEqual(source.graph.branches.map(branch => branch.id));
    expect(wireBranches.every(branch => !('order' in branch))).toBe(true);
    expect(parseProjectSnapshot(JSON.parse(serialized)).branches.map(branch => [branch.id, branch.order]))
      .toEqual(source.graph.branches.map((branch, order) => [branch.id, order]));
  });

  it('拒绝未知版本、额外字段、错误类型、无效关系及不合法 Task ID', () => {
    const source = snapshot(graphFixture());
    expect(() => parseProjectSnapshot({ ...source, schemaVersion: 2 })).toThrow('仅支持 schemaVersion 3、4 和 5');
    expect(() => parseProjectSnapshot({ ...source, executable: 'no' })).toThrow('字段');
    expect(() => parseProjectSnapshot({ ...source, graph: { ...source.graph, extra: true } })).toThrow('字段');
    expect(() => parseProjectSnapshot({ ...source, graph: { ...source.graph, nodes: [{ ...source.graph.nodes[0], releasedAt: 12 }] } })).toThrow('文本或 null');
    const invalidTaskDate = structuredClone(source);
    invalidTaskDate.graph.tasks[0]!.startDate = '2026-02-30';
    expect(() => parseProjectSnapshot(invalidTaskDate)).toThrow('有效的 YYYY-MM-DD');
    const missingTaskOption = structuredClone(source);
    missingTaskOption.graph.tasks[0]!.priorityOptionId = 'missing-option';
    expect(() => parseProjectSnapshot(missingTaskOption)).toThrow('priority 选项不存在');
    const invalidPriorityCount = structuredClone(source);
    invalidPriorityCount.graph.project.priorityOptions[0]!.indicatorCount = 4;
    expect(() => parseProjectSnapshot(invalidPriorityCount)).toThrow('感叹号数量必须为 1–3');
    const invalidPriorityColor = structuredClone(source);
    invalidPriorityColor.graph.project.priorityOptions[0]!.indicatorColor = 'red';
    expect(() => parseProjectSnapshot(invalidPriorityColor)).toThrow('颜色无效');
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
    const oversizedComments = snapshot(graphFixture());
    oversizedComments.graph.tasks[0]!.comments = Array.from({ length: MAX_SNAPSHOT_ENTITIES }, (_, index) => ({
      id: `comment-${index}`, text: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    expect(() => serializeProjectSnapshot(oversizedComments)).toThrow(`${MAX_SNAPSHOT_ENTITIES}`);
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
    expect(second.graph.project.statusOptions.map(option => option.id)).not.toEqual(source.project.statusOptions.map(option => option.id));
    expect(second.graph.project.priorityOptions[0]).toMatchObject({ indicatorCount: 3, indicatorColor: '#f05252' });
    expect(second.graph.tasks[0]!.statusOptionId).toBe(second.graph.project.statusOptions[0]!.id);
    expect(second.graph.tasks[0]!.comments[0]!.id).not.toBe(source.tasks[0]!.comments[0]!.id);
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
