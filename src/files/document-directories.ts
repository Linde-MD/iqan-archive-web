import type { ArchiveLocation } from '../domain/model';
import type { FileCandidate } from '../domain/filenames';
import type { ArchiveRepository } from '../storage/database';
import { checkPermission, fileOperationErrorMessage, resolveProjectDirectory, sameDirectory, scanDirectory, type DirectoryHandle } from './directories';

export interface DocumentDirectoryScan {
  location: ArchiveLocation;
  root: DirectoryHandle;
  binding?: DirectoryHandle;
  projectName: string;
  files: FileCandidate[];
  missingDirectory: boolean;
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