import Dexie, { type Table } from 'dexie';
import { reactive, watch } from 'vue';
import { ArchiveRepository, type SnapshotImportPlan } from './database';
import type { RepositorySync } from './repository-sync';
import { BACKEND_RECHECK_INTERVAL_MS, backendAddress, backendRequestOptions, probeBackendHosts, type BackendProbe } from '../local-backend';
import { DomainError, normalizeVersion, orderedBranches, requireCondition, type ProjectGraph, type ProjectSnapshot, type TaskAssignee } from '../domain/model';
import { parseProjectSnapshot, serializeProjectSnapshot } from '../domain/project-snapshot';
import { validateGraph, validateTransition } from '../domain/graph';
import { assertOfflineChanges } from '../domain/collaboration';
import { applyProjectDelta, diffProjectGraphs, parseProjectDelta } from '../domain/project-changes';

export interface CollaborationUser {
  id: string; username: string; displayName: string; email: string;
  role: 'admin' | 'member'; disabled: boolean; mustChangePassword: boolean; avatar: string | null;
}
interface Context {
  id: 'active'; source: string; actorId: string | null; user: CollaborationUser | null; token: string; expiresAt: number;
}
interface Mirror { key: string; source: string; graph: ProjectGraph; version: number; updatedAt: number; deleted: boolean }
interface Draft { key: string; owner: string; nodes: ProjectGraph['nodes']; edges: ProjectGraph['edges'] }
interface Pending {
  key: string; source: string; owner: string; requestId: string; method: string; path: string;
  body: unknown; projectId: string | null; clearDraft: boolean;
}
interface CachedAssignee extends TaskAssignee { key: string; source: string }

export class CollaborationDatabase extends Dexie {
  contexts!: Table<Context, string>;
  mirrors!: Table<Mirror, string>;
  drafts!: Table<Draft, string>;
  pending!: Table<Pending, string>;
  assignees!: Table<CachedAssignee, string>;
  constructor(name = 'iqan-archive-collaboration') {
    super(name);
    this.version(1).stores({ contexts: 'id', mirrors: 'key, source', drafts: 'key', pending: 'key' });
    this.version(2).stores({ assignees: 'key, source' }).upgrade(async transaction => {
      const pending = transaction.table<Pending>('pending');
      requireCondition(await pending.count() === 0, 'PENDING_MIGRATION',
        '存在结果未确认的协作提交。请先使用旧版重新连接并处理提交，再重试本次更新。');
      const mirrors = transaction.table<Mirror>('mirrors');
      for (const mirror of await mirrors.toArray()) {
        const graph = structuredClone(mirror.graph);
        const changed = graph.project.assigneeOptions.length > 0
          || graph.tasks.some(task => task.assigneeId !== null);
        if (!changed) continue;
        graph.project.assigneeOptions = [];
        for (const task of graph.tasks) task.assigneeId = null;
        await mirrors.put({ ...mirror, graph });
      }
    });
  }
}

export class CollaborationError extends Error {
  constructor(message: string, public readonly status = 0, public readonly code = 'NETWORK') { super(message); }
}

function object(value: unknown): Record<string, unknown> {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'RESPONSE', '服务响应格式无效。');
  return Object.fromEntries(Object.entries(value));
}

function user(value: unknown): CollaborationUser {
  const row = object(value);
  requireCondition(typeof row.id === 'string' && typeof row.username === 'string' && typeof row.displayName === 'string'
    && typeof row.email === 'string' && (row.role === 'admin' || row.role === 'member')
    && typeof row.disabled === 'boolean' && typeof row.mustChangePassword === 'boolean'
    && (row.avatar === null || typeof row.avatar === 'string'), 'RESPONSE', '账号响应格式无效。');
  return {
    id: row.id, username: row.username, displayName: row.displayName, email: row.email,
    role: row.role, disabled: row.disabled, mustChangePassword: row.mustChangePassword, avatar: row.avatar,
  };
}

function memberPath(username: string): string {
  const name = username.trim().toLowerCase();
  requireCondition(/^[a-z][a-z0-9._-]{2,31}$/.test(name), 'USERNAME', '请选择或填写有效成员账号。');
  return `/users/${encodeURIComponent(name)}`;
}

function taskAssignee(value: unknown): TaskAssignee {
  const row = object(value);
  requireCondition(typeof row.id === 'string' && row.id.length > 0
    && typeof row.username === 'string' && typeof row.displayName === 'string'
    && typeof row.disabled === 'boolean'
    && (row.avatar === undefined || row.avatar === null
      || (typeof row.avatar === 'string' && row.avatar.startsWith('data:image/png;base64,') && row.avatar.length <= 90_000)),
  'RESPONSE', '负责人账号响应格式无效。');
  return {
    id: row.id, username: row.username, displayName: row.displayName, disabled: row.disabled,
    avatar: typeof row.avatar === 'string' ? row.avatar : null,
  };
}

export function collaborationSnapshot(graph: ProjectGraph): ProjectSnapshot {
  const { id, name, partNumber, revision, statusOptions, typeOptions, priorityOptions, assigneeOptions } = graph.project;
  return {
    schemaVersion: 8,
    graph: {
      ...graph,
      project: { id, name, partNumber, revision, statusOptions, typeOptions, priorityOptions, assigneeOptions },
      branches: orderedBranches(graph.branches).map(({ order: _order, ...branch }) => branch),
    },
  };
}

export class CollaborationRepository implements RepositorySync {
  readonly state = reactive({
    source: '', user: null as CollaborationUser | null, connected: false, authenticated: false,
    busy: false, message: '', draftCount: 0, pending: false, updatedAt: 0,
    draftNodeIds: {} as Record<string, string[]>,
    draftProjectIds: [] as string[],
    deletedProjectIds: [] as string[], conflictMessage: '',
  });
  private token = '';
  private remember = false;
  private expiresAt = 0;
  private writing = false;
  private mutations = 0;
  private activeRequests = 0;
  private background: AbortController | undefined;
  private backgroundResult: { generation: number; results: BackendProbe[]; error: string } | undefined;

  constructor(readonly local: ArchiveRepository, readonly cache = new CollaborationDatabase()) {
    watch(() => local.db.backendConnection.state.generation, () => {
      this.background?.abort();
      this.background = undefined;
      this.backgroundResult = undefined;
      this.disconnect();
    }, { flush: 'sync' });
    watch(() => this.state.busy, () => this.applyBackgroundResult(), { flush: 'sync' });
  }

  private async mutation<T>(action: () => Promise<T>): Promise<T> {
    this.mutations++;
    try { return await action(); }
    finally { this.mutations--; this.applyBackgroundResult(); }
  }

  private checkConnectionInBackground() {
    const connection = this.local.db.backendConnection.state;
    if (this.background || this.backgroundResult || Date.now() - connection.lastTestedAt <= BACKEND_RECHECK_INTERVAL_MS) return;
    const controller = new AbortController();
    const generation = connection.generation;
    this.background = controller;
    void (async () => {
      try {
        const hosts = await this.local.getBackendHosts();
        controller.signal.throwIfAborted();
        const results = await probeBackendHosts(hosts, controller.signal);
        if (controller.signal.aborted || generation !== connection.generation) return;
        connection.lastTestedAt = Date.now();
        this.backgroundResult = { generation, results, error: '' };
      } catch (cause) {
        if (controller.signal.aborted || generation !== connection.generation) return;
        connection.lastTestedAt = Date.now();
        this.backgroundResult = {
          generation, results: [], error: `后台连接测试失败，已暂停后续联网写入。${cause instanceof Error ? cause.message : '请检查设备设置后重新测试。'}`,
        };
      } finally {
        if (this.background === controller) this.background = undefined;
        this.applyBackgroundResult();
      }
    })();
  }

  private applyBackgroundResult() {
    if (this.mutations || this.activeRequests || this.writing || this.state.busy || !this.backgroundResult) return;
    const { generation, results, error } = this.backgroundResult;
    this.backgroundResult = undefined;
    this.local.db.backendConnection.applyBackgroundResults(results, generation, error);
  }

  get permissions() {
    const available = Boolean(this.state.source && this.state.user && !this.state.user.mustChangePassword && !this.state.pending);
    let sharedWriteBlockedReason = '';
    if (!this.state.source) sharedWriteBlockedReason = '历史单人数据目前只读，请登录后由管理员通过 JSON 恢复迁入共享库。';
    else if (!this.state.user) sharedWriteBlockedReason = '请先登录共享账号；未登录时本机副本只读。';
    else if (this.state.user.mustChangePassword) sharedWriteBlockedReason = '首次登录请先修改初始密码，再进行共享修改。';
    else if (this.state.pending) sharedWriteBlockedReason = '存在结果未确认的提交，新的共享修改已暂停。请打开账号菜单的“协作与同步”，确认连接和登录后点击“重试未确认提交”；不要重复创建或恢复。';
    else if (!this.state.connected) sharedWriteBlockedReason = '当前未连接本机后端，共享版本只读；仅可新增版本并编辑本机待同步版本。请在“协作与同步”中重新连接。';
    else if (!this.state.authenticated) sharedWriteBlockedReason = '当前会话尚未验证，共享内容只读；请在账号入口重新连接或登录。';
    return {
      sharedWritable: sharedWriteBlockedReason === '',
      sharedWriteBlockedReason,
      newVersionWritable: available && (!this.state.connected || this.state.authenticated),
      draftNodeIds: this.state.draftNodeIds,
      draftProjectIds: this.state.draftProjectIds,
    };
  }
  private async context() {
    const context = await this.cache.contexts.get('active');
    if (context && this.state.source && !this.state.user?.mustChangePassword
      && (context.source !== this.state.source || (this.state.user && context.actorId !== this.state.user.id))) {
      this.state.source = context.source; this.state.user = null; this.token = '';
      this.state.connected = false; this.state.authenticated = false;
      this.state.message = '其他标签页已切换数据库或账号 / 退出，请重新登录。副本和草稿均保留。';
    }
    return context;
  }
  private key(id: string) { return `${this.state.source}:${id}`; }
  private actorKey() {
    requireCondition(this.state.user, 'LOGIN', '请先登录原账号。');
    return `${this.state.source}:${this.state.user.id}`;
  }
  private assertOnline(admin = false) {
    requireCondition(this.state.connected && this.state.authenticated && this.state.user
      && !this.state.user.mustChangePassword, 'LOGIN', '此操作需要连接共享数据库并登录；首次登录请先修改密码。');
    if (admin) requireCondition(this.state.user.role === 'admin', 'ADMIN_REQUIRED', '此操作仅限管理员。');
  }

  async request(path: string, method = 'GET', body?: unknown, requestId?: string): Promise<unknown> {
    const connection = this.local.db.backendConnection.state;
    requireCondition(connection.host && !connection.testing, 'BACKEND_HOST', '尚未选定唯一后端主机，请在后端主机设置中测试连接或重新连接。');
    this.activeRequests++;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) this.checkConnectionInBackground();
    try { return await this.performRequest(path, method, body, requestId); }
    finally { this.activeRequests--; this.applyBackgroundResult(); }
  }

  private async performRequest(path: string, method: string, body?: unknown, requestId?: string): Promise<unknown> {
    const connection = this.local.db.backendConnection.state;
    const { host, generation } = connection;
    requireCondition(host && !connection.testing, 'BACKEND_HOST', '尚未选定唯一后端主机，请在后端主机设置中测试连接或重新连接。');
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['Idempotency-Key'] = requestId;
    if (this.state.source && requestId) headers['X-Archive-Database'] = this.state.source;
    let response: Response;
    try {
      response = await fetch(`${backendAddress(host)}${path}`, backendRequestOptions({
        method, headers, body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(65_000),
      }));
    } catch {
      if (generation !== connection.generation) throw new CollaborationError('后端选择已变化，旧请求结果未确认；请保留原请求并重新连接后核对。', 0, 'CONNECTION_CHANGED');
      this.state.connected = false;
      this.state.authenticated = false;
      throw new CollaborationError('无法访问后端，已保留本机副本与草稿。请检查所选设备的 80 端口、网页来源授权及共享目录；不会自动重发本次请求。');
    }
    if (generation !== connection.generation) throw new CollaborationError('后端选择已变化，旧请求结果未确认；请保留原请求并重新连接后核对。', 0, 'CONNECTION_CHANGED');
    let value: unknown;
    try { value = await response.json(); }
    catch {
      if (generation !== connection.generation) throw new CollaborationError('后端选择已变化，旧请求结果未确认；请保留原请求并重新连接后核对。', 0, 'CONNECTION_CHANGED');
      this.state.connected = false;
      throw new CollaborationError('后端响应不完整，操作结果未确认；请使用“重试未确认提交”，不要重复创建。');
    }
    if (generation !== connection.generation) throw new CollaborationError('后端选择已变化，旧请求结果未确认；请保留原请求并重新连接后核对。', 0, 'CONNECTION_CHANGED');
    if (!response.ok) {
      if (response.status === 401) {
        this.state.connected = true; this.state.authenticated = false;
      }
      if (response.status >= 500) { this.state.connected = false; this.state.authenticated = false; }
      const error = object(object(value).error);
      throw new CollaborationError(typeof error.message === 'string' ? error.message : `HTTP ${response.status}`,
        response.status, typeof error.code === 'string' ? error.code : 'HTTP');
    }
    return value;
  }

  private async persistContext() {
    await this.cache.contexts.put({
      id: 'active', source: this.state.source, user: this.remember && this.state.user ? user(this.state.user) : null,
      actorId: this.state.user?.id ?? null,
      token: this.remember ? this.token : '', expiresAt: this.remember ? this.expiresAt : 0,
    });
  }

  async initialize() {
    const context = await this.context();
    if (!context) return;
    this.state.source = context.source;
    if (context.token && context.expiresAt > Date.now()) {
      this.token = context.token; this.expiresAt = context.expiresAt; this.remember = true;
      this.state.user = context.user ? user(context.user) : null;
      try { await this.reconnect(); }
      catch (cause) { this.state.message = cause instanceof Error ? cause.message : '连接失败，本机副本仍可浏览。'; }
    }
    await this.updateCounts();
  }

  disconnect() {
    this.state.connected = false; this.state.authenticated = false;
    this.state.message = '连接设置已改变，请重新连接或登录。当前仅可读副本及编辑本机新增版本。';
  }

  async login(username: string, password: string, remember: boolean) {
    return this.mutation(async () => {
      if (!this.local.db.backendConnection.state.host) await this.local.testBackendHosts(new AbortController().signal);
      const value = object(await this.request('/auth/login', 'POST', { username, password, remember }));
      requireCondition(typeof value.token === 'string' && typeof value.expiresAt === 'number', 'RESPONSE', '登录响应无效。');
      this.token = value.token; this.expiresAt = value.expiresAt; this.remember = remember;
      this.state.user = user(value.user);
      this.state.connected = true; this.state.authenticated = true;
      if (this.state.user.mustChangePassword) return;
      await this.verifySession();
    });
  }

  async reconnect() {
    requireCondition(this.token, 'LOGIN', '请先登录。');
    await this.local.testBackendHosts(new AbortController().signal);
    await this.verifySession();
  }

  private async verifySession() {
    this.state.user = user(object(await this.request('/auth/me')).user);
    this.state.connected = true; this.state.authenticated = true;
    if (this.state.user.mustChangePassword) return;
    const instance = object(await this.request('/instance'));
    requireCondition(typeof instance.databaseId === 'string' && /^[0-9a-f-]{36}$/.test(instance.databaseId),
      'SERVICE_VERSION', '服务缺少数据库身份，请更新并重启后端。');
    this.state.source = instance.databaseId;
    await this.persistContext();
    await this.refresh();
  }

  async logout() {
    return this.mutation(async () => {
      if (this.state.authenticated) await this.request('/auth/logout', 'POST', {});
      await this.cache.contexts.put({ id: 'active', source: this.state.source, actorId: null, user: null, token: '', expiresAt: 0 });
      this.token = ''; this.state.user = null; this.remember = false; this.state.authenticated = false;
      await this.updateCounts();
    });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    requireCondition(currentPassword !== newPassword, 'PASSWORD_REUSE', '新密码必须与当前密码不同。');
    return this.mutation(async () => {
      await this.request('/auth/password', 'POST', { currentPassword, newPassword });
      await this.cache.contexts.put({ id: 'active', source: this.state.source, actorId: null, user: null, token: '', expiresAt: 0 });
      this.token = ''; this.state.user = null; this.state.authenticated = false;
      this.state.message = '密码已修改，旧会话已撤销，请重新登录。';
    });
  }

  async listUsers() {
    this.assertOnline(true);
    const value = object(await this.request('/users'));
    requireCondition(Array.isArray(value.users), 'RESPONSE', '成员列表响应无效。');
    return value.users.map(user);
  }

  async listAssignees(): Promise<TaskAssignee[]> {
    await this.context();
    const source = this.state.source;
    requireCondition(source, 'SOURCE', '尚未连接共享数据库，无法读取负责人。请前往账号同步页连接共享数据库后重试。');
    const cached = (await this.cache.assignees.where('source').equals(source).toArray())
      .map(assignee => ({ ...assignee, ...taskAssignee(assignee) }));
    if (!this.state.connected || !this.state.authenticated) {
      if (cached.length) return cached;
      throw new CollaborationError('当前未连接共享账号目录，无法读取负责人。请前往账号同步页重新连接后重试。');
    }

    try {
      const value = object(await this.request('/assignees'));
      requireCondition(Array.isArray(value.assignees), 'RESPONSE', '负责人账号列表响应无效。');
      const assignees = value.assignees.map(taskAssignee);
      requireCondition(new Set(assignees.map(assignee => assignee.id)).size === assignees.length,
        'RESPONSE', '负责人账号列表包含重复 ID。');
      requireCondition(this.state.source === source, 'SOURCE', '数据源已切换，请重新读取负责人账号。');
      await this.cache.transaction('rw', this.cache.assignees, async () => {
        await this.cache.assignees.where('source').equals(source).delete();
        await this.cache.assignees.bulkPut(assignees.map(assignee => ({
          ...assignee, key: `${source}:${assignee.id}`, source,
        })));
      });
      return assignees;
    } catch (cause) {
      if (!this.state.connected && cached.length) return cached;
      throw cause;
    }
  }

  async createUser(input: { username: string; password: string; displayName: string; email: string }) {
    this.assertOnline(true);
    return this.mutation(async () => user(object(await this.request('/users', 'POST', input)).user));
  }

  async manageUser(username: string, disabled: boolean, newPassword?: string) {
    this.assertOnline(true);
    return this.mutation(async () => user(object(await this.request(memberPath(username), 'PATCH',
      newPassword === undefined ? { disabled } : { disabled, newPassword })).user));
  }

  async deleteUser(username: string) {
    this.assertOnline(true);
    return this.mutation(async () => {
      const result = object(await this.request(memberPath(username), 'DELETE'));
      requireCondition(result.deleted === true, 'RESPONSE', '账号删除结果未确认，请刷新成员列表核对后再操作。');
    });
  }

  async saveProfile(input: { displayName: string; email: string; avatar: string | null }) {
    this.assertOnline();
    return this.mutation(async () => {
      this.state.user = user(object(await this.request('/auth/profile', 'PUT', input)).user);
      await this.persistContext();
    });
  }

  async listProjects() {
    const context = await this.context();
    if (!context?.source) return this.local.listProjects();
    const mirrors = await this.cache.mirrors.where('source').equals(context.source).toArray();
    const results: ProjectGraph['project'][] = [];
    for (const mirror of mirrors) {
      if (!mirror.deleted || await this.cache.drafts.get(mirror.key)) {
        results.push((await this.get(mirror.graph.project.id)).project);
      }
    }
    return results;
  }

  async get(id: string): Promise<ProjectGraph> {
    const context = await this.context();
    if (!context?.source) return this.local.get(id);
    const mirror = await this.cache.mirrors.get(`${context.source}:${id}`);
    requireCondition(mirror, 'PROJECT_NOT_FOUND', '本机没有该共享项目的副本，请连接后刷新。');
    const draft = await this.cache.drafts.get(mirror.key);
    const graph = this.overlay(mirror, draft);
    if (draft) {
      try { validateGraph(graph); }
      catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
        this.state.message = `待同步版本存在冲突，图暂仅显示共享基线；草稿完整保留。请在账号入口“检查 / 修复当前项目草稿”中修正：${cause.message}`;
        return { ...structuredClone(mirror.graph), project: { ...mirror.graph.project, revision: mirror.version } };
      }
    }
    return graph;
  }

  private overlay(mirror: Mirror, draft: Draft | undefined) {
    const graph = structuredClone(mirror.graph);
    graph.project.revision = mirror.version;
    if (draft) {
      const nodes = new Set(graph.nodes.map(node => node.id));
      const edges = new Set(graph.edges.map(edge => edge.id));
      graph.nodes.push(...draft.nodes.filter(node => !nodes.has(node.id)));
      graph.edges.push(...draft.edges.filter(edge => !edges.has(edge.id)));
    }
    return graph;
  }

  async snapshot(id: string): Promise<ProjectSnapshot> {
    const context = await this.context();
    if (!context?.source) return this.local.snapshot(id);
    const mirror = await this.cache.mirrors.get(`${context.source}:${id}`);
    requireCondition(mirror, 'PROJECT_NOT_FOUND', '本机没有可导出的项目副本。');
    const graph = this.overlay(mirror, await this.cache.drafts.get(mirror.key));
    validateGraph(graph);
    return collaborationSnapshot(graph);
  }

  async draftDetails(id: string) {
    const mirror = await this.cache.mirrors.get(this.key(id));
    const draft = mirror ? await this.cache.drafts.get(mirror.key) : undefined;
    requireCondition(mirror && draft, 'DRAFTS', '当前项目没有待同步草稿。');
    return { graph: this.overlay(mirror, draft), nodes: draft.nodes, owner: draft.owner, deleted: mirror.deleted };
  }

  async editDraft(id: string, revision: number, nodeId: string, update: { version: string; description: string; taskId: string | null }, parentIds: readonly string[]) {
    const actor = this.actorKey();
    const mirror = await this.mirror(id, revision);
    const draft = await this.cache.drafts.get(mirror.key);
    requireCondition(draft && draft.owner === this.state.user?.id, 'DRAFT_OWNER', '仅原账号可以修改草稿。');
    requireCondition(!this.state.user?.mustChangePassword && (!this.state.connected || this.state.authenticated), 'LOGIN', '会话失效或需要修改初始密码，请重新登录。');
    const next = structuredClone(draft);
    const node = next.nodes.find(item => item.id === nodeId);
    requireCondition(node && !mirror.graph.nodes.some(item => item.id === nodeId), 'DRAFT_NODE', '只能修改尚未确认发布的新版本。');
    node.version = normalizeVersion(update.version); node.description = update.description.trim(); node.taskId = update.taskId;
    const allNodes = [...mirror.graph.nodes, ...next.nodes];
    requireCondition(allNodes.every(item => item.id === nodeId || item.version !== node.version), 'DUPLICATE_VERSION', '版本号已存在，请修改草稿版本号。');
    requireCondition(node.taskId === null || mirror.graph.tasks.some(task => task.id === node.taskId), 'TASK_REFERENCE', '所选任务已失效，请重新选择或清空。');
    requireCondition(parentIds.every(parent => parent !== nodeId && allNodes.some(item => item.id === parent)), 'PARENT_REFERENCE', '存在失效或自身父引用，请移除后重新选择。');
    next.edges = next.edges.filter(edge => edge.childId !== nodeId);
    next.edges.push(...[...new Set(parentIds)].map(parentId => ({ id: crypto.randomUUID(), projectId: id, parentId, childId: nodeId })));
    serializeProjectSnapshot(collaborationSnapshot(this.overlay(mirror, next)));
    const parents = new Map<string, string[]>();
    for (const edge of [...mirror.graph.edges, ...next.edges]) parents.set(edge.childId, [...(parents.get(edge.childId) ?? []), edge.parentId]);
    const visited = new Set<string>(), pending = [...parentIds];
    while (pending.length) {
      const current = pending.pop()!;
      requireCondition(current !== nodeId, 'CYCLE', '父版本关系会形成循环。');
      if (!visited.has(current)) { visited.add(current); pending.push(...(parents.get(current) ?? [])); }
    }
    await this.cache.transaction('rw', [this.cache.mirrors, this.cache.drafts, this.cache.pending], async () => {
      requireCondition(!await this.cache.pending.get(actor), 'PENDING', '请先重试结果未确认的提交。');
      requireCondition((await this.cache.mirrors.get(mirror.key))?.version === revision, 'STALE_REVISION', '草稿或副本已变化，请重新打开。');
      await this.cache.drafts.put(next);
      await this.cache.mirrors.put({ ...mirror, version: revision + 1 });
    });
    await this.updateCounts();
  }

  async updateCounts() {
    const context = await this.context();
    if (!context?.source) return;
    const mirrors = await this.cache.mirrors.where('source').equals(context.source).toArray();
    const drafts = await this.cache.drafts.bulkGet(mirrors.map(item => item.key));
    this.state.updatedAt = mirrors.reduce((latest, item) => Math.max(latest, item.updatedAt), 0);
    this.state.draftCount = drafts.reduce((count, item) => count + (item?.nodes.length ?? 0), 0);
    this.state.draftNodeIds = Object.fromEntries(mirrors.map((mirror, index) =>
      [mirror.graph.project.id, drafts[index]?.nodes.map(node => node.id) ?? []]));
    this.state.draftProjectIds = mirrors.filter((_item, index) => drafts[index]).map(item => item.graph.project.id);
    this.state.deletedProjectIds = mirrors.filter(item => item.deleted).map(item => item.graph.project.id);
    const conflicts: string[] = [];
    for (const [index, mirror] of mirrors.entries()) if (drafts[index]) {
      try { validateGraph(this.overlay(mirror, drafts[index])); }
      catch (cause) {
        if (!(cause instanceof DomainError)) throw cause;
        conflicts.push(`${mirror.graph.project.name}：${cause.message}`);
      }
    }
    this.state.conflictMessage = conflicts.join('；');
    this.state.pending = this.state.user ? Boolean(await this.cache.pending.get(this.actorKey())) : false;
  }

  async refresh() {
    this.assertOnline();
    requireCondition(!this.writing, 'BUSY', '提交进行中，请稍后刷新。');
    const source = this.state.source;
    const instance = object(await this.request('/instance'));
    requireCondition(instance.databaseId === source, 'DATABASE_SOURCE', '连接的数据库已变化，请重新登录；旧库副本和草稿不会转移。');
    const listing = object(await this.request('/projects'));
    requireCondition(Array.isArray(listing.projects), 'RESPONSE', '项目列表无效。');
    const graphs: ProjectGraph[] = [];
    for (const item of listing.projects) {
      const project = object(item);
      requireCondition(typeof project.id === 'string', 'RESPONSE', '项目身份无效。');
      graphs.push(parseProjectSnapshot(await this.request(`/projects/${project.id}/graph`)));
    }
    requireCondition(this.state.source === source, 'SOURCE', '数据源已切换，请重新刷新。');
    await this.cache.transaction('rw', [this.cache.mirrors, this.cache.drafts], async () => {
      const seen = new Set(graphs.map(graph => this.key(graph.project.id)));
      for (const mirror of await this.cache.mirrors.where('source').equals(source).toArray()) {
        if (seen.has(mirror.key)) continue;
        if (await this.cache.drafts.get(mirror.key)) await this.cache.mirrors.put({ ...mirror, deleted: true });
        else await this.cache.mirrors.delete(mirror.key);
      }
      for (const graph of graphs) await this.putMirror(graph);
    });
    this.state.updatedAt = Date.now();
    this.state.message = '共享数据已更新到本机副本。';
    await this.updateCounts();
  }

  private async putMirror(graph: ProjectGraph) {
    const key = this.key(graph.project.id);
    const previous = await this.cache.mirrors.get(key);
    await this.cache.mirrors.put({
      key, source: this.state.source, graph,
      version: previous && JSON.stringify(previous.graph) === JSON.stringify(graph) ? previous.version : (previous?.version ?? 0) + 1,
      updatedAt: Date.now(), deleted: false,
    });
  }

  private async mirror(id: string, revision: number) {
    await this.context();
    requireCondition(this.state.source, 'LEGACY_READONLY', '历史单人数据目前只读，请登录后由管理员通过 JSON 恢复迁入共享库。');
    const mirror = await this.cache.mirrors.get(this.key(id));
    requireCondition(mirror && !mirror.deleted, 'PROJECT_NOT_FOUND', '共享项目不存在或已删除，草稿仍保留。');
    requireCondition(mirror.version === revision, 'STALE_REVISION', '本机副本已变化，请刷新并保留当前输入。');
    return mirror;
  }

  private async mutate(method: string, path: string, body: unknown, projectId: string | null, clearDraft = false): Promise<ProjectGraph | null> {
    await this.context();
    this.assertOnline();
    const key = this.actorKey();
    requireCondition(!await this.cache.pending.get(key), 'PENDING', '存在结果未确认的提交，请先重试原提交。');
    const pending: Pending = {
      key, source: this.state.source, owner: this.state.user!.id, requestId: crypto.randomUUID(),
      method, path, body: structuredClone(body), projectId, clearDraft,
    };
    await this.cache.pending.add(pending);
    this.state.pending = true;
    return this.finish(pending);
  }

  async retryPending() {
    this.assertOnline();
    const pending = await this.cache.pending.get(this.actorKey());
    requireCondition(pending, 'PENDING', '没有待确认提交。');
    return this.finish(pending);
  }

  private async finish(pending: Pending): Promise<ProjectGraph | null> {
    requireCondition(!this.writing, 'BUSY', '已有提交进行中，请等待结果。');
    requireCondition(pending.source === this.state.source && pending.owner === this.state.user?.id, 'SOURCE', '提交不属于当前数据源或账号。');
    this.writing = true;
    let committed = false;
    try {
      const result = object(await this.request(pending.path, pending.method, pending.body, pending.requestId));
      committed = true;
      requireCondition(typeof result.projectId === 'string' && /^[0-9a-f-]{36}$/.test(result.projectId)
        && (pending.projectId === null || pending.projectId === result.projectId)
        && typeof result.revision === 'number' && Number.isSafeInteger(result.revision) && result.revision >= 0
        && typeof result.deleted === 'boolean', 'RESPONSE', '提交回执无效，已保留原请求。');
      const delta = result.delta === undefined ? null : parseProjectDelta(result.delta, result.projectId);
      requireCondition(!delta || (!result.deleted && delta.revision === result.revision),
        'RESPONSE', '提交回执与项目变更修订或删除状态不一致，已保留原请求。');
      let graph: ProjectGraph | null = null;
      if (!result.deleted) {
        const key = this.key(result.projectId);
        const mirror = await this.cache.mirrors.get(key);
        const canApplyDelta = delta?.baseRevision === null
          ? !mirror
          : Boolean(delta && mirror && !mirror.deleted && mirror.graph.project.revision === delta.baseRevision);
        if (delta && canApplyDelta) {
          graph = parseProjectSnapshot(collaborationSnapshot(applyProjectDelta(mirror?.graph ?? null, delta)));
          requireCondition(graph.project.id === result.projectId && graph.project.revision === result.revision,
            'RESPONSE', '提交增量的项目身份或修订无效，已保留原请求。');
        } else {
          graph = parseProjectSnapshot(await this.request(`/projects/${result.projectId}/graph`));
          requireCondition(graph.project.id === result.projectId && graph.project.revision >= result.revision,
            'RESPONSE', '读取的项目身份或修订与提交回执不一致，请保留原请求并重试。');
        }
      }
      requireCondition(pending.source === this.state.source && pending.owner === this.state.user?.id, 'SOURCE', '提交期间账号或来源改变，已保留原请求供原账号恢复。');
      await this.cache.transaction('rw', [this.cache.mirrors, this.cache.drafts, this.cache.pending], async () => {
        if (graph) await this.putMirror(graph);
        else await this.cache.mirrors.delete(this.key(String(result.projectId)));
        if (pending.clearDraft || result.deleted) await this.cache.drafts.delete(this.key(String(result.projectId)));
        await this.cache.pending.delete(pending.key);
      });
      this.state.message = '共享提交及本机副本更新已完成。';
      await this.updateCounts();
      return graph ? this.get(graph.project.id) : null;
    } catch (cause) {
      if (!committed && cause instanceof CollaborationError && cause.status >= 400 && cause.status < 500
        && cause.status !== 401 && cause.status !== 403 && cause.code !== 'DATABASE_SOURCE') {
        await this.cache.pending.delete(pending.key);
        this.state.pending = false;
      }
      if (committed) throw new CollaborationError(`共享已提交，但本机副本更新未完成。请重试未确认提交，勿重复操作。${cause instanceof Error ? cause.message : ''}`);
      throw cause;
    } finally { this.writing = false; this.applyBackgroundResult(); }
  }

  async create(name: string, partNumber: string): Promise<ProjectGraph> {
    const graph = await this.mutate('POST', '/projects', { name, partNumber }, null);
    requireCondition(graph, 'RESPONSE', '新项目响应无效。');
    return graph;
  }

  async change(id: string, revision: number, transform: (graph: ProjectGraph) => ProjectGraph, deletion: boolean, operation?: unknown): Promise<ProjectGraph> {
    const mirror = await this.mirror(id, revision);
    requireCondition(!this.state.pending && !await this.cache.pending.get(this.actorKey()), 'PENDING', '请先处理结果未确认的提交。');
    const current = await this.get(id);
    requireCondition(current.project.revision === revision, 'STALE_REVISION', '本机副本已变化，请重新读取。');
    const next = transform(structuredClone(current));
    if (deletion) validateGraph(next); else validateTransition(current, next);
    const draft = await this.cache.drafts.get(mirror.key);
    if (!this.state.connected || draft) {
      requireCondition(this.state.user && !this.state.user.mustChangePassword
        && (!this.state.connected || this.state.authenticated), 'LOGIN', '请先登录并完成初始改密；退出后的副本只读。');
      requireCondition(!draft || draft.owner === this.state.user.id, 'DRAFT_OWNER', '此草稿仅原账号可以修改或同步。');
      assertOfflineChanges({ ...mirror.graph, project: { ...mirror.graph.project, revision } }, next);
      serializeProjectSnapshot(collaborationSnapshot(next));
      const existing = new Set(mirror.graph.nodes.map(node => node.id));
      await this.cache.transaction('rw', [this.cache.mirrors, this.cache.drafts, this.cache.pending], async () => {
        const latest = await this.cache.mirrors.get(mirror.key);
        requireCondition(latest?.version === revision && !await this.cache.pending.get(this.actorKey()),
          'STALE_REVISION', '另一窗口已更新副本或提交，请重新读取。');
        await this.cache.drafts.put({
          key: mirror.key, owner: this.state.user!.id,
          nodes: next.nodes.filter(node => !existing.has(node.id)), edges: next.edges.filter(edge => !existing.has(edge.childId)),
        });
        await this.cache.mirrors.put({ ...mirror, version: revision + 1 });
      });
      this.state.message = '版本已保存为本机待同步草稿，尚未写入 Access。';
      await this.updateCounts();
      return this.get(id);
    }
    const metadata = operation === undefined ? null : object(operation);
    const sharedRevision = mirror.graph.project.revision;
    next.project.revision = sharedRevision;
    const suffix = metadata?.state ? 'state' : metadata ? 'command' : '';
    const base = { ...current, project: { ...current.project, revision: sharedRevision } };
    const body = metadata?.state ? { revision: sharedRevision, nodeId: metadata.nodeId, action: metadata.state }
      : metadata ? { revision: sharedRevision, command: metadata } : diffProjectGraphs(base, next);
    const result = await this.mutate(suffix ? 'POST' : 'PATCH', `/projects/${id}${suffix ? `/${suffix}` : ''}`, body, id);
    requireCondition(result, 'RESPONSE', '保存响应无效。');
    return result;
  }

  async previewDrafts(id: string) {
    this.assertOnline();
    await this.refresh();
    const detail = await this.draftDetails(id);
    requireCondition(detail.owner === this.state.user?.id, 'DRAFT_OWNER', '当前项目没有属于此账号的待同步草稿。');
    validateGraph(detail.graph);
    return { graph: detail.graph, nodes: detail.nodes };
  }

  async syncDrafts(id: string, previewRevision: number) {
    this.assertOnline();
    const current = (await this.draftDetails(id)).graph;
    requireCondition(current.project.revision === previewRevision, 'STALE_REVISION', '同步预览已变化，请重新预览。');
    const mirror = await this.mirror(id, current.project.revision);
    const draft = await this.cache.drafts.get(mirror.key);
    requireCondition(draft && draft.owner === this.state.user?.id, 'DRAFT_OWNER', '没有当前账号可同步的草稿。');
    validateGraph(current);
    assertOfflineChanges(mirror.graph, current);
    await this.mutate('POST', `/projects/${id}/offline`,
      diffProjectGraphs(mirror.graph, current), id, true);
  }

  async deleteProject(id: string, revision: number, confirmedName: string) {
    const mirror = await this.mirror(id, revision);
    requireCondition(!await this.cache.drafts.get(mirror.key), 'DRAFTS', '请先同步待同步版本，不能静默删除草稿。');
    await this.mutate('DELETE', `/projects/${id}`, { revision: mirror.graph.project.revision, confirmedName }, id);
  }

  async restoreUndo(id: string, revision: number, graph: ProjectGraph): Promise<ProjectGraph> {
    const mirror = await this.mirror(id, revision);
    requireCondition(!await this.cache.drafts.get(mirror.key), 'DRAFTS', '存在离线草稿时请在版本编辑中修改草稿；共享撤销不会丢弃草稿。');
    const result = await this.mutate('POST', `/projects/${id}/undo`,
      { revision: mirror.graph.project.revision, snapshot: collaborationSnapshot(graph) }, id);
    requireCondition(result, 'RESPONSE', '撤销响应无效。');
    return result;
  }

  async previewSnapshotRestore(graph: ProjectGraph, currentId: string): Promise<SnapshotImportPlan> {
    this.assertOnline(true);
    validateGraph(graph);
    await this.refresh();
    const mirrors = await this.cache.mirrors.where('source').equals(this.state.source).toArray();
    const activeIds = new Set(mirrors.filter(item => !item.deleted).map(item => item.graph.project.id));
    const projects = (await this.listProjects()).filter(project => activeIds.has(project.id));
    const partMatches = projects.filter(project => project.partNumber.trim() === graph.project.partNumber.trim());
    const nameMatches = projects.filter(project => project.name.trim() === graph.project.name.trim());
    let blockedReason = partMatches.length > 1 ? '多个共享项目零件号相同，不能确定恢复目标。' : '';
    if (currentId && partMatches[0]?.id !== currentId) blockedReason = '备份零件号未唯一匹配当前共享项目。';
    if (partMatches[0] && await this.cache.drafts.get(this.key(partMatches[0].id))) blockedReason = '目标项目有待同步草稿，请先同步；恢复不会自动丢弃草稿。';
    return { target: partMatches.length === 1 ? partMatches[0]! : null, partMatches, nameMatches, blockedReason };
  }

  async restoreSnapshot(graph: ProjectGraph, currentId: string, preview: SnapshotImportPlan): Promise<ProjectGraph> {
    this.assertOnline(true);
    const latest = await this.previewSnapshotRestore(graph, currentId);
    requireCondition(!latest.blockedReason, 'SNAPSHOT_TARGET', latest.blockedReason);
    requireCondition(JSON.stringify(latest) === JSON.stringify(preview), 'SNAPSHOT_STALE', '共享项目已变化，请重新预览恢复。');
    const restored = structuredClone(graph);
    const id = latest.target?.id ?? crypto.randomUUID();
    restored.project.id = id;
    for (const item of [...restored.nodes, ...restored.edges, ...restored.branches, ...restored.tasks]) item.projectId = id;
    const mirror = latest.target ? await this.cache.mirrors.get(this.key(id)) : undefined;
    const result = await this.mutate('POST', `/projects/${id}/import`,
      { snapshot: collaborationSnapshot(restored), expectedRevision: mirror?.graph.project.revision ?? null }, id);
    requireCondition(result, 'RESPONSE', '恢复响应无效。');
    return result;
  }
}
