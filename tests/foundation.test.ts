import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, normalizeLoopId, type ProjectGraph, type Task } from '../src/domain/model';
import { ancestors, appendVersion, applyDeletion, createBranch, deleteTask, mergeVersion, planDeletion, projectTaskView, release, revokeRelease, updateTask, validateGraph } from '../src/domain/graph';
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

function task(graph: ProjectGraph, id: string, loopId: string | null): Task {
  return { id, projectId: graph.project.id, name: id, description: '', loopId };
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

  it('同版本多个文件快照，不允许重复版本节点', () => {
    const graph = fixture();
    graph.files = ['20260101', '20260102'].map(date => ({
      id: date, projectId: graph.project.id, nodeId: 'A', fileName: `${date}.idax`,
      relativePath: `${date}.idax`, extension: '.idax', candidateDate: date, parsingStatus: 'parsed',
    }));
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

  it('文件越界、文件名不匹配和重复主键被拒绝', () => {
    const graph = fixture();
    graph.files.push({
      id: 'f', projectId: graph.project.id, nodeId: 'A', fileName: 'a.idax',
      relativePath: '../a.idax', extension: '.idax', candidateDate: null, parsingStatus: 'unparsed',
    });
    expect(() => validateGraph(graph)).toThrow('安全的相对路径');
    graph.files[0]!.relativePath = 'b.idax';
    expect(() => validateGraph(graph)).toThrow('不一致');
    graph.files = [];
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

  it('Loop 文本 16 个码点上限、保留前导零/大小写，空白转 null', () => {
    expect(normalizeLoopId(' 001-A ')).toBe('001-A');
    expect(normalizeLoopId('   ')).toBeNull();
    expect(normalizeLoopId('😀'.repeat(16))).toBe('😀'.repeat(16));
    expect(() => normalizeLoopId('😀'.repeat(17))).toThrow('16');
    let graph = fixture();
    graph = updateTask(graph, task(graph, 't1', '1479-1'));
    graph = updateTask(graph, task(graph, 't2', null));
    graph = updateTask(graph, task(graph, 't3', null));
    expect(() => updateTask(graph, task(graph, 't4', ' 1479-1 '))).toThrow('已被其他任务使用');
    expect(() => updateTask(graph, task(graph, 't4', '1479-A'))).not.toThrow();
  });

  it('任务投影和删除不改变历史图/放行，详情引用同一任务', () => {
    let graph = fixture();
    graph = updateTask(graph, task(graph, 't1', '1479-1'));
    graph.nodes[1]!.taskId = 't1';
    graph.nodes[2]!.taskId = 't1';
    const before = structuredClone(graph);
    expect(projectTaskView(graph, 'tasks', new Set()).nodes).toHaveLength(4);
    expect(projectTaskView(graph, 'tasks', new Set(['t1'])).nodes).toHaveLength(6);
    expect(projectTaskView(graph, 'all', new Set()).nodes).toHaveLength(6);
    expect(graph).toEqual(before);
    const updated = updateTask(graph, task(graph, 't1', 'new ID'));
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
});

describe('Dexie 原子持久化', () => {
  async function seed(repo: ArchiveRepository) {
    const graph = fixture();
    await repo.db.projects.add(graph.project);
    await repo.save(graph);
    return repo.get(graph.project.id);
  }

  it('未知未来 schema 不被 v1 客户端降级打开', async () => {
    const future = repository();
    future.db.version(2).stores({ projects: 'id' });
    await future.db.open();
    const name = future.db.name;
    future.db.close();
    const older = new ArchiveDatabase(name);
    databases.push(older);
    await expect(older.open()).rejects.toThrow('数据库版本超出');
  });

  it('v1 schema 保存/重开往返，快照显式排除额外属性和权限', async () => {
    const repo = repository();
    const graph = await seed(repo);
    Object.assign(graph.nodes[0]!, { binary: new Blob(['not configuration']), command: 'not configuration' });
    await repo.save(graph);
    const stored = await repo.get(graph.project.id);
    expect(stored.nodes[0]).not.toHaveProperty('binary');
    expect(stored.nodes[0]).not.toHaveProperty('command');
    repo.db.close();
    await repo.db.open();
    expect((await repo.snapshot(graph.project.id)).schemaVersion).toBe(1);
    expect((await repo.snapshot(graph.project.id)).graph).toEqual(stored);
  });

  it('Loop 修改不改节点身份，同项目唯一、跨项目可重复、多个 null 可共存', async () => {
    const repo = repository();
    let graph = await seed(repo);
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't1', '1479-1'));
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't2', null));
    graph = await repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't3', null));
    await expect(repo.saveTask(graph.project.id, graph.project.revision, task(graph, 't4', '1479-1'))).rejects.toThrow('已被其他任务');
    expect(await repo.get(graph.project.id)).toEqual(graph);
    const other = await repo.create('另一个项目', graph.project.partNumber);
    await expect(repo.saveTask(other.project.id, 0, task(other, 'other-task', '1479-1'))).resolves.toBeDefined();
  });

  it('多标签页修订冲突不覆盖，放行读取最新快照并原子提交', async () => {
    const repo = repository();
    const graph = await seed(repo);
    const results = await Promise.allSettled([
      repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'one', 'same')),
      repo.saveTask(graph.project.id, graph.project.revision, task(graph, 'two', 'same')),
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
    await repo.saveTask(foreign.project.id, 0, task(foreign, 'foreign-task', 'X'));
    const collision = structuredClone(graph);
    collision.tasks.push(task(graph, 'foreign-task', 'Y'));
    await expect(repo.save(collision)).rejects.toThrow();
    expect(await repo.get(graph.project.id)).toEqual(graph);
    expect((await repo.get(foreign.project.id)).tasks[0]!.loopId).toBe('X');
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
