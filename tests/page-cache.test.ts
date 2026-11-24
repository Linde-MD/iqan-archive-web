import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { createProject, type ProjectGraph } from '../src/domain/model';
import { summarizeProject } from '../src/domain/project-views';
import { filterProjectTasks } from '../src/domain/task-board';
import { ArchiveDatabase, ArchiveRepository, projectPageFromGraph } from '../src/storage/database';
import { CollaborationDatabase, CollaborationRepository, collaborationSnapshot } from '../src/storage/collaboration';

const databases: Dexie[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map(db => db.delete()));
});

function setup() {
  const source = crypto.randomUUID();
  const account = { id: crypto.randomUUID(), username: 'admin', displayName: '管理员', email: '', role: 'admin' as const,
    disabled: false, mustChangePassword: false, avatar: null };
  const graph = createProject('测试项目', '123');
  graph.nodes.push({ id: crypto.randomUUID(), projectId: graph.project.id, version: 'V1', description: '正文'.repeat(10000), taskId: null, releasedAt: null, testingAt: null });
  graph.tasks.push({ id: crypto.randomUUID(), projectId: graph.project.id, parentTaskId: null, name: '任务', description: `${'长'.repeat(200)}仅全文可见`,
    externalTaskId: '1', statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null,
    startDate: null, dueDate: null, sortOrder: 0, comments: [] });
  let online = true, listed = true;
  const paths: string[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (!online) throw new TypeError('offline');
    const path = new URL(url).pathname;
    paths.push(path);
    const response = (body: unknown) => new Response(JSON.stringify(body));
    if (path === '/health') return response({ product: 'iqan-archive-server', apiVersion: 2, databaseVersion: 9, initialized: true });
    if (path === '/auth/login') return response({ token: 'token', expiresAt: Date.now() + 100000, user: account });
    if (path === '/auth/me') return response({ user: account });
    if (path === '/instance') return response({ databaseId: source });
    if (path === '/projects') return response({ projects: listed ? [summarizeProject(graph.project)] : [] });
    if (path === `/projects/${graph.project.id}`) return response(summarizeProject(graph.project));
    if (path === `/projects/${graph.project.id}/view/files`) return response(projectPageFromGraph(graph, 'files'));
    if (path === `/projects/${graph.project.id}/view/graph`) return response(projectPageFromGraph(graph, 'graph'));
    if (path === `/projects/${graph.project.id}/view/tasks`) return response(projectPageFromGraph(graph, 'tasks'));
    if (path === `/projects/${graph.project.id}/graph`) return response(collaborationSnapshot(graph));
    if (path === `/projects/${graph.project.id}/tasks/${graph.tasks[0]!.id}`) return response({ revision: graph.project.revision, task: graph.tasks[0] });
    if (path === `/projects/${graph.project.id}/nodes/${graph.nodes[0]!.id}`) return response({ revision: graph.project.revision, node: graph.nodes[0] });
    throw new Error(`unexpected ${init.method} ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const localDb = new ArchiveDatabase(`page-local-${crypto.randomUUID()}`);
  const cache = new CollaborationDatabase(`page-cache-${crypto.randomUUID()}`);
  databases.push(localDb, cache);
  const local = new ArchiveRepository(localDb);
  vi.spyOn(local, 'getBackendHosts').mockResolvedValue(['fixture-host']);
  const sync = new CollaborationRepository(local, cache);
  const repository = new ArchiveRepository(localDb, sync);
  return { source, account, graph, paths, sync, cache, repository, fetcher, delist: () => { listed = false; },
    offline: () => { online = false; sync.disconnect(); } };
}

it('目录和页面按需读取，完整加载不改变本地修订', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  expect(s.paths).not.toContain('/requests/client');
  expect(s.paths.some(path => path.endsWith('/graph'))).toBe(false);
  expect(await s.repository.listProjects()).toHaveLength(1);
  await s.repository.loadPage(s.graph.project.id, 'files');
  const files = await s.repository.getFilesView(s.graph.project.id);
  expect(JSON.stringify(files)).not.toContain(s.graph.nodes[0]!.description);
  const full = await s.repository.get(s.graph.project.id);
  expect(full.nodes[0]!.description).toBe(s.graph.nodes[0]!.description);
  expect(full.project.revision).toBe(files.project.revision);
  expect(s.paths.filter(path => path.endsWith('/graph'))).toHaveLength(1);
});

it('消息定位仅加载目标页面和任务，删除评论仍可定位任务，工作区变化不提交缓存', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  await s.sync.syncCommentTarget(s.graph.project.id, s.graph.tasks[0]!.id, () => true);
  expect(s.paths.some(path => path.endsWith('/graph'))).toBe(false);
  expect((await s.repository.getBoardView(s.graph.project.id)).tasks[0]!.id).toBe(s.graph.tasks[0]!.id);
  const pages = await s.cache.pages.toArray();
  await expect(s.sync.syncCommentTarget(s.graph.project.id, s.graph.tasks[0]!.id, () => false)).rejects.toThrow('工作区已变化');
  expect(await s.cache.pages.toArray()).toEqual(pages);
});

it('离线可读已有页面，未缓存页面和完整项目明确失败', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  await s.repository.loadPage(s.graph.project.id, 'files');
  s.offline();
  await expect(s.repository.loadPage(s.graph.project.id, 'files')).resolves.toBeUndefined();
  await expect(s.repository.loadPage(s.graph.project.id, 'tasks')).rejects.toMatchObject({ code: 'PAGE_OFFLINE' });
  await expect(s.repository.get(s.graph.project.id)).rejects.toMatchObject({ code: 'PROJECT_OFFLINE' });
});

it('v3→v4 保留镜像、草稿、未确认请求与客户端槽位', async () => {
  const name = `page-upgrade-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(3).stores({ contexts: 'id', mirrors: 'key, source', drafts: 'key', pending: 'key', assignees: 'key, source', clients: 'key' });
  const graph: ProjectGraph = createProject('旧项目', '123');
  const mirror = { key: `s:${graph.project.id}`, source: 's', graph, version: 3, updatedAt: 1, deleted: false };
  const draft = { key: mirror.key, owner: 'u', nodes: [], edges: [] };
  const pending = { key: 's:u', source: 's', owner: 'u', requestId: 'slot:0:1:1', method: 'PATCH', path: '/projects/x', body: {}, projectId: 'x', clearDraft: false, phase: 'ack' };
  const client = { key: 's:u', clientId: 'c', binding: { slot: 0, generation: 1, sequence: 1 } };
  await old.table('mirrors').put(mirror);
  await old.table('drafts').put(draft);
  await old.table('pending').put(pending);
  await old.table('clients').put(client);
  old.close();
  const upgraded = new CollaborationDatabase(name);
  databases.push(upgraded);
  expect(await upgraded.mirrors.get(mirror.key)).toEqual(mirror);
  expect(await upgraded.drafts.get(draft.key)).toEqual(draft);
  expect(await upgraded.pending.get(pending.key)).toEqual(pending);
  expect(await upgraded.clients.get(client.key)).toEqual(client);
});

it('任务与版本正文仅在需要时单项读取', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  const id = s.graph.project.id;
  await s.repository.loadPage(id, 'tasks');
  const board = await s.repository.getBoardView(id);
  expect(JSON.stringify(board)).not.toContain('仅全文可见');
  expect(JSON.stringify(board)).not.toContain(s.graph.nodes[0]!.description);
  expect(() => filterProjectTasks(board.tasks, 'all', null, 'keyword', '全文', new Map())).toThrow('全文搜索需要先加载完整项目');
  expect((await s.repository.getTaskDetail(id, s.graph.tasks[0]!.id)).task.description).toBe(s.graph.tasks[0]!.description);
  expect((await s.repository.getNodeDetail(id, s.graph.nodes[0]!.id)).node.description).toBe(s.graph.nodes[0]!.description);
  expect(s.paths).not.toContain(`/projects/${id}/graph`);
});

it('权威空目录不恢复旧镜像，但保留镜像数据', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  await s.repository.get(s.graph.project.id);
  s.delist();
  await s.sync.refresh();
  expect(await s.repository.listProjects()).toEqual([]);
  expect(await s.cache.mirrors.count()).toBe(1);
  await expect(s.repository.getProjectInfo(s.graph.project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
});

it('旧的页面响应不能覆盖较新修订', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  const id = s.graph.project.id;
  const original = s.fetcher.getMockImplementation()!;
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const oldView = projectPageFromGraph(structuredClone(s.graph), 'files');
  s.fetcher.mockImplementation(async (url, init) => {
    if (new URL(url).pathname === `/projects/${id}/view/files`) {
      started();
      await waiting;
      return new Response(JSON.stringify(oldView));
    }
    return original(url, init);
  });

  const oldLoad = s.repository.loadPage(id, 'files');
  await began;
  s.graph.project.revision++;
  await s.sync.refresh();
  release();
  await oldLoad;
  expect(await s.cache.pages.count()).toBe(0);
  expect((await s.repository.getProjectInfo(id)).revision).toBe(2);
});

it('旧目录响应不能覆盖较新的空目录', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  const original = s.fetcher.getMockImplementation()!;
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const oldListing = { projects: [summarizeProject(s.graph.project)] };
  let delayed = false;
  s.fetcher.mockImplementation(async (url, init) => {
    if (new URL(url).pathname === '/projects' && !delayed) {
      delayed = true; started(); await waiting;
      return new Response(JSON.stringify(oldListing));
    }
    return original(url, init);
  });
  const oldRefresh = s.sync.refresh();
  await began;
  s.delist();
  await s.sync.refresh();
  release();
  await expect(oldRefresh).rejects.toMatchObject({ code: 'SOURCE' });
  expect(await s.repository.listProjects()).toEqual([]);
});

it('未确认请求阻止页面响应覆盖待恢复基线', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  const key = `${s.source}:${s.account.id}`;
  await s.cache.pending.put({ key, source: s.source, owner: s.account.id, requestId: 'slot:0:1:1',
    method: 'PATCH', path: '/projects/x', body: {}, projectId: s.graph.project.id, clearDraft: false, phase: 'ack' });
  await s.repository.loadPage(s.graph.project.id, 'files');
  expect(await s.cache.pages.count()).toBe(0);
  expect((await s.cache.pending.get(key))?.phase).toBe('ack');
});

it('当前页面轮询只刷新该投影，不下载完整项目', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  const id = s.graph.project.id;
  await s.repository.loadPage(id, 'files');
  s.paths.length = 0;
  s.graph.project.revision++;
  s.graph.nodes[0]!.version = 'V2';
  expect(await s.sync.pollProject(id, () => true, new AbortController().signal, () => true, 'files')).toBe(true);
  expect(s.paths).toEqual([`/projects/${id}`, `/projects/${id}/view/files`]);
  expect((await s.repository.getFilesView(id)).nodes[0]!.version).toBe('V2');
  expect((await s.repository.getFilesView(id)).project.revision).toBe(2);
});

it('变更先读取完整项目并验证服务器修订，再调用变换函数', async () => {
  const s = setup();
  await s.sync.login('admin', 'test', true);
  const id = s.graph.project.id;
  await s.repository.loadPage(id, 'tasks');
  const revision = (await s.repository.getBoardView(id)).project.revision;
  const transform = vi.fn((full: ProjectGraph): ProjectGraph => {
    expect(full.tasks[0]!.description).toBe(s.graph.tasks[0]!.description);
    expect(full.nodes[0]!.description).toBe(s.graph.nodes[0]!.description);
    throw new Error('test-transform');
  });
  s.graph.project.revision++;
  await expect(s.sync.change(id, revision, transform, false)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  expect(transform).not.toHaveBeenCalled();
  expect(s.paths).toContain(`/projects/${id}/graph`);
  s.graph.project.revision--;
  await expect(s.sync.change(id, revision, transform, false)).rejects.toThrow('test-transform');
  expect(transform).toHaveBeenCalledTimes(1);
  expect(s.paths).not.toContain('/requests/client');
});
