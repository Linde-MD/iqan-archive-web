import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendAddress, checkLocalBackend, parseBackendPort } from '../src/local-backend';
import { ArchiveDatabase, ArchiveRepository } from '../src/storage/database';

const databases: ArchiveDatabase[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(databases.splice(0).map(db => db.delete()));
});

describe('本机后端连接设置', () => {
  it('端口接受整数边界，拒绝自由地址、小数、空值和越界值', () => {
    expect(parseBackendPort(' 1024 ')).toBe(1024);
    expect(backendAddress(65535)).toBe('http://127.0.0.1:65535');
    for (const value of ['', ' ', 'http://example.com', '1e4', '47831.0', '47831abc', 1023, 65536, 47831.5, null]) {
      expect(() => parseBackendPort(value)).toThrow('整数');
    }
  });

  it('v12 升级只增加设备设置表，端口刷新保留且不影响项目和根目录', async () => {
    const name = `backend-settings-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(12).stores({
      projects: 'id', nodes: 'id, projectId, &[projectId+version]', edges: 'id, projectId',
      branches: 'id, projectId', tasks: 'id, projectId, &[projectId+externalTaskId]',
      directoryBindings: '[projectId+role], projectId', archiveRoots: 'id',
    });
    const project = { id: 'existing', name: '旧项目', partNumber: '123', revision: 7 };
    const root = { id: 'shared', name: '既有授权引用' };
    await old.table('projects').put(project);
    await old.table('archiveRoots').put(root);
    old.close();
    const db = new ArchiveDatabase(name);
    databases.push(db);
    const repository = new ArchiveRepository(db);
    expect(await repository.getBackendPort()).toBe(47831);
    await repository.setBackendPort(49999);
    db.close();
    await db.open();
    expect(await repository.getBackendPort()).toBe(49999);
    expect(await db.projects.get('existing')).toEqual(project);
    expect(await db.archiveRoots.get('shared')).toEqual(root);
    await expect(repository.setBackendPort(1)).rejects.toThrow();
    expect(await repository.getBackendPort()).toBe(49999);
    await db.backendSettings.put({ id: 'connection', port: -1 });
    await expect(repository.getBackendPort()).rejects.toThrow();
  });

  it('健康检测只访问固定回环地址，严格验证产品和协议，不携带凭据', async () => {
    const health = { product: 'iqan-archive-server', apiVersion: 2, databaseVersion: 4, initialized: false };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(health)));
    vi.stubGlobal('fetch', fetcher);
    const signal = new AbortController().signal;
    expect(await checkLocalBackend(47831, signal)).toEqual({ initialized: false });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:47831/health', expect.objectContaining({
      credentials: 'omit', cache: 'no-store', redirect: 'error',
    }));
    for (const changed of [{ product: 'other' }, { apiVersion: 1 }, { databaseVersion: 2 }, { initialized: 'yes' }]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...health, ...changed })));
      await expect(checkLocalBackend(47831, signal)).rejects.toThrow('不兼容');
    }
    fetcher.mockResolvedValueOnce(new Response('html'));
    await expect(checkLocalBackend(47831, signal)).rejects.toThrow('有效 JSON');
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(checkLocalBackend(47831, signal)).rejects.toThrow('HTTP 503');
    fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(checkLocalBackend(47831, signal)).rejects.toThrow('浏览器本地网络权限');
  });

  it('检测受超时和用户取消信号控制', async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout uses the runtime clock; provide a timer controlled by this test.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })));
    const controller = new AbortController();
    const timedOut = expect(checkLocalBackend(47831, controller.signal)).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(65_000);
    await timedOut;
    const cancelled = expect(checkLocalBackend(47831, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    vi.restoreAllMocks();
  });
});
