import { requireCondition } from '../domain/model';
import { checkPermission, type DirectoryHandle, type FileHandle } from './directories';

export const JSON_BACKUP_LOCATION = 'shared' as const;
export const MAX_ARCHIVE_ROOT_ENTRIES = 5_000;

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

export async function writeJsonBackup(
  root: DirectoryHandle,
  projectName: string,
  content: string,
  now = new Date(),
): Promise<string> {
  requireCondition(await checkPermission(root, false, 'readwrite'), 'ARCHIVE_ROOT_WRITE_PERMISSION', '归档根目录读写授权已失效，请重新授权。');
  const safeName = projectName.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || '项目';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-T${pad(now.getHours())}-${pad(now.getMinutes())}`;
  let fileName = '';
  for (let suffix = 0; !fileName; suffix++) {
    const candidate = `IQAN-${safeName}-${stamp}${suffix ? `-${suffix}` : ''}.json`;
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