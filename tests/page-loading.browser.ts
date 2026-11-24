import Dexie from 'dexie';
import { createApp, h, nextTick, ref } from 'vue';
import App from '../src/App.vue';
import { router } from '../src/router';
import { projectPath } from '../src/workspace-routes';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';
import { CollaborationDatabase, CollaborationRepository, collaborationSnapshot } from '../src/storage/collaboration';
import CommentInbox from '../src/components/CommentInbox.vue';
import { createProject, type ProjectGraph, type Task } from '../src/domain/model';
import { summarizeProject, summarizeTask, summarizeVersion, type ProjectPageView } from '../src/domain/project-views';
import { applyProjectDelta, createProjectDelta, type ProjectChanges } from '../src/domain/project-changes';
import type { CommentNotification } from '../src/domain/comment-inbox';
import '../src/style.css';

declare global {
  interface Window {
    pageLoadingFixture?: { cleanup: () => Promise<void>; requests: string[] };
  }
}

const result = document.querySelector<HTMLElement>('#result')!;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor(condition: () => boolean) {
  const deadline = performance.now() + 15_000;
  const channel = new MessageChannel();
  try {
    while (performance.now() < deadline) {
      await nextTick();
      if (condition()) return;
      // Background automation throttles timers even when document visibility is simulated.
      await new Promise<void>(resolve => { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); });
    }
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
  throw new Error(`等待页面状态超时：${condition.toString().slice(0, 300)}；${document.querySelector('.inbox-status')?.textContent ?? ''}`);
}

async function checkInboxIsolation(local: ArchiveDatabase, cache: CollaborationDatabase, notice: CommentNotification) {
  const client = new CollaborationRepository(new ArchiveRepository(local), cache);
  const scope = ref('first');
  const readStates = new Map<string, boolean>();
  const deferred = new Map<string, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  client.request = async (path, method) => {
    const actor = scope.value;
    const summary = { revision: readStates.get(actor) ? 2 : 1, unreadCount: readStates.get(actor) ? 0 : 1 };
    if (method === 'POST') return new Promise((resolve, reject) => deferred.set(actor, { resolve, reject }));
    if (path === '/inbox/summary') return summary;
    assert(path === '/inbox/list', '消息隔离检查发出意外请求');
    return { ...summary, items: [{ ...notice, id: actor, actorName: actor, read: readStates.get(actor) ?? false }] };
  };
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(CommentInbox, {
    client, scope: scope.value, directoryKey: 0, directoryActive: false, openTarget: async () => {},
  }) });
  app.mount(root);
  const openAndRead = async () => {
    await waitFor(() => root.querySelector('.inbox-trigger')?.getAttribute('aria-label')?.includes('1 条未读') === true);
    root.querySelector<HTMLButtonElement>('.inbox-trigger')!.click();
    await waitFor(() => !!root.querySelector('.inbox-panel[open] .inbox-read:not(:disabled)'));
    root.querySelector<HTMLButtonElement>('.inbox-read')!.click();
    await waitFor(() => root.querySelector<HTMLButtonElement>('.inbox-read')?.disabled === true);
  };
  try {
    for (const rejectOld of [false, true]) {
      readStates.clear();
      deferred.clear();
      scope.value = 'first';
      await openAndRead();
      const old = deferred.get('first')!;
      scope.value = 'second';
      await openAndRead();
      if (rejectOld) old.reject(new Error('旧账号请求失败'));
      else old.resolve({ revision: 99, unreadCount: 0 });
      await nextTick();
      await new Promise<void>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
        channel.port2.postMessage(null);
      });
      assert(root.querySelector<HTMLButtonElement>('.inbox-read')!.disabled
        && root.querySelector('.inbox-trigger')!.getAttribute('aria-label')!.includes('1 条未读')
        && root.querySelector('.inbox-entry')!.textContent?.includes('second')
        && !root.textContent?.includes('旧账号请求失败'), '旧消息操作污染新账号忙碌、未读或错误状态');
      readStates.set('second', true);
      deferred.get('second')!.resolve({ revision: 2, unreadCount: 0 });
      await waitFor(() => !root.querySelector('.inbox-read'));
      root.querySelector<HTMLButtonElement>('.inbox-header button')!.click();
      await waitFor(() => document.activeElement === root.querySelector('.inbox-trigger'));
    }
    let failList = true;
    let showNotice = false;
    client.request = async path => {
      const summary = { revision: showNotice ? 3 : 2, unreadCount: showNotice ? 1 : 0 };
      if (path === '/inbox/summary') return summary;
      assert(path === '/inbox/list', '消息状态检查发出意外请求');
      if (failList) throw new Error('Access 数据读取失败；请检查后端诊断及共享连接后重试。');
      return { ...summary, items: showNotice ? [{ ...notice, read: false, mention: false,
        actorName: '长名称发送者'.repeat(8), taskName: '长任务名称'.repeat(20), projectName: '长项目名称'.repeat(20) }] : [] };
    };
    scope.value = 'states';
    await nextTick();
    root.querySelector<HTMLButtonElement>('.inbox-trigger')!.click();
    await waitFor(() => root.querySelector('.inbox-error')?.textContent?.includes('Access 数据读取失败') === true);
    assert(!root.textContent?.includes('暂无消息'), '读取失败被伪装成空消息');
    failList = false;
    root.querySelector<HTMLButtonElement>('.inbox-error button')!.click();
    await waitFor(() => root.querySelector('.inbox-state')?.textContent?.includes('暂无消息') === true && !root.querySelector('.inbox-error'));
    showNotice = true;
    root.querySelector<HTMLButtonElement>('.inbox-refresh')!.click();
    await waitFor(() => !!root.querySelector('.inbox-entry') && !root.querySelector<HTMLButtonElement>('.inbox-refresh')!.disabled);
    const bounds = root.querySelector('.inbox-panel')!.getBoundingClientRect();
    const body = root.querySelector<HTMLElement>('.inbox-body')!;
    const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const checkboxBounds = checkbox.getBoundingClientRect();
    assert(bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth
      && body.scrollWidth <= body.clientWidth + 1, '长消息或面板横向溢出');
    assert(checkboxBounds.width <= 24 && checkboxBounds.height <= 24
      && checkbox.closest('label')!.getBoundingClientRect().height >= 44, '未读复选框尺寸或点击目标异常');
    root.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click();
    await waitFor(() => root.querySelector('.inbox-state')?.textContent?.includes('暂无 @ 提及') === true);
    checkbox.click();
    await waitFor(() => root.querySelector('.inbox-state')?.textContent?.includes('没有未读消息') === true);
    const retryTarget = root.querySelector<HTMLButtonElement>('.inbox-refresh')!;
    retryTarget.focus();
    assert(document.activeElement === retryTarget && retryTarget.getBoundingClientRect().height >= 44, '刷新按钮不可键盘访问');
  } finally {
    app.unmount();
    root.remove();
  }
}

async function run() {
  const originalFactory = Dexie.dependencies.indexedDB;
  assert(originalFactory, '浏览器没有 IndexedDB');
  const prefix = `page-fixture-${crypto.randomUUID()}-`;
  const names = new Set<string>();
  // Prefix every database opened by the actual App so existing user databases remain untouched.
  Dexie.dependencies.indexedDB = new Proxy(originalFactory, {
    get(target, property) {
      if (property === 'open') return (name: string, version?: number) => {
        names.add(prefix + name);
        return target.open(prefix + name, version);
      };
      if (property === 'deleteDatabase') return (name: string) => target.deleteDatabase(prefix + name);
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const originalFetch = window.fetch;
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  // Background browser automation still exercises the visible-page polling path.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  const requests: string[] = [];
  const runtimeErrors: string[] = [];
  const onError = (event: ErrorEvent) => { runtimeErrors.push(event.message); };
  const onRejection = (event: PromiseRejectionEvent) => {
    const cause: unknown = event.reason;
    runtimeErrors.push(cause instanceof Error ? cause.message : String(cause));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  let offline = false;
  const source = crypto.randomUUID();
  const user = {
    id: crypto.randomUUID(), username: 'fixture', displayName: '页面测试', email: '',
    role: 'admin' as const, disabled: false, mustChangePassword: false, avatar: null,
  };
  const historian = { ...user, id: crypto.randomUUID(), username: 'historian', displayName: '历史人员', disabled: true };
  const first = createProject('按需测试 A', '123');
  const second = createProject('按需测试 B', '456');
  const task: Task = {
    id: crypto.randomUUID(), projectId: first.project.id, parentTaskId: null, name: '按需任务',
    description: `${'完整说明'.repeat(2000)}\n任务正文专用标识`, externalTaskId: '12',
    statusOptionId: null, typeOptionId: null, priorityOptionId: null, assigneeId: null,
    startDate: null, dueDate: null, sortOrder: 0,
    comments: [{ id: crypto.randomUUID(), text: `评论正文专用标识${'评论'.repeat(2000)}`,
      createdAt: '2026-11-23T00:00:00.000Z', updatedAt: '2026-11-23T00:00:00.000Z' }],
  };
  first.tasks.push(task);
  const otherTask: Task = { ...task, id: crypto.randomUUID(), projectId: second.project.id, name: '另一个项目的任务',
    description: '跨项目正文', comments: [{ ...task.comments[0]!, id: crypto.randomUUID(), text: '跨项目评论' }] };
  second.tasks.push(otherTask);
  const notifications: CommentNotification[] = [
    { id: 'current', projectId: first.project.id, projectName: first.project.name, taskId: task.id, taskName: task.name,
      commentId: task.comments[0]!.id, actorId: historian.id, actorName: '现有评论发送者',
      createdAt: '2026-11-23T00:00:00.000Z', reply: true, mention: true, read: false },
    { id: 'deleted-comment', projectId: first.project.id, projectName: first.project.name, taskId: task.id, taskName: task.name,
      commentId: crypto.randomUUID(), actorId: historian.id, actorName: '删除评论发送者',
      createdAt: '2026-11-23T00:00:00.000Z', reply: false, mention: true, read: false },
    { id: 'deleted-task', projectId: first.project.id, projectName: first.project.name, taskId: crypto.randomUUID(), taskName: '已删除任务',
      commentId: crypto.randomUUID(), actorId: historian.id, actorName: '删除任务发送者',
      createdAt: '2026-11-23T00:00:00.000Z', reply: false, mention: true, read: false },
    { id: 'other-project', projectId: second.project.id, projectName: second.project.name, taskId: otherTask.id, taskName: otherTask.name,
      commentId: otherTask.comments[0]!.id, actorId: historian.id, actorName: '跨项目发送者',
      createdAt: '2026-11-23T00:00:00.000Z', reply: true, mention: false, read: false },
  ];
  let inboxRevision = 1;
  const inboxSummary = () => ({ revision: inboxRevision, unreadCount: notifications.filter(item => !item.read).length });
  first.nodes.push(
    { id: crypto.randomUUID(), projectId: first.project.id, version: 'V1', description: '第一版说明',
      taskId: task.id, releasedAt: null, testingAt: null },
    { id: crypto.randomUUID(), projectId: first.project.id, version: 'V2', description: '第二版说明',
      taskId: task.id, releasedAt: null, testingAt: null },
  );
  first.edges.push({ id: crypto.randomUUID(), projectId: first.project.id,
    parentId: first.nodes[0]!.id, childId: first.nodes[1]!.id });
  first.branches.push({ id: crypto.randomUUID(), projectId: first.project.id, name: '主线',
    description: '分支说明', color: '#60a5fa', headId: first.nodes[1]!.id });
  const graphs = new Map<string, ProjectGraph>([first, second].map(graph => [graph.project.id, graph]));
  function view(graph: ProjectGraph, page: string): ProjectPageView {
    const { project, nodes, edges, branches, tasks } = graph;
    if (page === 'files') return { kind: 'files', revision: project.revision,
      project: summarizeProject(project), nodes: nodes.map(summarizeVersion), edges };
    if (page === 'graph') return { kind: 'graph', revision: project.revision,
      project, nodes, edges, branches, tasks: tasks.map(summarizeTask) };
    assert(page === 'tasks', '未知页面投影');
    return { kind: 'tasks', revision: project.revision,
      project, nodes: nodes.map(summarizeVersion), edges, branches, tasks: tasks.map(summarizeTask) };
  }
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = url.pathname;
    requests.push(`${method} ${path}`);
    if (offline) throw new TypeError('fixture offline');
    let body: unknown;
    if (path === '/health') body = { product: 'iqan-archive-server', apiVersion: 2, databaseVersion: 9, initialized: true };
    else if (path === '/auth/me') body = { user };
    else if (path === '/instance') body = { databaseId: source };
    else if (path === '/projects') body = { projects: [...graphs.values()].map(graph => summarizeProject(graph.project)) };
    else if (path === '/inbox/summary') body = inboxSummary();
    else if (path === '/inbox/list') body = { ...inboxSummary(), items: notifications };
    else if (path === '/inbox/read') {
      const value = JSON.parse(String(init?.body)) as { id?: string };
      for (const item of notifications) if (!item.read && (!value.id || item.id === value.id)) { item.read = true; inboxRevision++; }
      body = inboxSummary();
    } else if (path === '/requests/client') body = { slot: 0, generation: 1, sequence: 0 };
    else if (path === '/requests/ack') body = { acknowledged: true };
    else if (path === '/assignees' || path === '/comment-directory') body = { users: [user, historian] };
    else {
      const metadata = /^\/projects\/([^/]+)$/.exec(path);
      if (metadata) {
        const graph = graphs.get(decodeURIComponent(metadata[1]!));
        assert(graph, '读取了未知项目摘要');
        if (method === 'PATCH') {
          const changes = JSON.parse(String(init?.body)) as ProjectChanges;
          const next = applyProjectDelta(graph, { ...changes, baseRevision: graph.project.revision, revision: graph.project.revision + 1 });
          graphs.set(graph.project.id, next);
          return new Response(JSON.stringify({ projectId: next.project.id, revision: next.project.revision, deleted: false,
            delta: createProjectDelta(graph, next) }), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify(summarizeProject(graph.project)), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      const match = /^\/projects\/([^/]+)\/(.*)$/.exec(path);
      assert(match, `意外请求：${method} ${path}`);
      const graph = graphs.get(decodeURIComponent(match[1]!));
      assert(graph, '请求了未知项目');
      const child = match[2]!;
      if (child.startsWith('view/')) body = view(graph, child.slice(5));
      else if (child === 'revision') body = { revision: graph.project.revision };
      else if (child === 'graph') body = collaborationSnapshot(graph);
      else if (child.startsWith('tasks/')) {
        const target = graph.tasks.find(item => item.id === child.slice(6));
        if (!target) return new Response(JSON.stringify({ error: { code: 'PROJECT_ENTITY_NOT_FOUND', message: '原任务不存在或已删除。' } }), { status: 404 });
        body = { revision: graph.project.revision, task: target };
      } else if (child.startsWith('nodes/')) {
        const target = graph.nodes.find(item => item.id === child.slice(6));
        assert(target, '请求了未知版本');
        body = { revision: graph.project.revision, node: target };
      } else throw new Error(`意外项目请求：${method} ${path}`);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const local = new ArchiveDatabase();
  const cache = new CollaborationDatabase();
  const app = createApp(App);
  let mounted = false;
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (mounted) app.unmount();
    local.close();
    cache.close();
    window.fetch = originalFetch;
    Dexie.dependencies.indexedDB = originalFactory;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
    for (const name of names) {
      await new Promise<void>((resolve, reject) => {
        const request = originalFactory!.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`测试库清理受阻：${name}`));
      });
    }
  }
  window.pageLoadingFixture = { cleanup, requests };
  try {
    await local.backendSettings.put({ id: 'connection', hosts: ['fixture-host'], notes: {}, defaultNotes: {} });
    await cache.contexts.put({ id: 'active', source, actorId: user.id, user,
      token: 'fixture-token', expiresAt: Date.now() + 3_600_000 });
    await router.replace('/');
    app.use(router);
    await router.isReady();
    app.mount('#app');
    mounted = true;
    await waitFor(() => document.body.textContent?.includes('按需测试 B') === true);
    const fullReads = () => requests.filter(path => path.endsWith('/graph') && !path.includes('/view/'));
    assert(fullReads().length === 0, '启动仍然下载完整项目图');
    assert(requests.filter(path => path.endsWith('/instance')).length === 1, '启动重复读取实例');
    assert(!requests.some(path => path.includes('/requests/client')), '只读登录仍提前注册回执槽');
    assert(!requests.some(path => path.includes('/comment-directory')), '启动仍提前读取评论成员目录');

    await router.push(projectPath(first.project.id, 'files'));
    await waitFor(() => !!document.querySelector('.file-workspace .version-list code'));
    assert(runtimeErrors.length === 0, `页面运行异常：${runtimeErrors.join('; ')}`);
    assert(requests.filter(path => path.endsWith('/view/files')).length === 1, '文件页未只加载一次版本索引');
    assert(!requests.some(path => /\/view\/(graph|tasks)$/.test(path)), '文件页加载了隐藏页面');

    const beforeDocuments = requests.length;
    await router.push(projectPath(first.project.id, 'documents'));
    await waitFor(() => !!document.querySelector('.document-workspace'));
    assert(!document.querySelector('.file-workspace'), '隐藏文件页仍挂载');
    assert(!requests.slice(beforeDocuments).some(path => path.includes(`/projects/${first.project.id}/`)),
      '文档页下载了远端项目内容');

    await router.push(projectPath(first.project.id, 'graph'));
    await waitFor(() => !!document.querySelector('.git-row-commit'));
    assert(!document.querySelector('.document-workspace'), '隐藏文档页仍挂载');
    assert(fullReads().length === 0, '浏览版本图读取了完整任务正文');

    await router.push(projectPath(first.project.id, 'tasks'));
    await waitFor(() => requests.some(path => path.endsWith('/view/tasks'))
      && document.body.textContent?.includes(task.name) === true);
    assert(!document.querySelector('.git-row-commit'), '隐藏版本图仍挂载');
    assert(!requests.some(path => path.includes(`/tasks/${task.id}`)), '任务列表提前加载了详情');
    assert(fullReads().length === 0, '任务列表下载了完整项目');

    await router.push(projectPath(first.project.id, 'tasks', 'detail', task.id));
    await waitFor(() => document.body.textContent?.includes('任务正文专用标识') === true);
    await waitFor(() => requests.some(path => path.endsWith('/comment-directory')));
    assert(requests.filter(path => path.includes(`/tasks/${task.id}`)).length === 1, '任务详情没有单项按需读取');
    assert(fullReads().length === 0, '打开任务详情下载了全部任务正文');
    assert(requests.some(path => path.endsWith('/comment-directory')), '评论详情未读取成员目录');

    await router.push(projectPath(first.project.id, 'graph', 'node', first.nodes[0]!.id));
    await waitFor(() => [...document.querySelectorAll<HTMLElement>('.git-row-commit')]
      .some(row => row.textContent?.includes('V1')));
    const versionRow = [...document.querySelectorAll<HTMLElement>('.git-row-commit')]
      .find(row => row.textContent?.includes('V1'))!;
    versionRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => !!document.querySelector('#git-version'));
    assert(fullReads().every(path => path.includes(first.project.id)), '编辑读取了其他项目');
    assert(document.querySelector<HTMLInputElement>('#git-version')?.value === 'V1', '编辑草稿未使用完整版本字段');
    assert(!requests.some(path => path.includes('/requests/client')), '打开编辑器提前注册了写入槽');
    await waitFor(() => !!document.querySelector('#git-author option[value="historian"]'));
    assert(document.querySelector<HTMLOptionElement>('#git-author option[value="historian"]')!.textContent?.startsWith('历史人员'),
      '作者选择器未优先显示显示名称');
    const chooseAuthor = (value: string) => {
      const select = document.querySelector<HTMLSelectElement>('#git-author')!;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    assert(document.querySelector<HTMLSelectElement>('#git-author')!.value === '', '旧节点作者被错误回填');
    chooseAuthor('historian');
    document.querySelector<HTMLFormElement>('.graph-form form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('#git-author'));
    assert(graphs.get(first.project.id)!.nodes[0]!.author === 'historian', '作者选择未实际保存');
    assert(document.body.textContent?.includes('作者：历史人员'), '作者详情未显示账号显示名称');
    document.querySelector<HTMLButtonElement>('button[aria-label="编辑版本"]')!.click();
    await waitFor(() => document.querySelector<HTMLSelectElement>('#git-author')?.value === 'historian');
    chooseAuthor('');
    document.querySelector<HTMLFormElement>('.graph-form form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('#git-author'));
    assert(graphs.get(first.project.id)!.nodes[0]!.author === '', '作者清空未实际保存');
    document.querySelector<HTMLButtonElement>('button[aria-label="新增未关联版本"]')!.click();
    await waitFor(() => !!document.querySelector('#git-author'));
    assert(document.querySelector<HTMLSelectElement>('#git-author')!.value === user.username, '新版本未默认登录用户名');
    assert(document.querySelector<HTMLSelectElement>('#git-author')!.selectedOptions[0]!.textContent?.startsWith(user.displayName),
      '新版本默认作者未显示显示名称');
    const versionInput = document.querySelector<HTMLInputElement>('#git-version')!;
    versionInput.value = '未保存版本';
    versionInput.dispatchEvent(new Event('input', { bubbles: true }));
    const openInbox = async () => {
      document.querySelector<HTMLButtonElement>('.inbox-trigger')!.click();
      await waitFor(() => !!document.querySelector('.inbox-panel[open] .inbox-entry:not(:disabled)'));
    };
    const visit = (actor: string) => [...document.querySelectorAll<HTMLButtonElement>('.inbox-entry')]
      .find(button => button.textContent?.includes(actor))!.click();
    await openInbox();
    const inboxBounds = document.querySelector('.inbox-panel')!.getBoundingClientRect();
    assert(inboxBounds.left >= 0 && inboxBounds.right <= innerWidth,
      `消息面板超出视口：left=${inboxBounds.left}, right=${inboxBounds.right}, viewport=${innerWidth}, client=${document.documentElement.clientWidth}`);
    const draftRoute = router.currentRoute.value.fullPath;
    visit('现有评论发送者');
    await waitFor(() => document.querySelector('.inbox-panel[open]')?.textContent?.includes('请先保存或关闭') === true);
    assert(router.currentRoute.value.fullPath === draftRoute && versionInput.value === '未保存版本'
      && !notifications[0]!.read, '消息跳转丢失草稿或提前标已读');
    document.querySelector<HTMLButtonElement>('.inbox-header button')!.click();
    await waitFor(() => !document.querySelector('.inbox-panel[open]'));
    [...document.querySelectorAll<HTMLButtonElement>('.graph-form button')].find(button => button.textContent === '取消')!.click();
    await waitFor(() => !document.querySelector('#git-author')
      && router.currentRoute.value.path === projectPath(first.project.id, 'graph'));
    await openInbox();
    visit('现有评论发送者');
    await waitFor(() => notifications[0]!.read && document.activeElement instanceof HTMLElement
      && document.activeElement.dataset.commentId === task.comments[0]!.id);
    assert(router.currentRoute.value.path === projectPath(first.project.id, 'tasks', 'detail', task.id)
      && !!document.querySelector('.is-focused-comment'), '消息未定位正确任务/评论');
    await openInbox();
    visit('现有评论发送者');
    await waitFor(() => !document.querySelector('.inbox-panel[open]') && document.activeElement instanceof HTMLElement
      && document.activeElement.dataset.commentId === task.comments[0]!.id);
    await openInbox();
    visit('删除评论发送者');
    await waitFor(() => notifications[1]!.read && !!document.querySelector('.task-comment-notice'));
    assert(document.querySelector('.task-comment-notice')!.textContent?.includes('已删除'), '删除评论未明确提示');
    await openInbox();
    const deletedTaskRoute = router.currentRoute.value.fullPath;
    visit('删除任务发送者');
    await waitFor(() => document.querySelector('.inbox-panel[open]')?.textContent?.includes('原任务不存在') === true);
    assert(!notifications[2]!.read && router.currentRoute.value.fullPath === deletedTaskRoute, '删除任务消息被误标已读或导航');
    document.querySelector<HTMLButtonElement>('.inbox-header button')!.click();
    await waitFor(() => !document.querySelector('.inbox-panel[open]'));
    await openInbox();
    visit('跨项目发送者');
    await waitFor(() => notifications[3]!.read && document.activeElement instanceof HTMLElement
      && document.activeElement.dataset.commentId === otherTask.comments[0]!.id);
    assert(router.currentRoute.value.path === projectPath(second.project.id, 'tasks', 'detail', otherTask.id), '消息没有跨项目跳转');
    await router.push(projectPath(first.project.id, 'files'));
    await waitFor(() => !!document.querySelector('.file-workspace .version-list code'));

    offline = true;
    await router.push(projectPath(second.project.id, 'graph'));
    await waitFor(() => [...document.querySelectorAll('[role="alert"]')]
      .some(alert => /尚未缓存在本机|无法访问后端/.test(alert.textContent ?? '')));
    assert(!document.querySelector('.git-row-commit'), '未缓存页面离线时伪造了完整图');
    await router.push(projectPath(first.project.id, 'files'));
    await waitFor(() => !!document.querySelector('.file-workspace .version-list code'));
    assert(runtimeErrors.length === 0, `页面运行异常：${runtimeErrors.join('; ')}`);
    const panel = document.querySelector('.file-workspace')!.getBoundingClientRect();
    assert(panel.left >= 0 && panel.right <= innerWidth, '文件工作区超出视口');
    const focusTarget = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('后端主机'))!;
    focusTarget.focus();
    const targetBounds = focusTarget.getBoundingClientRect();
    assert(document.activeElement === focusTarget && targetBounds.width >= 44 && targetBounds.height >= 44,
      '工具栏缺少可聚焦的 44px 操作目标');
    await checkInboxIsolation(local, cache, notifications[0]!);
    await cleanup();
    result.textContent = 'PASS：按需页面、作者默认/选择/清空实际保存，消息草稿保护、同页/跨项目评论定位、删除源提示与未读状态、账号切换请求隔离与关闭焦点，离线缓存恢复';
    result.dataset.passed = 'true';
  } catch (cause) {
    await cleanup();
    throw cause;
  }
}

run().catch((cause: unknown) => {
  result.textContent = `FAIL: ${cause instanceof Error ? cause.stack : String(cause)}`;
  result.dataset.passed = 'false';
});
