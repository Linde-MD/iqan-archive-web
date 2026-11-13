import { DomainError, requireCondition } from '../domain/model';
import { readProjectSnapshotFile } from '../domain/project-snapshot';
import { checkPermission, type DirectoryHandle, type FileHandle } from './directories';

export const JSON_BACKUP_LOCATION = 'shared' as const;
export const MAX_ARCHIVE_ROOT_ENTRIES = 5_000;

export interface ProjectBackup {
  name: string;
  lastModified: number;
  size: number;
}

export interface ProjectBackupList {
  backups: ProjectBackup[];
  unrecognized: { name: string; reason: string }[];
}

function safeProjectName(projectName: string): string {
  return projectName.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || '项目';
}

export async function listJsonBackups(root: DirectoryHandle): Promise<FileHandle[]> {
  requireCondition(await checkPermission(root), 'ARCHIVE_ROOT_PERMISSION', '归档根目录读取授权已失效，请重新授权。');
  const files: FileHandle[] = [];
  let count = 0;
  for await (const entry of root.values()) {
    if (++count > MAX_ARCHIVE_ROOT_ENTRIES)
      throw new Error('归档根目录条目超过 5000 个，未提交部分列表；请精简根目录后重试。');
    if (entry.kind === 'file' && /\.json$/i.test(entry.name)) files.push(entry);
  }
  return files.sort((first, second) => first.name.localeCompare(second.name));
}

export async function listImportJsonBackups(root: DirectoryHandle, projectName: string): Promise<FileHandle[]> {
  const matchName = projectName.trim() ? safeProjectName(projectName).toLowerCase() : '';
  const entries: { handle: FileHandle; lastModified: number; matches: boolean }[] = [];
  for (const handle of await listJsonBackups(root)) {
    let file: File;
    try {
      file = await handle.getFile();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : '未知错误';
      throw new Error(`读取 JSON 文件“${handle.name}”的修改时间失败：${detail}`);
    }
    entries.push({
      handle,
      lastModified: file.lastModified,
      matches: Boolean(matchName) && handle.name.replace(/\.json$/i, '').toLowerCase().includes(matchName),
    });
  }
  entries.sort((a, b) => Number(b.matches) - Number(a.matches)
    || b.lastModified - a.lastModified
    || (a.handle.name < b.handle.name ? -1 : a.handle.name > b.handle.name ? 1 : 0));
  return entries.map(entry => entry.handle);
}

export async function listProjectBackups(root: DirectoryHandle, projectId: string): Promise<ProjectBackupList> {
  const backups: ProjectBackup[] = [];
  const unrecognized: ProjectBackupList['unrecognized'] = [];
  for (const handle of await listJsonBackups(root)) {
    const file = await handle.getFile();
    try {
      const graph = await readProjectSnapshotFile(file);
      if (graph.project.id === projectId) backups.push({ name: file.name, size: file.size, lastModified: file.lastModified });
    } catch (cause) {
      if (!(cause instanceof DomainError)) throw cause;
      unrecognized.push({ name: file.name, reason: cause.message });
    }
  }
  backups.sort((a, b) => b.lastModified - a.lastModified || b.name.localeCompare(a.name, undefined, { numeric: true }));
  return { backups, unrecognized };
}

export async function deleteProjectBackups(root: DirectoryHandle, projectId: string, selected: readonly ProjectBackup[]): Promise<number> {
  requireCondition(await checkPermission(root, false, 'readwrite'), 'ARCHIVE_ROOT_WRITE_PERMISSION', '归档根目录读写授权已失效，请重新授权。');
  requireCondition(root.removeEntry, 'ARCHIVE_JSON_DELETE_UNSUPPORTED', '当前浏览器不支持删除归档根目录中的 JSON。');
  requireCondition(new Set(selected.map(item => item.name)).size === selected.length, 'ARCHIVE_JSON_SELECTION', '备份选择包含重复文件。');
  let deleted = 0;
  for (const backup of selected) {
    try {
      const file = await (await root.getFileHandle(backup.name)).getFile();
      requireCondition(file.size === backup.size && file.lastModified === backup.lastModified, 'ARCHIVE_JSON_CHANGED', `备份“${backup.name}”已更改，请刷新列表后重试。`);
      const graph = await readProjectSnapshotFile(file);
      requireCondition(graph.project.id === projectId, 'ARCHIVE_JSON_PROJECT', `备份“${backup.name}”不属于当前项目。`);
      await root.removeEntry(backup.name);
      deleted++;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : '未知错误';
      throw new Error(`已删除 ${deleted} 个备份，剩余 ${selected.length - deleted} 个未删除；操作在“${backup.name}”处停止：${detail}`);
    }
  }
  return deleted;
}

export async function writeJsonBackup(
  root: DirectoryHandle,
  projectName: string,
  content: string,
  now = new Date(),
): Promise<string> {
  requireCondition(await checkPermission(root, false, 'readwrite'), 'ARCHIVE_ROOT_WRITE_PERMISSION', '归档根目录读写授权已失效，请重新授权。');
  const safeName = safeProjectName(projectName);
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}${pad(now.getDate())}-T${pad(now.getHours())}`;
  let fileName = '';
  for (let number = 1; !fileName; number++) {
    const candidate = `IQAN-${safeName}-${stamp}-${number}.json`;
    try { await root.getFileHandle(candidate); }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'NotFoundError') { fileName = candidate; break; }
      throw cause;
    }
  }
  const handle = await root.getFileHandle(fileName, { create: true });
  requireCondition(handle.createWritable, 'ARCHIVE_JSON_WRITE_UNSUPPORTED', '当前浏览器不支持向归档根目录写入 JSON。');
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([content], { type: 'application/json;charset=utf-8' }));
    await writable.close();
  } catch (cause) {
    await writable.abort().catch(() => undefined);
    throw cause;
  }
  return fileName;
}