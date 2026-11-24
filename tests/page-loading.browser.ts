import Dexie from 'dexie';
import { createApp, nextTick } from 'vue';
import App from '../src/App.vue';
import { router } from '../src/router';
import { projectPath } from '../src/workspace-routes';
import { ArchiveDatabase } from '../src/storage/database';
import { CollaborationDatabase } from '../src/storage/collaboration';
import { createProject, type ProjectGraph, type Task } from '../src/domain/model';
import { summarizeProject, summarizeTask, summarizeVersion, type ProjectPageView } from '../src/domain/project-views';
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
  for (let attempt = 0; attempt < 160; attempt++) {
    await nextTick();
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待页面状态超时');
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
    else if (path === '/inbox/summary') body = { revision: 0, unreadCount: 0 };
    else if (path === '/assignees' || path === '/comment-directory') body = { users: [user] };
    else {
      const metadata = /^\/projects\/([^/]+)$/.exec(path);
      if (metadata) {
        const graph = graphs.get(decodeURIComponent(metadata[1]!));
        assert(graph, '读取了未知项目摘要');
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
      else if (child === 'graph') body = { schemaVersion: 8, graph };
      else if (child.startsWith('tasks/')) {
        const target = graph.tasks.find(item => item.id === child.slice(6));
        assert(target, '请求了未知任务');
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
    await cleanup();
    result.textContent = 'PASS：真实 App 启动无全量图/槽位注册，当前页独立挂载，任务单项详情，评论目录延迟，离线缺页和已缓存页恢复';
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
