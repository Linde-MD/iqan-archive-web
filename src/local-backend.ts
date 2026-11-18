import { reactive } from 'vue';

export const DEFAULT_BACKEND_HOSTS = ['nb4cn25opxos', 'nb4cn35rxxr8', 'nb4cn25xl5pv', 'nb4cn25omeyo'] as const;
export const BACKEND_PROBE_TIMEOUT_MS = 3_000;
export const BACKEND_RECHECK_INTERVAL_MS = 60_000;

export function parseBackendHosts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('设备名必须为列表。');
  const hosts = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('每个设备名必须为文本。');
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (host.length > 253 || !host.split('.').every(label =>
      /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(label))
      || /^[\d.]+$/.test(host) || !URL.canParse(`http://${host}`)
      || new URL(`http://${host}`).hostname !== host) {
      throw new Error(`设备名“${entry}”无效。请只填写设备名或 DNS 主机名，不含 IP、协议、端口或路径。`);
    }
    hosts.add(host);
  }
  return [...hosts];
}

export function backendAddress(host: string): string {
  const parsed = parseBackendHosts([host]);
  if (parsed.length !== 1) throw new Error('请先设置后端设备名。');
  return `http://${parsed[0]}`;
}

export function backendRequestOptions(options: RequestInit): RequestInit & { targetAddressSpace: 'local' } {
  return { ...options, credentials: 'omit', cache: 'no-store', redirect: 'error', targetAddressSpace: 'local' };
}

export interface BackendProbe {
  host: string;
  available: boolean;
  initialized: boolean;
  error: string;
}

export async function checkLocalBackend(host: string, signal: AbortSignal): Promise<{ initialized: boolean }> {
  const address = backendAddress(host);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('健康检测超时', 'TimeoutError')), BACKEND_PROBE_TIMEOUT_MS);
  const timeoutMessage = '连接超时（3 秒），请确认设备上的后端已运行，再重新测试。';
  try {
    let response: Response;
    try {
      response = await fetch(`${address}/health`, backendRequestOptions({
        signal: AbortSignal.any([signal, timeout.signal]),
      }));
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new Error(timeout.signal.aborted
        ? timeoutMessage
        : '无法连接，请检查设备名解析、服务的 80 端口、入站规则、allowedOrigins 和浏览器本地网络权限。');
    }
    if (!response.ok) throw new Error(`后端返回 HTTP ${response.status}，请检查服务窗口和数据库连接。`);
    const value: unknown = await response.json().catch(() => {
      signal.throwIfAborted();
      if (timeout.signal.aborted) throw new Error(timeoutMessage);
      throw new Error('健康检查未返回有效 JSON；此设备的 80 端口可能不是 IQAN Archive 后端。');
    });
    if (!value || typeof value !== 'object' || !('product' in value) || value.product !== 'iqan-archive-server'
      || !('apiVersion' in value) || value.apiVersion !== 2
      || !('databaseVersion' in value) || value.databaseVersion !== 5
      || !('initialized' in value) || typeof value.initialized !== 'boolean') {
      throw new Error('服务标识或 API/数据库版本不兼容，请使用匹配的 IQAN Archive 后端。');
    }
    return { initialized: value.initialized };
  } finally { clearTimeout(timer); }
}

export class BackendConnection {
  readonly state = reactive({
    host: '', generation: 0, testing: false, lastTestedAt: 0, results: [] as BackendProbe[],
    notice: null as { title: string; message: string } | null,
  });
  private active: AbortController | undefined;

  reset() {
    this.active?.abort();
    this.active = undefined;
    this.state.host = '';
    this.state.results = [];
    this.state.testing = false;
    this.state.lastTestedAt = 0;
    this.state.notice = null;
    this.state.generation++;
  }

  async test(hosts: string[], signal: AbortSignal): Promise<BackendProbe> {
    this.reset();
    const controller = new AbortController();
    this.active = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    this.state.testing = true;
    try {
      const results = await probeBackendHosts(hosts, combined, result => this.state.results.push(result));
      combined.throwIfAborted();
      this.state.lastTestedAt = Date.now();
      this.state.results = results;
      const available = results.filter(result => result.available);
      if (available.length !== 1) {
        throw new Error(available.length === 0
          ? '没有可连接的兼容后端。当前主机地址已清除，请检查各设备的检测结果后重试。'
          : `有多个设备可连接（${available.map(result => result.host).join('、')}）。当前主机地址已清除，请停止多余后端，确保仅一台运行后重新测试。`);
      }
      const selected = available[0]!;
      this.state.host = selected.host;
      return selected;
    } finally {
      if (this.active === controller) {
        this.active = undefined;
        this.state.testing = false;
      }
    }
  }

  applyBackgroundResults(results: BackendProbe[], generation: number, error = '') {
    if (this.state.generation !== generation) return;
    this.state.results = results;
    const available = results.filter(result => result.available);
    const previous = this.state.host;
    const next = !error && available.length === 1 ? available[0]!.host : '';
    if (next && next === previous) return;
    this.state.host = next;
    this.state.generation++;
    this.state.notice = next
      ? { title: '检测到主机已切换', message: `后端地址已从 ${previous} 切换为 ${next}。本次操作未自动重发，请重新连接或登录验证后再继续共享写入。` }
      : { title: '后端连接异常', message: error || (available.length === 0
        ? '后台检测没有可连接的兼容后端，已清除主机选择并暂停后续联网写入。请检查设备后重新测试连接。'
        : `后台检测发现多台可连接主机（${available.map(result => result.host).join('、')}），已清除主机选择并暂停后续联网写入。请停止多余后端后重新测试。`) };
  }
}

export async function probeBackendHosts(
  hosts: string[], signal: AbortSignal, completed?: (result: BackendProbe) => void,
): Promise<BackendProbe[]> {
  const names = parseBackendHosts(hosts);
  if (!names.length) throw new Error('尚未设置后端设备名。请先保存至少一个设备名，再测试连接。');
  return Promise.all(names.map(async host => {
    let result: BackendProbe;
    try {
      const health = await checkLocalBackend(host, signal);
      result = { host, available: true, initialized: health.initialized, error: '' };
    } catch (cause) {
      if (signal.aborted) throw cause;
      result = { host, available: false, initialized: false, error: cause instanceof Error ? cause.message : '检测失败，请重试。' };
    }
    signal.throwIfAborted();
    completed?.(result);
    return result;
  }));
}
