import type { FileCandidate } from '../domain/filenames';
import type { ArchiveLocation, ProjectGraph } from '../domain/model';
import { checkPermission, locateFile, removeArchiveFile, sameDirectory, type DirectoryHandle, type FileHandle } from './directories';

export interface EngineeringFileScan {
  files: Record<ArchiveLocation, FileCandidate[]>;
  roots: Map<ArchiveLocation, DirectoryHandle>;
  directories: Map<ArchiveLocation, DirectoryHandle>;
}

export async function deleteEngineeringFile(options: {
  graph: ProjectGraph;
  nodeId: string;
  location: ArchiveLocation;
  selectedFile: FileCandidate;
  getGraph: () => Promise<ProjectGraph>;
  scan: (graph: ProjectGraph, nodeId: string) => Promise<EngineeringFileScan>;
  confirm: (message: string) => boolean;
}): Promise<boolean> {
  const { graph, nodeId, location, selectedFile, getGraph, scan, confirm } = options;
  const node = graph.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error('版本已不存在，请重新读取版本图。');
  const other: ArchiveLocation = location === 'local' ? 'shared' : 'local';
  const label = location === 'local' ? '本地' : '共享';
  const otherLabel = other === 'local' ? '本地' : '共享';
  const initial = await scan(graph, nodeId);

  async function checkScan(result: EngineeringFileScan) {
    const root = result.roots.get(location);
    const otherRoot = result.roots.get(other);
    const directory = result.directories.get(location);
    if (!root || !otherRoot || !directory)
      throw new Error(`${label}工程目录或归档根目录不可用，请重新扫描。`);
    if (await sameDirectory(root, otherRoot))
      throw new Error('共享与本地归档根目录指向同一位置，无法单独删除副本。');
    if (!result.files[location].some(file => file.relativePath === selectedFile.relativePath))
      throw new Error(`所选${label}工程文件已变化，请重新打开文件状态菜单。`);
    return { root, otherRoot, directory };
  }

  const original = await checkScan(initial);
  const originalHandle = await locateFile(original.directory, selectedFile.relativePath);
  const originalFile = await originalHandle.getFile();
  const otherWarning = initial.files[other].length
    ? `${otherLabel}目录仍有此版本工程文件。`
    : `${otherLabel}目录当前没有此版本工程文件。`;
  const sharedWarning = location === 'shared' ? '\n共享文件删除后可能影响其他用户，且无法撤销。' : '';
  if (!confirm(`确定删除${label}工程文件？\n${selectedFile.relativePath}\n${otherWarning}${sharedWarning}`)) return false;

  async function rescan() {
    const latestGraph = await getGraph();
    const latestNode = latestGraph.nodes.find(item => item.id === nodeId);
    if (latestGraph.project.revision !== graph.project.revision || latestGraph.project.name !== graph.project.name
      || latestNode?.version !== node?.version)
      throw new Error('版本图已变化，请重新读取后再删除文件。');
    const result = await scan(latestGraph, nodeId);
    const current = await checkScan(result);
    if (!await sameDirectory(original.root, current.root) || !await sameDirectory(original.otherRoot, current.otherRoot)
      || !await sameDirectory(original.directory, current.directory))
      throw new Error('归档根目录或工程目录已变化，请重新打开文件状态菜单。');
    return { result, current };
  }

  function confirmMissingOther() {
    return confirm(`${otherLabel}目录没有该版本工程文件：\n${selectedFile.relativePath}\n删除后${otherLabel}目录仍没有该版本副本，仍要继续吗？`);
  }

  let { result, current } = await rescan();
  let confirmedMissingOther = false;
  if (!result.files[other].length) {
    if (!confirmMissingOther()) return false;
    confirmedMissingOther = true;
  }
  ({ result, current } = await rescan());
  if (!result.files[other].length && !confirmedMissingOther) {
    if (!confirmMissingOther()) return false;
    ({ result, current } = await rescan());
  }

  if (!await checkPermission(current.root, false, 'readwrite'))
    throw new Error(`${label}根目录没有读写授权，请重新授权后再试。`);
  const currentHandle = await locateFile(current.directory, selectedFile.relativePath);
  const currentFile = await currentHandle.getFile();
  const sameEntry = async (first: FileHandle, second: FileHandle) =>
    first.isSameEntry ? first.isSameEntry(second) : second.isSameEntry ? second.isSameEntry(first) : true;
  if (!await sameEntry(originalHandle, currentHandle)
    || currentFile.size !== originalFile.size || currentFile.lastModified !== originalFile.lastModified)
    throw new Error(`确认期间${label}工程文件已变化，未删除。`);
  await removeArchiveFile(current.directory, selectedFile.relativePath);
  return true;
}
