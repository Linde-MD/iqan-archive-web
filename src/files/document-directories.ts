import type { ArchiveLocation } from '../domain/model';
import type { FileCandidate } from '../domain/filenames';
import type { ArchiveRepository } from '../storage/database';
import { checkPermission, fileOperationErrorMessage, removeArchiveFile, resolveProjectDirectory, sameDirectory, scanDirectory, type DirectoryHandle } from './directories';

export interface DocumentDirectoryScan {
  location: ArchiveLocation;
  root: DirectoryHandle;
  binding?: DirectoryHandle;
  projectName: string;
  files: FileCandidate[];
  missingDirectory: boolean;
}

export interface AvailableDocumentDirectoryScan extends DocumentDirectoryScan {
  binding: DirectoryHandle;
}

export async function scanDocumentDirectory(
  repository: ArchiveRepository,
  projectId: string,
  location: ArchiveLocation,
  signal: AbortSignal,
  progress: (count: number) => void = () => undefined,
): Promise<DocumentDirectoryScan> {
  const root = await repository.getArchiveRoot(location);
  const locationName = location === 'local' ? '本地' : '共享';
  if (!root) throw new Error(`${locationName}根目录未设置。`);
  if (!await checkPermission(root)) throw new Error(`${locationName}根目录未授权，请重新授权。`);

  const graphAtScan = await repository.get(projectId);
  let binding: DirectoryHandle;
  try {
    binding = await resolveProjectDirectory(root, graphAtScan.project.name, 'word');
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') {
      const [latestRoot, latestGraph] = await Promise.all([
        repository.getArchiveRoot(location),
        repository.get(projectId),
      ]);
      if (!latestRoot || !(await sameDirectory(root, latestRoot)) || latestGraph.project.name !== graphAtScan.project.name)
        throw new Error(`${locationName}文档目录在扫描期间发生变化，请重新扫描。`, { cause });
      return { location, root, projectName: graphAtScan.project.name, files: [], missingDirectory: true };
    }
    throw cause;
  }
  if (!await checkPermission(binding)) throw new Error(`${locationName}文档目录未授权，请重新授权。`);

  const files = await scanDirectory(binding, 'word', signal, progress);
  const [latestRoot, latestGraph] = await Promise.all([
    repository.getArchiveRoot(location),
    repository.get(projectId),
  ]);
  if (!latestRoot || !(await sameDirectory(root, latestRoot))
    || latestGraph.project.name !== graphAtScan.project.name
    || !(await sameDirectory(binding, await resolveProjectDirectory(latestRoot, latestGraph.project.name, 'word'))))
    throw new Error(`${locationName}文档目录在扫描期间发生变化，请重新扫描。`);

  return { location, root, binding, projectName: graphAtScan.project.name, files, missingDirectory: false };
}

export type DocumentLocationScanResult =
  | { location: ArchiveLocation; status: 'success'; scan: DocumentDirectoryScan; count: number }
  | { location: ArchiveLocation; status: 'missing'; scan: DocumentDirectoryScan; count: 0 }
  | { location: ArchiveLocation; status: 'error'; message: string; count: number };

export async function scanDocumentDirectories(
  repository: ArchiveRepository,
  projectId: string,
  signal: AbortSignal,
  progress: (location: ArchiveLocation, count: number) => void = () => undefined,
): Promise<DocumentLocationScanResult[]> {
  return Promise.all((['shared', 'local'] as const).map(async location => {
    let count = 0;
    try {
      const scan = await scanDocumentDirectory(repository, projectId, location, signal, value => {
        count = value;
        progress(location, value);
      });
      if (scan.missingDirectory) return { location, status: 'missing', scan, count: 0 } as const;
      return { location, status: 'success', scan, count } as const;
    } catch (cause) {
      if (signal.aborted) throw cause;
      return { location, status: 'error', message: fileOperationErrorMessage(cause), count } as const;
    }
  }));
}

export interface LocalDocumentDeletionScan {
  shared: AvailableDocumentDirectoryScan;
  local: AvailableDocumentDirectoryScan;
}

export async function scanDocumentLocalDeletion(
  repository: ArchiveRepository,
  projectId: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<LocalDocumentDeletionScan> {
  const results = await scanDocumentDirectories(repository, projectId, signal);
  const sharedResult = results.find(result => result.location === 'shared')!;
  const localResult = results.find(result => result.location === 'local')!;
  if (sharedResult.status === 'error') throw new Error(`共享文档扫描失败：${sharedResult.message}`);
  if (localResult.status === 'error') throw new Error(`本地文档扫描失败：${localResult.message}`);
  if (sharedResult.status === 'missing' || !sharedResult.scan.binding)
    throw new Error('共享文档目录不存在，无法确认保留副本。');
  if (localResult.status === 'missing' || !localResult.scan.binding)
    throw new Error('本地文档目录不存在，无法删除本地副本。');
  if (await sameDirectory(sharedResult.scan.root, localResult.scan.root))
    throw new Error('共享和本地根目录指向同一位置，无法单独删除本地副本。');
  if (!sharedResult.scan.files.some(file => file.relativePath === relativePath)
    || !localResult.scan.files.some(file => file.relativePath === relativePath))
    throw new Error('所选文档不再同时存在于共享和本地目录，请重新扫描。');
  if (!await checkPermission(localResult.scan.root, false, 'readwrite'))
    throw new Error('本地根目录没有读写授权，请重新授权后再删除。');
  return {
    shared: sharedResult.scan as AvailableDocumentDirectoryScan,
    local: localResult.scan as AvailableDocumentDirectoryScan,
  };
}

export async function deleteLocalDocumentCopy(scan: LocalDocumentDeletionScan, relativePath: string): Promise<void> {
  const latestSharedRoot = scan.shared.root;
  const latestLocalRoot = scan.local.root;
  if (await sameDirectory(latestSharedRoot, latestLocalRoot))
    throw new Error('共享和本地根目录指向同一位置，无法单独删除本地副本。');
  if (!scan.shared.files.some(file => file.relativePath === relativePath)
    || !scan.local.files.some(file => file.relativePath === relativePath))
    throw new Error('所选文档不再同时存在于共享和本地目录，请重新扫描。');
  if (!await checkPermission(latestLocalRoot, false, 'readwrite'))
    throw new Error('本地根目录没有读写授权，请重新授权后再删除。');
  await removeArchiveFile(scan.local.binding!, relativePath);
}