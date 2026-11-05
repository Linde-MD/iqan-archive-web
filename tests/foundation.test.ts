import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, normalizeExternalTaskId, type ProjectGraph, type Task } from '../src/domain/model';
import { ancestors, appendVersion, applyDeletion, applyDeletionMany, createBranch, deleteBranch, deleteTask, mergeVersion, planDeletion, planDeletionMany, projectTaskView, release, revokeRelease, updateTask, validateGraph } from '../src/domain/graph';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

function fixture(): ProjectGraph {
  const graph = createProject('测试工程', '14798046801');
  const p = graph.project.id;
  graph.nodes = ['R', 'A', 'B', 'M', 'D', 'S'].map(id => ({
    id, projectId: p, version: id, description: '', taskId: null, releasedAt: null,
  }));
  graph.edges = [['R', 'A'], ['R', 'B'], ['A', 'M'], ['B', 'M'], ['M', 'D'], ['B', 'S']].map(([parentId, childId], index) => ({
    id: `e${index}`, projectId: p, parentId: parentId!, childId: childId!,
  }));
  return graph;
}

function task(graph: ProjectGraph, id: string, externalTaskId: string | null): Task {
  return { id, projectId: graph.project.id, name: id, description: '', externalTaskId };
}

const databases: ArchiveDatabase[] = [];
function repository() {
  const db = new ArchiveDatabase(`test-${crypto.randomUUID()}`);
  databases.push(db);
  return new ArchiveRepository(db);
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())); });

describe('领域基础', () => {
  it('项目身份独立、必填字段去空白，零件号不作为主键', () => {
    const a = createProject(' 项目 A ', ' 123 ');
    const b = createProject('项目 B', '123');
    expect(a.project.id).not.toBe(b.project.id);
    expect(a.project.name).toBe('项目 A');
    expect(() => createProject(' ', '123')).toThrow();
  });

  it('不允许重复版本节点', () => {
    const graph = fixture();
    expect(() => validateGraph(graph)).not.toThrow();
    graph.nodes.push({ ...graph.nodes[0]!, id: 'other' });
    expect(() => validateGraph(graph)).toThrow('版本号重复');
  });

  it('新建分支与合并只推进明确目标头，源分支保留', () => {
    let graph = fixture();
    graph = createBranch(graph, { id: 'target', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'A' });
    graph = createBranch(graph, { id: 'source', projectId: graph.project.id, name: '来源', description: '', color: '#166534', headId: 'B' });
    const node = { ...graph.nodes[0]!, id: 'new', version: 'V2' };
    const next = mergeVersion(graph, node, ['A', 'B'], 'target');
    expect(next.branches.map(branch => branch.headId)).toEqual(['new', 'B']);
    expect(() => mergeVersion(graph, node, ['A'], 'target')).toThrow('至少两个');
    expect(() => appendVersion(graph, node, ['B'], 'target')).toThrow('当前头');
  });

  it('重复主键被拒绝', () => {
    const graph = fixture();
    graph.nodes.push({ ...graph.nodes[0]! });
    expect(() => validateGraph(graph)).toThrow('ID 为空或重复');
  });

  it('拒绝循环、缺父、跨项目、悬空任务、重复边及目录越界', () => {
    const cyclic = fixture();
    cyclic.edges.push({ id: 'cycle', projectId: cyclic.project.id, parentId: 'D', childId: 'R' });
    expect(() => validateGraph(cyclic)).toThrow('成环');
    const missing = fixture();
    missing.edges[0]!.parentId = 'missing';
    expect(() => validateGraph(missing)).toThrow('不存在');
    const foreign = fixture();
    foreign.nodes[0]!.projectId = 'foreign';
    expect(() => validateGraph(foreign)).toThrow('跨项目');
    const invalidTask = fixture();
    invalidTask.nodes[0]!.taskId = 'missing';
    expect(() => validateGraph(invalidTask)).toThrow('任务不存在');
    const duplicate = fixture();
    duplicate.edges.push({ ...duplicate.edges[0]!, id: 'duplicate' });
    expect(() => validateGraph(duplicate)).toThrow('父边重复');
  });

  it('放行所有合并祖先，不触及后代和兄弟，重复放行幂等', () => {
    const graph = fixture();
    expect([...ancestors(graph, 'M')].sort()).toEqual(['A', 'B', 'M', 'R']);
    const next = release(graph, 'M', '2026-10-29T00:00:00Z');
    expect(next.nodes.filter(node => node.releasedAt).map(node => node.id).sort()).toEqual(['A', 'B', 'M', 'R']);
    expect(release(next, 'M', '2026-10-30T00:00:00Z')).toEqual(next);
    expect(graph.nodes.every(node => node.releasedAt === null)).toBe(true);
    expect(() => revokeRelease(next, 'R')).toThrow('已放行后代');
    const revoked = revokeRelease(next, 'M');
    expect(revoked.nodes.find(node => node.id === 'A')!.releasedAt).not.toBeNull();
  });

  it('外部 Task ID 仅接受 1–16 位数字，保留前导零，空白转 null', () => {
    expect(normalizeExternalTaskId(' 001 ')).toBe('001');
    expect(normalizeExternalTaskId('   ')).toBeNull();
    expect(normalizeExternalTaskId('1234567890123456')).toBe('1234567890123456');
    expect(() => normalizeExternalTaskId('12345678901234567')).toThrow('16');
    expect(() => normalizeExternalTaskId('1479-1')).toThrow('数字');
    expect(() => normalizeExternalTaskId('12A')).toThrow('数字');
    expect(() => normalizeExternalTaskId('１２３')).toThrow('数字');
    const invalidTaskIdGraph = fixture();
    invalidTaskIdGraph.tasks.push(task(invalidTaskIdGraph, 'invalid-task', '1479-1'));
    expect(() => validateGraph(invalidTaskIdGraph)).toThrow('数字');
    let graph = fixture();
    graph = updateTask(graph, task(graph, 't1', '1479'));
    graph = updateTask(graph, task(graph, 't2', null));
    graph = updateTask(graph, task(graph, 't3', null));
    expect(() => updateTask(graph, task(graph, 't4', ' 1479 '))).toThrow('已被其他任务使用');
    expect(() => updateTask(graph, task(graph, 't4', '1479A'))).toThrow('数字');
  });

  it('任务投影和删除不改变历史图/放行，详情引用同一任务', () => {
    let graph = fixture();
    graph = updateTask(graph, task(graph, 't1', '1479'));
    graph.nodes[1]!.taskId = 't1';
    graph.nodes[2]!.taskId = 't1';
    const before = structuredClone(graph);
    expect(projectTaskView(graph, 'tasks', new Set()).nodes).toHaveLength(4);
    expect(projectTaskView(graph, 'tasks', new Set(['t1'])).nodes).toHaveLength(6);
    expect(projectTaskView(graph, 'all', new Set()).nodes).toHaveLength(6);
    expect(graph).toEqual(before);
    const updated = updateTask(graph, task(graph, 't1', '88'));
    expect(updated.nodes).toEqual(graph.nodes);
    const removed = deleteTask(updated, 't1');
    expect(removed.nodes.every(node => node.taskId === null)).toBe(true);
    expect(removed.edges).toEqual(graph.edges);
  });

  it('删除建议包含所有父边；手改循环拒绝，分支头必须明确处理', () => {
    const graph = fixture();
    graph.branches.push({ id: 'main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'M' });
    const plan = planDeletion(graph, 'M');
    expect(plan.childParents.D).toEqual(['A', 'B']);
    expect(() => applyDeletion(graph, plan, null)).toThrow('分支');
    plan.branchHeads.main = 'D';
    const next = applyDeletion(graph, plan, null);
    expect(next.branches[0]!.headId).toBe('D');
    expect(next.nodes).toHaveLength(5);
    plan.childParents.D = ['D'];
    expect(() => applyDeletion(graph, plan, null)).toThrow('成环');
  });

  it('删除已放行非叶节点需版本确认，已放行子节点不能被重连', () => {
    const graph = release(fixture(), 'M', new Date().toISOString());
    const plan = planDeletion(graph, 'M');
    expect(() => applyDeletion(graph, plan, null)).toThrow('输入版本号');
    expect(() => applyDeletion(graph, plan, 'M')).not.toThrow();
    const rootPlan = planDeletion(graph, 'R');
    expect(() => applyDeletion(graph, rootPlan, 'R')).toThrow('已放行子节点');
  });

  it('批量删除重连到删除集外的祖先，分支头须显式处理并确认放行节点', () => {
    let graph = fixture();
    graph.branches.push({ id: 'main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'M' });
    const plan = planDeletionMany(graph, ['M', 'A']);
    expect(plan.childParents.D).toEqual(['B', 'R']);
    expect(plan.branchHeads).toEqual({ main: null });
    plan.branchHeads.main = 'B';
    const customizedPlan = { ...plan, childParents: { ...plan.childParents, D: ['B'] } };
    const customized = applyDeletionMany(graph, customizedPlan, {});
    expect(customized.edges.filter(edge => edge.childId === 'D').map(edge => edge.parentId)).toEqual(['B']);
    const next = applyDeletionMany(graph, plan, {});
    expect(next.nodes.map(node => node.id)).not.toContain('M');
    expect(next.nodes.map(node => node.id)).not.toContain('A');
    expect(next.edges.filter(edge => edge.childId === 'D').map(edge => edge.parentId).sort()).toEqual(['B', 'R']);
    expect(next.branches[0]!.headId).toBe('B');

    graph = release(fixture(), 'M', new Date().toISOString());
    const releasedPlan = planDeletionMany(graph, ['M']);
    expect(() => applyDeletionMany(graph, releasedPlan, {})).toThrow('输入版本号');
    expect(() => applyDeletionMany(graph, releasedPlan, { M: 'M' })).not.toThrow();
    expect(() => deleteBranch(graph, 'missing')).toThrow('分支不存在');
  });
});

describe('Dexie 原子持久化', () => {
  async function seed(repo: ArchiveRepository) {
    const graph = fixture();
    await repo.db.projects.add(graph.project);
    await repo.save(graph);
    return repo.get(graph.project.id);
  }

  it('任务删除原子解除所有版本关联，放行/父边/分支保留，修订保护及撤销可恢复', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'delete-task', '1479'));
    for (const id of ['A', 'B']) graph = await repo.saveNode(graph.project.id, graph.project.revision, id, { taskId: 'delete-task' });
    graph = await repo.release(graph.project.id, graph.project.revision, 'A');
    const before = structuredClone(graph);
    await expect(repo.deleteTask(graph.project.id, graph.project.revision, 'missing')).rejects.toThrow('任务不存在');
    expect(await repo.get(graph.project.id)).toEqual(before);
    const deleted = await repo.deleteTask(graph.project.id, graph.project.revision, 'delete-task');
    expect(deleted.tasks).toEqual([]);
    expect(deleted.nodes.every(node => node.taskId === null)).toBe(true);
    expect(deleted.nodes.map(node => node.releasedAt)).toEqual(before.nodes.map(node => node.releasedAt));
    expect(deleted.edges).toEqual(before.edges);
    expect(deleted.branches).toEqual(before.branches);
    await expect(repo.deleteTask(graph.project.id, graph.project.revision, 'delete-task')).rejects.toThrow('其他标签页');
    const restored = await repo.restoreUndo(graph.project.id, deleted.project.revision, before);
    expect(restored.tasks).toEqual(before.tasks);
    expect(restored.nodes).toEqual(before.nodes);
  });

  it('批量删除、分支删除和修订保护的撤销恢复保持图快照一致', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.addBranch(graph.project.id, graph.project.revision, {
      id: 'undo-main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'M',
    });
    const previous = structuredClone(graph);
    const plan = planDeletionMany(graph, ['M']);
    plan.branchHeads['undo-main'] = 'B';
    const deleted = await repo.deleteNodes(graph.project.id, graph.project.revision, plan, {});
    expect(deleted.nodes.some(node => node.id === 'M')).toBe(false);
    expect(deleted.branches[0]!.headId).toBe('B');

    const restored = await repo.restoreUndo(graph.project.id, deleted.project.revision, previous);
    expect(restored.nodes.map(node => node.id)).toEqual(previous.nodes.map(node => node.id));
    expect(restored.edges.map(edge => [edge.parentId, edge.childId])).toEqual(previous.edges.map(edge => [edge.parentId, edge.childId]));
    expect(restored.branches).toEqual(previous.branches);
    expect(restored.project.revision).toBe(deleted.project.revision + 1);
    await expect(repo.restoreUndo(graph.project.id, deleted.project.revision, previous)).rejects.toThrow('撤销已取消');

    const branchDeleted = await repo.deleteBranch(restored.project.id, restored.project.revision, 'undo-main');
    expect(branchDeleted.branches).toEqual([]);
    expect(branchDeleted.nodes).toEqual(restored.nodes);
    repo.db.close();
  });

  it('父节点集合通过项目修订事务持久化并拒绝陈旧修订', async () => {
    const repo = repository();
    const graph = await seed(repo);
    const updated = await repo.saveNodeParents(graph.project.id, graph.project.revision, 'D', ['R']);
    expect(updated.project.revision).toBe(graph.project.revision + 1);
    expect(updated.edges.filter(edge => edge.childId === 'D').map(edge => edge.parentId)).toEqual(['R']);
    await expect(repo.saveNodeParents(graph.project.id, graph.project.revision, 'D', ['M']))
      .rejects.toThrow('其他标签页已更新项目');
    const stored = await repo.get(graph.project.id);
    expect(stored.project.revision).toBe(updated.project.revision);
    expect(stored.edges.map(edge => [edge.parentId, edge.childId]).sort()).toEqual(
      updated.edges.map(edge => [edge.parentId, edge.childId]).sort(),
    );
  });

  it('分支指针持久化、拒绝无效目标及陈旧修订并可恢复快照', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.addBranch(graph.project.id, graph.project.revision, {
      id: 'move-head', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'M',
    });
    const moved = await repo.saveBranch(graph.project.id, graph.project.revision, 'move-head', { headId: 'R' });
    expect((await repo.get(graph.project.id)).branches.find(branch => branch.id === 'move-head')!.headId).toBe('R');
    expect(moved.nodes).toEqual(graph.nodes);
    expect(moved.edges).toEqual(graph.edges);
    await expect(repo.saveBranch(graph.project.id, graph.project.revision, 'move-head', { headId: 'B' }))
      .rejects.toThrow('其他标签页已更新项目');
    await expect(repo.saveBranch(graph.project.id, moved.project.revision, 'move-head', { headId: 'missing' }))
      .rejects.toThrow('头节点不存在');
    expect(await repo.get(graph.project.id)).toEqual(moved);
    const restored = await repo.restoreUndo(graph.project.id, moved.project.revision, graph);
    expect(restored.branches).toEqual(graph.branches);
    repo.db.close();
  });

  it('分支优先顺序在数据库及 JSON 快照往返中保持，并受修订保护', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.addBranch(graph.project.id, graph.project.revision, {
      id: 'branch-main', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'M',
    });
    graph = await repo.addBranch(graph.project.id, graph.project.revision, {
      id: 'branch-feature', projectId: graph.project.id, name: '功能线', description: '', color: '#166534', headId: 'B',
    });
    const reordered = await repo.saveBranchOrder(graph.project.id, graph.project.revision, ['branch-feature', 'branch-main']);
    expect(reordered.branches.map(branch => [branch.id, branch.order])).toEqual([
      ['branch-feature', 0], ['branch-main', 1],
    ]);
    await expect(repo.saveBranchOrder(graph.project.id, graph.project.revision, ['branch-main', 'branch-feature']))
      .rejects.toThrow('其他标签页已更新项目');
    const snapshot = await repo.snapshot(graph.project.id);
    expect(snapshot.graph.branches.map(branch => branch.id)).toEqual(['branch-feature', 'branch-main']);
    expect(snapshot.graph.branches[0]).not.toHaveProperty('order');
    repo.db.close();
    await repo.db.open();
    expect((await repo.get(graph.project.id)).branches.map(branch => branch.id)).toEqual(['branch-feature', 'branch-main']);
  });

  it('删除项目需名称确认和最新修订，原子删除所有所属数据及绑定，不影响其他项目', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'delete-task', null));
    graph = await repo.addBranch(graph.project.id, graph.project.revision, { id: 'delete-branch', projectId: graph.project.id, name: '主线', description: '', color: '#2563eb', headId: 'A' });
    graph = await repo.release(graph.project.id, graph.project.revision, 'M');
    const other = await repo.create('保留项目', graph.project.partNumber);
    await repo.db.table('directoryBindings').bulkAdd([
      { projectId: graph.project.id, role: 'engineering', handle: { name: 'engineering' } },
      { projectId: graph.project.id, role: 'word', handle: { name: 'reports' } },
      { projectId: other.project.id, role: 'engineering', handle: { name: 'other' } },
    ]);
    await expect(repo.deleteProject(graph.project.id, graph.project.revision, 'wrong')).rejects.toThrow('完整项目名称');
    await expect(repo.deleteProject(graph.project.id, graph.project.revision - 1, graph.project.name)).rejects.toThrow('项目已更新');
    expect(await repo.get(graph.project.id)).toEqual(graph);
    await repo.deleteProject(graph.project.id, graph.project.revision, graph.project.name);
    await expect(repo.get(graph.project.id)).rejects.toThrow('项目不存在');
    for (const table of [repo.db.nodes, repo.db.edges, repo.db.branches, repo.db.tasks, repo.db.directoryBindings]) {
      expect(await table.where('projectId').equals(graph.project.id).count()).toBe(0);
    }
    expect(await repo.get(other.project.id)).toEqual(other);
    expect(await repo.db.directoryBindings.where('projectId').equals(other.project.id).count()).toBe(1);
    repo.db.close();
    await repo.db.open();
    expect(await repo.listProjects()).toEqual([other.project]);
  });

  it('删除中途失败全部回滚，版本图与绑定仍完整可读', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'rollback-task', null));
    await repo.db.table('directoryBindings').put({ projectId: graph.project.id, role: 'engineering', handle: { name: 'root' } });
    repo.db.tasks.hook('deleting', () => { throw new Error('删除写入失败'); });
    await expect(repo.deleteProject(graph.project.id, graph.project.revision, graph.project.name)).rejects.toThrow('删除写入失败');
    expect(await repo.get(graph.project.id)).toEqual(graph);
    expect(await repo.db.directoryBindings.where('projectId').equals(graph.project.id).count()).toBe(1);
  });

  it('未知未来 schema 不被 v4 客户端降级打开', async () => {
    const future = repository();
    future.db.version(5).stores({ projects: 'id' });
    await future.db.open();
    const name = future.db.name;
    future.db.close();
    const older = new ArchiveDatabase(name);
    databases.push(older);
    await expect(older.open()).rejects.toThrow('数据库版本超出');
  });

  it('当前 schema 保存/重开往返，配置快照显式排除额外属性和权限', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'snapshot-task', '001'));
    Object.assign(graph.nodes[0]!, { binary: new Blob(['not configuration']), command: 'not configuration' });
    await repo.save(graph);
    const stored = await repo.get(graph.project.id);
    expect(stored.nodes[0]).not.toHaveProperty('binary');
    expect(stored.nodes[0]).not.toHaveProperty('command');
    repo.db.close();
    await repo.db.open();
    expect((await repo.snapshot(graph.project.id)).schemaVersion).toBe(3);
    const snapshot = (await repo.snapshot(graph.project.id)).graph;
    expect(snapshot.nodes).toEqual(stored.nodes);
    expect(snapshot.tasks).toEqual([{ id: 'snapshot-task', projectId: graph.project.id, name: 'snapshot-task', description: '', externalTaskId: '001' }]);
    expect(snapshot.project).toEqual({ id: stored.project.id, name: stored.project.name, partNumber: stored.project.partNumber, revision: stored.project.revision });
  });

  it('外部 Task ID 修改不改节点身份，同项目唯一、跨项目可重复、多个 null 可共存', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't1', '1479'));
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't2', null));
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't3', null));
    await expect(repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't4', '1479'))).rejects.toThrow('已被其他任务');
    expect(await repo.get(graph.project.id)).toEqual(graph);
    const other = await repo.create('另一个项目', graph.project.partNumber);
    await expect(repo.saveTask(other.project.id, 0, task(other, 'other-task', '1479'))).resolves.toBeDefined();
  });

  it('多标签页修订冲突不覆盖，放行读取最新快照并原子提交', async () => {
    const repo = repository();
    const graph = await seed(repo);
    const results = await Promise.allSettled([
      repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'one', '7')),
      repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'two', '7')),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const latest = await repo.get(graph.project.id);
    await expect(repo.save(graph)).rejects.toThrow('其他标签页');
    const next = await repo.release(latest.project.id, latest.project.revision, 'M');
    expect(next.nodes.filter(node => node.releasedAt)).toHaveLength(4);
  });

  it('跨表写入失败整体回滚，不破坏其他项目', async () => {
    const repo = repository();
    const graph = await seed(repo);
    const foreign = await repo.create('其他项目', '123');
    await repo.saveTask(foreign.project.id, 0, task(foreign, 'foreign-task', '6'));
    const collision = structuredClone(graph);
    collision.tasks.push(task(graph, 'foreign-task', '8'));
    await expect(repo.save(collision)).rejects.toThrow();
    expect(await repo.get(graph.project.id)).toEqual(graph);
    expect((await repo.get(foreign.project.id)).tasks[0]!.externalTaskId).toBe('6');
  });

  it('放行锁定不可被普通保存绕过，撤销需先保存后再编辑', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.release(graph.project.id, graph.project.revision, 'M');
    const changed = structuredClone(graph);
    changed.nodes[1]!.version = 'modified';
    await expect(repo.save(changed)).rejects.toThrow('已锁定');
    changed.nodes[1]!.releasedAt = null;
    await expect(repo.save(changed)).rejects.toThrow();
    const cleared = structuredClone(graph);
    for (const node of cleared.nodes) node.releasedAt = null;
    await expect(repo.save(cleared)).rejects.toThrow('放行或撤销命令');
    expect(await repo.get(graph.project.id)).toEqual(graph);
    const deleted = await repo.deleteNode(graph.project.id, graph.project.revision, planDeletion(graph, 'M'), 'M');
    expect(deleted.nodes.some(node => node.id === 'M')).toBe(false);
  });

  it('存储不可用/配额错误向调用者传播，不生成成功结果', async () => {
    const repo = repository();
    repo.db.projects.hook('creating', () => { throw new DOMException('空间不足', 'QuotaExceededError'); });
    await expect(repo.create('项目', '123')).rejects.toThrow('空间不足');
    expect(await repo.listProjects()).toEqual([]);
    repo.db.close({ disableAutoOpen: true });
    await expect(repo.listProjects()).rejects.toThrow();
  });
});
