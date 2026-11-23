import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendConnection, backendAddress, checkLocalBackend, parseBackendHosts } from '../src/local-backend';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

const databases: ArchiveDatabase[] = [];
const health = { product: 'iqan-archive-server', apiVersion: 2, databaseVersion: 5, initialized: true };
const response = () => new Response(JSON.stringify(health));
const defaults = ['nb4cn25opxos', 'nb4cn35rxxr8', 'nb4cn25xl5pv', 'nb4cn25omeyo'];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(databases.splice(0).map(db => db.delete()));
});

describe('后端设备发现', () => {
  it('归一设备名并去重，不接受 IP、URL、路径和端口，不限制设备数量', () => {
    expect(parseBackendHosts([' PC-A ', '', 'pc-a', 'host.example.internal'])).toEqual(['pc-a', 'host.example.internal']);
    expect(backendAddress('PC-A')).toBe('http://pc-a');
    expect(parseBackendHosts(Array.from({ length: 300 }, (_, i) => `pc-${i}`))).toHaveLength(300);
    for (const value of ['127.0.0.1', '1234', '0x7f000001', 'http://host', 'host:80', 'host/path', 'a..b', 'bad name', '-host', 'host-']) {
      expect(() => parseBackendHosts([value])).toThrow('设备名');
    }
  });

  it('v14→v15 清除端口并保存设备列表，项目与根授权不变', async () => {
    const name = `backend-settings-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(14).stores({
      projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId',
      branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]',
      directoryBindings: '[projectId+role], projectId', archiveRoots: 'id', backendSettings: 'id',
    });
    const project = { id: 'existing', name: '旧项目', partNumber: '123', revision: 7 };
    const root = { id: 'shared', name: '既有授权引用' };
    await old.table('projects').put(project);
    await old.table('archiveRoots').put(root);
    await old.table('backendSettings').put({ id: 'connection', port: 49999 });
    old.close();
    const db = new ArchiveDatabase(name);
    databases.push(db);
    const repository = new ArchiveRepository(db);
    expect(await repository.getBackendHosts()).toEqual(defaults);
    expect(await db.backendSettings.get('connection')).toEqual({ id: 'connection', hosts: defaults, notes: {}, defaultNotes: {} });
    await repository.setBackendHosts([' PC-A ', 'pc-b', 'pc-a']);
    db.close();
    await db.open();
    expect(await repository.getBackendHosts()).toEqual(['pc-a', 'pc-b']);
    expect(await db.projects.get('existing')).toEqual(project);
    expect(await db.archiveRoots.get('shared')).toEqual(root);
    await expect(repository.setBackendHosts(['bad:80'])).rejects.toThrow();
    expect(await repository.getBackendHosts()).toEqual(['pc-a', 'pc-b']);
    await db.backendSettings.put({ id: 'connection', hosts: ['bad:80'], notes: {}, defaultNotes: {} });
    await expect(repository.getBackendHosts()).rejects.toThrow();
  });

  it('首次配置提供四台默认设备，已保存的空列表或自定义列表不被覆盖', async () => {
    const db = new ArchiveDatabase(`backend-defaults-${crypto.randomUUID()}`);
    databases.push(db);
    const repository = new ArchiveRepository(db);
    expect(await repository.getBackendHosts()).toEqual(defaults);
    await repository.setBackendHosts([]);
    db.close();
    await db.open();
    expect(await repository.getBackendHosts()).toEqual([]);
    await repository.setBackendHosts(['my-device']);
    db.close();
    await db.open();
    expect(await repository.getBackendHosts()).toEqual(['my-device']);
  });

  it.each([{ hosts: [] as string[] }, { hosts: ['nb4cn25opxos', 'my-device'] }])('v15 迁移保留设备列表并初始化空备注：$hosts', async ({ hosts }) => {
    const name = `backend-notes-migration-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(15).stores({
      projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId',
      branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]',
      directoryBindings: '[projectId+role], projectId', archiveRoots: 'id', backendSettings: 'id',
    });
    await old.table('backendSettings').put({ id: 'connection', hosts });
    old.close();
    const db = new ArchiveDatabase(name);
    databases.push(db);
    expect(await new ArchiveRepository(db).getBackendHostSettings()).toEqual({ hosts, notes: {}, defaultNotes: {} });
  });

  it('v16 迁移保留已设置的默认设备备注，删除设备后默认备注仍可恢复', async () => {
    const name = `backend-default-notes-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(16).stores({
      projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId',
      branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]',
      directoryBindings: '[projectId+role], projectId', archiveRoots: 'id', backendSettings: 'id',
    });
    await old.table('backendSettings').put({
      id: 'connection', hosts: [defaults[0], 'custom'], notes: { [defaults[0]!]: '本机备注', custom: '其他设备' },
    });
    old.close();
    const db = new ArchiveDatabase(name);
    databases.push(db);
    const repository = new ArchiveRepository(db);
    const initial = await repository.getBackendHostSettings();
    expect(initial.defaultNotes).toEqual({ [defaults[0]!]: '本机备注' });
    expect(initial.notes).toEqual({ [defaults[0]!]: '本机备注', custom: '其他设备' });
    await repository.setBackendHosts(['custom'], { custom: '其他设备' }, initial.defaultNotes);
    db.close();
    await db.open();
    expect(await repository.getBackendHostSettings()).toEqual({
      hosts: ['custom'], notes: { custom: '其他设备' }, defaultNotes: { [defaults[0]!]: '本机备注' },
    });
  });

  it('备注本机保存、重新打开及清空，设备解析和探测仍只使用设备名', async () => {
    const db = new ArchiveDatabase(`backend-notes-${crypto.randomUUID()}`);
    databases.push(db);
    const repository = new ArchiveRepository(db);
    expect(await repository.getBackendHostSettings()).toEqual({ hosts: defaults, notes: {}, defaultNotes: {} });
    await repository.setBackendHosts([' PC-A ', 'pc-b'], { 'pc-a': ' 办公室电脑 ', 'pc-b': '' });
    db.close();
    await db.open();
    expect(await repository.getBackendHostSettings()).toEqual({ hosts: ['pc-a', 'pc-b'], notes: { 'pc-a': '办公室电脑' }, defaultNotes: {} });
    const fetcher = vi.fn(async (_url: string) => response());
    vi.stubGlobal('fetch', fetcher);
    await expect(repository.testBackendHosts(new AbortController().signal)).rejects.toThrow('多个设备');
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['http://pc-a/health', 'http://pc-b/health']);
    await expect(repository.setBackendHosts(['pc-a'], { 'pc-a': 'x'.repeat(101) })).rejects.toThrow('设备备注');
    await expect(repository.setBackendHosts(['pc-a'], { 'pc-b': '旧设备' })).rejects.toThrow('设备备注');
    await expect(repository.setBackendHosts(['pc-a'], { 'pc-a': '第一行\n第二行' })).rejects.toThrow('设备备注');
    await expect(repository.setBackendHosts(['pc-a'], {}, { 'pc-a': '非默认设备' })).rejects.toThrow('设备备注');
    expect(await repository.getBackendHostSettings()).toEqual({ hosts: ['pc-a', 'pc-b'], notes: { 'pc-a': '办公室电脑' }, defaultNotes: {} });
    await repository.setBackendHosts(['pc-a'], { 'pc-a': '' });
    expect(await repository.getBackendHostSettings()).toEqual({ hosts: ['pc-a'], notes: {}, defaultNotes: {} });
    await repository.setBackendHosts(['__proto__'], Object.fromEntries([['__proto__', '测试']]));
    expect(await repository.getBackendHostSettings()).toEqual({ hosts: ['__proto__'], notes: Object.fromEntries([['__proto__', '测试']]), defaultNotes: {} });
  });

  it('每台只测试一次，全部完成后只选择唯一兼容主机，不广播凭据', async () => {
    const fetcher = vi.fn(async (url: string) => url.includes('pc-a') ? response() : new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const connection = new BackendConnection();
    expect(await connection.test(['pc-a', 'pc-b'], new AbortController().signal)).toMatchObject({ host: 'pc-a' });
    expect(connection.state.host).toBe('pc-a');
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['http://pc-a/health', 'http://pc-b/health']);
    expect(fetcher).toHaveBeenCalledWith('http://pc-a/health', expect.objectContaining({
      credentials: 'omit', cache: 'no-store', redirect: 'error', targetAddressSpace: 'local',
    }));
    for (const changed of [{ product: 'other' }, { apiVersion: 1 }, { databaseVersion: 2 }, { initialized: 'yes' }]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...health, ...changed })));
      await expect(checkLocalBackend('pc-a', new AbortController().signal)).rejects.toThrow('不兼容');
    }
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...health, databaseVersion: 6 })));
    await expect(checkLocalBackend('pc-a', new AbortController().signal)).resolves.toEqual({ initialized: true });
    fetcher.mockResolvedValueOnce(new Response('html'));
    await expect(checkLocalBackend('pc-a', new AbortController().signal)).rejects.toThrow('有效 JSON');
  });

  it('零个或多个可达时清除原选择，并保留每台结果', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response());
    vi.stubGlobal('fetch', fetcher);
    const connection = new BackendConnection();
    await connection.test(['pc-a'], new AbortController().signal);
    await expect(connection.test(['pc-a', 'pc-b'], new AbortController().signal)).rejects.toThrow('多个设备');
    expect(connection.state.host).toBe('');
    expect(connection.state.results.every(result => result.available)).toBe(true);
    fetcher.mockRejectedValue(new TypeError('network'));
    await expect(connection.test(['pc-a', 'pc-b'], new AbortController().signal)).rejects.toThrow('没有可连接');
    expect(connection.state.host).toBe('');
    expect(connection.state.results.every(result => result.error.includes('浏览器本地网络权限'))).toBe(true);
    await expect(connection.test([], new AbortController().signal)).rejects.toThrow('尚未设置');
  });

  it('被取消的旧探测不能覆盖新主机', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('slow')
      ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(response())));
    const connection = new BackendConnection();
    const old = connection.test(['slow'], new AbortController().signal);
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await connection.test(['fast'], new AbortController().signal);
    finish(response());
    await rejected;
    expect(connection.state.host).toBe('fast');
    expect(connection.state.testing).toBe(false);
  });

  it('手动重新连接后忽略迟到的后台检测结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    const connection = new BackendConnection();
    await connection.test(['pc-a'], new AbortController().signal);
    const generation = connection.state.generation;
    await connection.test(['pc-b'], new AbortController().signal);
    connection.applyBackgroundResults([{ host: 'pc-old', available: true, initialized: true, error: '' }], generation);
    expect(connection.state.host).toBe('pc-b');
    expect(connection.state.notice).toBeNull();
    expect(connection.state.results.map(result => result.host)).toEqual(['pc-b']);
  });

  it.each(['headers', 'body'])('健康检测的 3 秒阈值包含 %s 等待，并保留用户取消', async phase => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      });
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          options.signal!.addEventListener('abort', () => controller.error(options.signal!.reason), { once: true });
        },
      })));
    }));
    const controller = new AbortController();
    let settled = false;
    const pending = checkLocalBackend('pc-a', controller.signal);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const timedOut = expect(pending).rejects.toThrow('3 秒');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await timedOut;
    const cancelled = expect(checkLocalBackend('pc-a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('先显示已完成设备结果，全部并行探测在 3 秒结束后才选择唯一主机', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((url: string, options: RequestInit) => url.includes('fast')
      ? Promise.resolve(response())
      : new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      }));
    vi.stubGlobal('fetch', fetcher);
    const connection = new BackendConnection();
    const pending = connection.test(['fast', 'slow-a', 'slow-b'], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(connection.state.results).toEqual([{ host: 'fast', available: true, initialized: true, error: '' }]);
    expect(connection.state.host).toBe('');
    expect(connection.state.testing).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ host: 'fast' });
    expect(connection.state.results).toHaveLength(3);
    expect(connection.state.results.slice(1).every(result => result.error.includes('3 秒'))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
