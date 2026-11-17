import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';
import { CollaborationDatabase, CollaborationRepository, collaborationSnapshot } from '../src/storage/collaboration';
import { createProject, type ProjectGraph, type Task, type VersionNode } from '../src/domain/model';
import { parseProjectSnapshot } from '../src/domain/project-snapshot';
import { assertOfflineChanges } from '../src/domain/collaboration';
import { createProjectDelta, type EntityChanges, type ProjectChanges } from '../src/domain/project-changes';
import { orderedBranches } from '../src/domain/model';

const databases: (ArchiveDatabase | CollaborationDatabase)[] = [];
const testAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
function createNode(graph: ProjectGraph, input: { version: string; description: string }): VersionNode {
  return { id: crypto.randomUUID(), projectId: graph.project.id, ...input, taskId: null, releasedAt: null, testingAt: null };
}

function applyChanges<T extends { id: string }>(items: T[], patch?: EntityChanges<T>): T[] {
  if (!patch) return items;
  const removed = new Set(patch.delete);
  const next = items.filter(item => !removed.has(item.id));
  for (const item of patch.upsert) {
    const index = next.findIndex(previous => previous.id === item.id);
    if (index < 0) next.push(item);
    else next[index] = item;
  }
  return next;
}

function applyProjectChanges(graph: ProjectGraph, changes: ProjectChanges): ProjectGraph {
  const next = structuredClone(graph);
  if (changes.project) next.project = { ...next.project, ...changes.project };
  next.nodes = applyChanges(next.nodes, changes.nodes);
  next.edges = applyChanges(next.edges, changes.edges);
  next.tasks = applyChanges(next.tasks, changes.tasks);
  next.branches = orderedBranches(applyChanges(next.branches, changes.branches));
  next.project.revision = graph.project.revision + 1;
  return next;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map(db => db.delete()));
});

it('collaboration cache v1→v2 clears legacy task owners and blocks unresolved writes', async () => {
  const name = `collab-assignee-migration-${crypto.randomUUID()}`;
  const source = crypto.randomUUID();
  const graph = createProject('旧共享项目', '123');
  graph.project.assigneeOptions = [{ id: 'legacy-owner', name: '旧负责人' }];
  graph.tasks.push({
    id: 'task', projectId: graph.project.id, parentTaskId: null, name: '任务', description: '',
    externalTaskId: null, statusOptionId: null, typeOptionId: null, priorityOptionId: null,
    assigneeId: 'legacy-owner', startDate: null, dueDate: null, sortOrder: 0, comments: [],
  });
  const old = new Dexie(name);
  old.version(1).stores({ contexts: 'id', mirrors: 'key, source', drafts: 'key', pending: 'key' });
  await old.table('mirrors').put({
    key: `${source}:${graph.project.id}`, source, graph, version: 0, updatedAt: 1, deleted: false,
  });
  await old.table('drafts').put({
    key: `${source}:${graph.project.id}`, owner: 'owner', nodes: [], edges: [],
  });
  old.close();

  const upgraded = new CollaborationDatabase(name);
  databases.push(upgraded);
  await upgraded.open();
  const mirror = await upgraded.mirrors.get(`${source}:${graph.project.id}`);
  expect(mirror?.graph.project.assigneeOptions).toEqual([]);
  expect(mirror?.graph.tasks[0]?.assigneeId).toBeNull();
  expect(await upgraded.drafts.get(`${source}:${graph.project.id}`)).toMatchObject({ owner: 'owner' });
  await upgraded.close();

  const blockedName = `collab-assignee-pending-${crypto.randomUUID()}`;
  const pendingDb = new Dexie(blockedName);
  pendingDb.version(1).stores({ contexts: 'id', mirrors: 'key, source', drafts: 'key', pending: 'key' });
  await pendingDb.table('pending').put({
    key: 'source:owner', source, owner: 'owner', requestId: crypto.randomUUID(),
    method: 'PATCH', path: '/projects/id', body: {}, projectId: 'id', clearDraft: false,
  });
  pendingDb.close();
  const blocked = new CollaborationDatabase(blockedName);
  databases.push(blocked);
  await expect(blocked.open()).rejects.toThrow('结果未确认的协作提交');
});

function setup() {
  const source = crypto.randomUUID();
  const admin = {
    id: crypto.randomUUID(), username: 'admin', displayName: '管理员', email: 'admin@example.invalid',
    role: 'admin', disabled: false, mustChangePassword: false, avatar: null,
  };
  let graph = parseProjectSnapshot(collaborationSnapshot(createProject('共享项目', '123')));
  let offline = false, loseResponse = false, failRead = false, legacyReceipt = false, graphReads = 0;
  const receipts = new Map<string, unknown>();
  const requests: { id: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (offline) throw new TypeError('network');
    const path = new URL(url).pathname;
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init.headers);
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/auth/login') return response({ token: 'test-token', expiresAt: Date.now() + 100_000, user: admin });
    if (path === '/auth/me') return response({ user: admin });
    if (path === '/instance') return response({ databaseId: source });
    if (path === '/auth/logout') return response({ loggedOut: true });
    if (path === '/assignees') return response({ assignees: [{
      id: 'member-id', username: 'member1', displayName: '工程成员', disabled: false,
      avatar: testAvatar,
    }] });
    if (path === '/projects' && init.method === 'GET') return response({ projects: [graph.project] });
    if (path === `/projects/${graph.project.id}` && init.method === 'GET') return response(graph.project);
    if (path === `/projects/${graph.project.id}/graph` && init.method === 'GET') {
      graphReads++;
      if (failRead) throw new TypeError('read failed');
      return response(collaborationSnapshot(graph));
    }
    const id = headers.get('Idempotency-Key')!;
    if (receipts.has(id)) return response(receipts.get(id));
    requests.push({ id, body });
    let next: ProjectGraph;
    let previous: ProjectGraph | null = graph;
    if (path === '/projects' && init.method === 'POST') {
      const input = body as { name: string; partNumber: string };
      next = createProject(input.name, input.partNumber);
      previous = null;
    } else if (path.endsWith('/import')) {
      const envelope = body as { snapshot: unknown; revision?: number; expectedRevision?: number };
      next = parseProjectSnapshot(envelope.snapshot);
      if ((envelope.revision ?? envelope.expectedRevision) !== graph.project.revision)
        return response({ error: { code: 'STALE_REVISION', message: '共享项目已变化' } }, 409);
    } else if (path.endsWith('/offline')) {
      next = applyProjectChanges(graph, body as ProjectChanges);
      assertOfflineChanges(graph, next);
    } else if (init.method === 'PATCH') next = applyProjectChanges(graph, body as ProjectChanges);
    else next = parseProjectSnapshot(body);
    if (next.nodes.some((node, index) => next.nodes.slice(index + 1).some(other => node.version === other.version)))
      return response({ error: { code: 'DUPLICATE_VERSION', message: '版本重复' } }, 400);
    next.project.revision = previous ? previous.project.revision + 1 : 0;
    graph = next;
    const useLegacyReceipt = legacyReceipt;
    legacyReceipt = false;
    const result = {
      projectId: graph.project.id, revision: graph.project.revision, deleted: false,
      ...(useLegacyReceipt ? {} : { delta: createProjectDelta(previous, graph) }),
    };
    receipts.set(id, result);
    if (loseResponse) { loseResponse = false; throw new TypeError('lost after commit'); }
    return response(result);
  });
  vi.stubGlobal('fetch', fetcher);
  const db = new ArchiveDatabase(`legacy-${crypto.randomUUID()}`);
  const cache = new CollaborationDatabase(`collab-${crypto.randomUUID()}`);
  databases.push(db, cache);
  const local = new ArchiveRepository(db);
  const client = new CollaborationRepository(local, cache);
  const repository = new ArchiveRepository(db, client);
  return {
    local, client, repository, db, cache, source, admin, fetcher, requests,
    graph: () => structuredClone(graph),
    graphReads: () => graphReads,
    setGraph: (next: ProjectGraph) => { graph = next; },
    network: (value: boolean) => { offline = !value; },
    loseResponse: () => { loseResponse = true; },
    failRead: (value: boolean) => { failRead = value; },
    legacyReceipt: () => { legacyReceipt = true; },
  };
}

describe('共享副本与离线草稿', () => {
  it('登录后读取负责人目录并保留账号头像字段', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    await expect(s.client.listAssignees()).resolves.toEqual([{
      id: 'member-id', username: 'member1', displayName: '工程成员', disabled: false,
      avatar: testAvatar,
    }]);
  });

  it('没有共享数据库来源时明确报告无法读取负责人', async () => {
    const s = setup();
    await expect(s.client.listAssignees()).rejects.toThrow('尚未连接共享数据库');
  });

  it('新项目从创建回执建立本机副本而不请求完整图', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    const readsBeforeCreate = s.graphReads();
    const created = await s.client.create('新项目', 'PN-01');
    expect(created.project.name).toBe('新项目');
    expect(created.project.revision).toBe(1);
    expect(s.graphReads()).toBe(readsBeforeCreate);
    expect((await s.repository.get(created.project.id)).project.name).toBe('新项目');
  });

  it('保留历史单人数据且只读，在线先共享提交再更新镜像；普通成员不能预览恢复', async () => {
    const s = setup();
    const legacy = await s.local.create('历史', 'old');
    expect(await s.repository.listProjects()).toHaveLength(1);
    await expect(s.repository.setPartNumber(legacy.project.id, 0, 'changed')).rejects.toThrow('只读');
    await s.client.login('admin', 'test', true);
    const current = (await s.repository.listProjects())[0]!;
    const readsBeforeSave = s.graphReads();
    const saved = await s.repository.setPartNumber(current.id, current.revision, '456');
    expect(saved.project.partNumber).toBe('456');
    expect(s.graphReads()).toBe(readsBeforeSave);
    expect(s.graph().project.partNumber).toBe('456');
    expect((await s.local.get(legacy.project.id)).project.partNumber).toBe('old');
    s.client.state.user!.role = 'member';
    await expect(s.repository.previewSnapshotRestore(s.graph(), current.id)).rejects.toThrow('管理员');
  });

  it('单任务修改只发送任务增量，并从提交回执更新副本而不重读完整图', async () => {
    const s = setup();
    const initial = s.graph();
    const task: Task = {
      id: crypto.randomUUID(), projectId: initial.project.id, parentTaskId: null, name: '原任务', description: '',
      externalTaskId: null, statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null,
      startDate: null, dueDate: null, sortOrder: 0, comments: [],
    };
    initial.tasks.push(task);
    s.setGraph(initial);
    await s.client.login('admin', 'test', true);
    const current = await s.repository.get(initial.project.id);
    const readsBeforeSave = s.graphReads();
    const updated = { ...task, name: '已更新任务' };
    const saved = await s.repository.saveTask(initial.project.id, current.project.revision, updated);
    expect(saved.tasks).toEqual([updated]);
    expect(s.graphReads()).toBe(readsBeforeSave);
    const request = s.requests.at(-1)?.body as ProjectChanges;
    expect(Object.keys(request)).toEqual(['revision', 'tasks']);
    expect(request.tasks).toEqual({ upsert: [updated], delete: [] });
  });

  it('相依离线版本和编辑跨重开保留，既有内容只读，重连不自动上传，确认后一次同步', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    s.network(false);
    await expect(s.client.reconnect()).rejects.toThrow('无法访问');
    let current = await s.repository.get(s.graph().project.id);
    const first = createNode(current, { version: 'V1', description: '草稿一' });
    current = await s.repository.addNode(current.project.id, current.project.revision, first, [], null);
    const second = createNode(current, { version: 'V2', description: '草稿二' });
    current = await s.repository.addNode(current.project.id, current.project.revision, second, [first.id], null);
    current = await s.repository.saveNode(current.project.id, current.project.revision, first.id, { version: 'V1a', description: '已编辑', taskId: null });
    expect(s.graph().nodes).toHaveLength(0);
    await expect(s.repository.setPartNumber(current.project.id, current.project.revision, '789')).rejects.toThrow('只读');
    const reopened = new CollaborationRepository(s.local, s.cache);
    await reopened.initialize();
    const cached = await reopened.get(current.project.id);
    expect(cached.nodes.map(node => node.version)).toEqual(['V1a', 'V2']);
    expect(cached.edges[0]?.parentId).toBe(first.id);
    s.network(true);
    await reopened.reconnect();
    expect(s.graph().nodes).toHaveLength(0);
    const preview = await reopened.previewDrafts(current.project.id);
    await reopened.syncDrafts(current.project.id, preview.graph.project.revision);
    expect(s.graph().nodes).toHaveLength(2);
    expect(reopened.state.draftCount).toBe(0);
    expect(await s.cache.drafts.count()).toBe(0);
  });

  it('共享已提交但响应丢失时锁定原内容，重连及重开后用同一请求确认，无重复版本', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    let current = await s.repository.get(s.graph().project.id);
    s.loseResponse();
    const node = createNode(current, { version: 'V1', description: '' });
    await expect(s.repository.addNode(current.project.id, current.project.revision, node, [], null)).rejects.toThrow('无法访问');
    expect(s.graph().nodes).toHaveLength(1);
    expect(s.client.state.pending).toBe(true);
    await expect(s.repository.addNode(current.project.id, current.project.revision, node, [], null)).rejects.toThrow('未确认');
    const reopened = new CollaborationRepository(s.local, s.cache);
    await reopened.initialize();
    expect(reopened.state.pending).toBe(true);
    await reopened.retryPending();
    current = await reopened.get(current.project.id);
    expect(current.nodes).toHaveLength(1);
    expect(s.requests).toHaveLength(1);
    expect(await s.cache.pending.count()).toBe(0);
  });

  it('管理员恢复到共享库后读取失败不覆盖旧副本，原请求恢复后双库一致', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    const id = s.graph().project.id;
    const restored = s.graph();
    restored.nodes.push(createNode(restored, { version: 'backup', description: '来自备份' }));
    const preview = await s.repository.previewSnapshotRestore(restored, id);
    s.legacyReceipt();
    // Fail only after the POST receipt so preview refresh can still read the old graph.
    const fetcher = globalThis.fetch;
    let injected = false;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const result = await fetcher(url, init);
      if (url.endsWith('/import') && !injected) { injected = true; s.failRead(true); }
      return result;
    });
    await expect(s.repository.restoreSnapshot(restored, id, preview)).rejects.toThrow('共享已提交');
    expect(s.graph().nodes).toHaveLength(1);
    expect((await s.repository.get(id)).nodes).toHaveLength(0);
    s.failRead(false);
    await s.client.reconnect();
    await s.client.retryPending();
    expect((await s.repository.get(id)).nodes[0]?.version).toBe('backup');
    expect(s.requests).toHaveLength(1);
  });

  it('退出保留副本草稿但禁止继续编辑；不记住登录不持久保存会话', async () => {
    const s = setup();
    await s.client.login('admin', 'test', false);
    expect((await s.cache.contexts.get('active'))?.token).toBe('');
    s.network(false);
    await expect(s.client.reconnect()).rejects.toThrow();
    let graph = await s.repository.get(s.graph().project.id);
    const node = createNode(graph, { version: 'local', description: '' });
    graph = await s.repository.addNode(graph.project.id, graph.project.revision, node, [], null);
    await s.client.logout();
    expect((await s.repository.get(graph.project.id)).nodes).toHaveLength(1);
    await expect(s.repository.saveNode(graph.project.id, graph.project.revision, node.id,
      { version: 'changed', description: '', taskId: null })).rejects.toThrow('登录');
    expect(await s.cache.drafts.count()).toBe(1);
  });

  it('共享父版本删除及版本号冲突时不丢草稿，可独立修正后再同步，导出不会静默漏掉冲突草稿', async () => {
    const s = setup();
    const shared = s.graph();
    const parent = createNode(shared, { version: 'V1', description: '' });
    shared.nodes.push(parent); s.setGraph(shared);
    await s.client.login('admin', 'test', true);
    s.network(false);
    await expect(s.client.reconnect()).rejects.toThrow();
    let graph = await s.repository.get(shared.project.id);
    const pending = createNode(graph, { version: 'V2', description: '保留我的说明' });
    graph = await s.repository.addNode(graph.project.id, graph.project.revision, pending, [parent.id], null);
    const changed = s.graph();
    changed.nodes = [createNode(changed, { version: 'V2', description: '另一成员新增' })];
    changed.project.revision++; s.setGraph(changed); s.network(true);
    await s.client.reconnect();
    expect(s.client.state.draftCount).toBe(1);
    await expect(s.client.previewDrafts(graph.project.id)).rejects.toThrow();
    await expect(s.repository.snapshot(graph.project.id)).rejects.toThrow();
    const detail = await s.client.draftDetails(graph.project.id);
    expect(detail.nodes[0]?.description).toBe('保留我的说明');
    await s.client.editDraft(graph.project.id, detail.graph.project.revision, pending.id,
      { version: 'V3', description: '修复后的说明', taskId: null }, []);
    const exported = await s.repository.snapshot(graph.project.id);
    expect(exported.graph.nodes.map(node => node.version)).toEqual(['V2', 'V3']);
    const preview = await s.client.previewDrafts(graph.project.id);
    await s.client.syncDrafts(graph.project.id, preview.graph.project.revision);
    expect(s.graph().nodes.map(node => node.version)).toEqual(['V2', 'V3']);
    expect(s.graph().edges).toHaveLength(0);
  });

  it('服务端成功、本机事务配额失败可恢复；发送前持久化失败则不发请求', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    const current = await s.repository.get(s.graph().project.id);
    vi.spyOn(s.cache.pending, 'add').mockRejectedValueOnce(new DOMException('pending quota', 'QuotaExceededError'));
    await expect(s.repository.setPartNumber(current.project.id, current.project.revision, '456')).rejects.toThrow('quota');
    expect(s.requests).toHaveLength(0);
    vi.spyOn(s.cache.mirrors, 'put').mockRejectedValueOnce(new DOMException('mirror quota', 'QuotaExceededError'));
    await expect(s.repository.setPartNumber(current.project.id, current.project.revision, '456')).rejects.toThrow('共享已提交');
    expect(s.graph().project.partNumber).toBe('456');
    expect((await s.repository.get(current.project.id)).project.partNumber).toBe('123');
    await s.client.retryPending();
    expect((await s.repository.get(current.project.id)).project.partNumber).toBe('456');
    expect(s.requests).toHaveLength(1);
  });

  it('其他标签页退出后撤销当前页面写入身份，但保留副本和原账号草稿', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    const secondTab = new CollaborationRepository(s.local, s.cache);
    await secondTab.initialize();
    s.network(false);
    await expect(s.client.reconnect()).rejects.toThrow();
    let graph = await s.repository.get(s.graph().project.id);
    graph = await s.repository.addNode(graph.project.id, graph.project.revision,
      createNode(graph, { version: 'V1', description: '原账号草稿' }), [], null);
    s.network(true);
    await secondTab.logout();
    await s.client.updateCounts();
    expect(s.client.state.user).toBeNull();
    expect(s.client.permissions.newVersionWritable).toBe(false);
    expect(s.client.state.draftCount).toBe(1);
    await expect(s.repository.saveNode(graph.project.id, graph.project.revision, graph.nodes[0]!.id,
      { version: 'V2', description: '', taskId: null })).rejects.toThrow();
    expect((await s.repository.get(graph.project.id)).nodes[0]?.description).toBe('原账号草稿');
  });

  it('切换数据库不串入旧草稿，同一库的其他账号不能编辑或同步原账号草稿', async () => {
    const s = setup();
    await s.client.login('admin', 'test', true);
    s.network(false); await expect(s.client.reconnect()).rejects.toThrow();
    const graph = await s.repository.get(s.graph().project.id);
    const pending = createNode(graph, { version: 'V1', description: '' });
    await s.repository.addNode(graph.project.id, graph.project.revision, pending, [], null);
    const other = setup();
    other.setGraph(s.graph());
    await s.client.login('admin', 'test', true);
    expect(s.client.state.source).toBe(other.source);
    expect((await s.repository.get(graph.project.id)).nodes).toHaveLength(0);
    await expect(s.client.previewDrafts(graph.project.id)).rejects.toThrow('没有');
    vi.stubGlobal('fetch', s.fetcher);
    s.network(true); s.admin.id = crypto.randomUUID(); s.admin.username = 'member';
    await s.client.login('member', 'test', true);
    expect(s.client.state.draftCount).toBe(1);
    await expect(s.client.previewDrafts(graph.project.id)).rejects.toThrow('账号');
    const detail = await s.client.draftDetails(graph.project.id);
    await expect(s.client.editDraft(graph.project.id, detail.graph.project.revision, pending.id,
      { version: 'stolen', description: '', taskId: null }, [])).rejects.toThrow('原账号');
  });
});
