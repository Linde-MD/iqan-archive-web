export const DEFAULT_BACKEND_PORT = 47831;

export function parseBackendPort(value: unknown): number {
  const raw = typeof value === 'string' ? value.trim() : value;
  const port = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('端口必须为 1024–65535 的整数。');
  }
  return port;
}

export function backendAddress(port: number): string {
  return `http://127.0.0.1:${parseBackendPort(port)}`;
}

export async function checkLocalBackend(port: number, signal: AbortSignal): Promise<{ initialized: boolean }> {
  const address = backendAddress(port);
  const timeout = AbortSignal.timeout(65_000);
  let response: Response;
  try {
    response = await fetch(`${address}/health`, {
      signal: AbortSignal.any([signal, timeout]), cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new Error(timeout.aborted
      ? '连接检测超时。请检查本机服务窗口和共享数据库是否可访问。'
      : '无法连接本机后端。请确认服务已启动、端口一致、allowedOrigins 包含当前网页来源，并检查浏览器本地网络权限。');
  }
  if (!response.ok) throw new Error(`本机后端返回 HTTP ${response.status}，请检查服务窗口和数据库连接。`);
  const value: unknown = await response.json().catch(() => {
    throw new Error('健康检查未返回有效 JSON；此端口可能不是 IQAN Archive 后端。');
  });
  if (!value || typeof value !== 'object' || !('product' in value) || value.product !== 'iqan-archive-server'
    || !('apiVersion' in value) || value.apiVersion !== 1
    || !('databaseVersion' in value) || value.databaseVersion !== 1
    || !('initialized' in value) || typeof value.initialized !== 'boolean') {
    throw new Error('服务标识或 API/数据库版本不兼容，请使用匹配的 IQAN Archive 后端。');
  }
  return { initialized: value.initialized };
}
