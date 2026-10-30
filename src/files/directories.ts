import { requireCondition } from '../domain/model';
import { relativeParts, type FileCandidate } from '../domain/filenames';

export type DirectoryRole = 'engineering' | 'word';
export interface DirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<FileHandle>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}
export interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
}
export interface DirectoryBinding {
  projectId: string;
  role: DirectoryRole;
  handle: DirectoryHandle;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options: { mode: 'read' }) => Promise<DirectoryHandle>;
  }
}

export async function chooseDirectory(): Promise<DirectoryHandle | null> {
  requireCondition(window.isSecureContext && window.showDirectoryPicker, 'DIRECTORY_UNSUPPORTED', '当前浏览器不支持目录授权，请使用安全上下文中的 Chrome 或 Edge。');
  try {
    return await window.showDirectoryPicker({ mode: 'read' });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return null;
    throw cause;
  }
}

export async function checkPermission(handle: DirectoryHandle, request = false): Promise<boolean> {
  return await (request ? handle.requestPermission({ mode: 'read' }) : handle.queryPermission({ mode: 'read' })) === 'granted';
}

export async function scanDirectory(
  root: DirectoryHandle,
  role: DirectoryRole,
  signal: AbortSignal,
  progress: (count: number) => void,
): Promise<FileCandidate[]> {
  requireCondition(await checkPermission(root), 'DIRECTORY_PERMISSION', '目录未授权，请点击重新授权。');
  const result: FileCandidate[] = [];
  const stack = [{ iterator: root.values()[Symbol.asyncIterator](), path: '' }];
  let count = 0;
  try {
    while (stack.length) {
      signal.throwIfAborted();
      const current = stack.at(-1)!;
      const entry = await current.iterator.next();
      signal.throwIfAborted();
      if (entry.done) { stack.pop(); continue; }
      count++;
      requireCondition(count <= 5000, 'SCAN_LIMIT', '超过 5000 个条目，扫描已中止且未提交；请选择更小的目录。');
      progress(count);
      const handle = entry.value;
      requireCondition(relativeParts(handle.name).length === 1, 'ENTRY_NAME', '目录条目名称无效。');
      const path = current.path ? `${current.path}/${handle.name}` : handle.name;
      if (handle.kind === 'directory') {
        stack.push({ iterator: handle.values()[Symbol.asyncIterator](), path });
      } else if (role === 'engineering' ? /\.(idax|idsx|idvx)$/i.test(handle.name.trim()) : /\.(doc|docx)$/i.test(handle.name)) {
        result.push({ relativePath: path, fileName: handle.name });
      }
      if (count % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  } finally {
    for (const item of stack.reverse()) await item.iterator.return?.();
  }
}

export async function locateFile(root: DirectoryHandle, path: string): Promise<FileHandle> {
  const parts = relativeParts(path);
  requireCondition(await checkPermission(root), 'DIRECTORY_PERMISSION', '目录未授权，请点击重新授权。');
  try {
    let directory = root;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    const handle = await directory.getFileHandle(parts.at(-1)!);
    await handle.getFile();
    return handle;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') {
      throw new Error(`文件缺失或目录已移动：${path}。请重新扫描工程目录。`, { cause });
    }
    if (cause instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(cause.name)) {
      throw new Error(`文件读取权限被拒绝：${path}。请重新授权目录。`, { cause });
    }
    throw cause;
  }
}
