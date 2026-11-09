import { requireCondition, type ArchiveLocation } from '../domain/model';
import { relativeParts, type FileCandidate } from '../domain/filenames';

export type DirectoryRole = 'engineering' | 'word';
export interface ArchiveRootBinding {
  id: ArchiveLocation;
  handle: DirectoryHandle;
}
export type ArchiveRoots = Partial<Record<ArchiveLocation, DirectoryHandle>>;
export interface DirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  isSameEntry?(other: DirectoryHandle): Promise<boolean>;
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
export interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<FileSystemWritableFileStream>;
}

export function projectDirectoryName(projectName: string, role: DirectoryRole): string {
  const suffix = role === 'engineering' ? '_iqan_project_files' : '_software_changes_docs';
  const name = `${projectName.trim()}${suffix}`;
  requireCondition(Boolean(projectName.trim()) && name.length <= 255 && name.trim() === name && !/[<>:"/\\|?*\u0000-\u001f]/.test(name)
    && !/[. ]$/.test(name) && relativeParts(name).length === 1,
  'PROJECT_DIRECTORY_NAME', '项目名不能用于 Windows 目录名；请修改项目名后重试。');
  return name;
}

export async function resolveProjectDirectory(
  root: DirectoryHandle,
  projectName: string,
  role: DirectoryRole,
): Promise<DirectoryHandle> {
  return root.getDirectoryHandle(projectDirectoryName(projectName, role));
}
export interface DirectoryBinding {
  projectId: string;
  role: DirectoryRole;
  handle: DirectoryHandle;
}

export async function sameDirectory(first: DirectoryHandle, second: DirectoryHandle): Promise<boolean> {
  if (first === second) return true;
  if (first.isSameEntry) return first.isSameEntry(second);
  return second.isSameEntry ? second.isSameEntry(first) : false;
}

export function fileOperationErrorMessage(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === 'NotFoundError') {
    return '找不到所需的文件或目录。文件或目录可能已移动、重命名或删除，或者所在磁盘、网络共享暂时不可用。请确认归档根目录及对应项目子目录存在后重试扫描。';
  }
  return cause instanceof Error ? cause.message : '文件操作失败，请重试。';
}

declare global {
  interface Window {
    showDirectoryPicker?: (options: { mode: 'read' | 'readwrite' }) => Promise<DirectoryHandle>;
  }
}

export async function chooseDirectory(mode: 'read' | 'readwrite' = 'read'): Promise<DirectoryHandle | null> {
  requireCondition(window.isSecureContext && window.showDirectoryPicker, 'DIRECTORY_UNSUPPORTED', '当前浏览器不支持目录授权，请使用安全上下文中的 Chrome 或 Edge。');
  try {
    return await window.showDirectoryPicker({ mode });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return null;
    throw cause;
  }
}

export async function checkPermission(handle: DirectoryHandle, request = false, mode: 'read' | 'readwrite' = 'read'): Promise<boolean> {
  return await (request ? handle.requestPermission({ mode }) : handle.queryPermission({ mode })) === 'granted';
}

export async function scanDirectory(
  root: DirectoryHandle,
  role: DirectoryRole,
  signal: AbortSignal,
  progress: (count: number) => void,
): Promise<FileCandidate[]> {
  requireCondition(await checkPermission(root), 'DIRECTORY_PERMISSION', '归档根目录未授权，请在根目录面板中重新授权。');
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
  requireCondition(await checkPermission(root), 'DIRECTORY_PERMISSION', '归档根目录未授权，请在根目录面板中重新授权。');
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

export async function removeArchiveFile(root: DirectoryHandle, path: string): Promise<void> {
  const parts = relativeParts(path);
  requireCondition(await checkPermission(root, false, 'readwrite'), 'DIRECTORY_PERMISSION', '归档根目录没有读写授权，无法删除文件。');
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  const removeEntry = directory.removeEntry;
  requireCondition(removeEntry, 'DIRECTORY_REMOVE_UNSUPPORTED', '当前浏览器不支持从授权目录中删除文件。');
  const file = await directory.getFileHandle(parts.at(-1)!);
  await file.getFile();
  await removeEntry.call(directory, parts.at(-1)!);
}
