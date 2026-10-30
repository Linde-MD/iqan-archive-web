import { DomainError, normalizeVersion, requireCondition, type FileReference, type ProjectGraph } from './model';
import { validateGraph, validateTransition } from './graph';

export function relativeParts(path: string): string[] {
  requireCondition(path && !/^[\\/]|^[a-z]:|[\u0000:]/i.test(path), 'FILE_PATH', '文件必须使用目录内安全的相对路径。');
  const parts = path.split(/[\\/]/);
  requireCondition(!parts.some(part => !part || part === '.' || part === '..'), 'FILE_PATH', '文件必须使用目录内安全的相对路径。');
  return parts;
}

export interface ParsedEngineering {
  partNumber: string;
  version: string;
  extension: FileReference['extension'];
}

export function parseEngineeringName(fileName: string): ParsedEngineering {
  const match = /^(.*)(\.idax|\.idsx|\.idvx)$/i.exec(fileName.trim());
  requireCondition(match, 'EXTENSION', '不支持的工程扩展名，仅支持 .idax、.idsx、.idvx。');
  const body = match[1]!;
  requireCondition(!/\.(idax|idsx|idvx)[ \t]*$/i.test(body), 'EXTENSION', '不允许重复扩展名。');
  const fields = /^([0-9]+)[ \t]+([Vv][A-Za-z0-9 \t.-]*)$/.exec(body.trim());
  requireCondition(fields && /[A-Za-z0-9]/.test(fields[2]!.slice(1)), 'FILENAME', '文件名须为数字零件号、空白和 V/v 开头的完整版本；版本仅允许字母、数字、空格/Tab、短横线和点。');
  const extension = match[2]!.toLowerCase();
  requireCondition(extension === '.idax' || extension === '.idsx' || extension === '.idvx', 'EXTENSION', '不支持的工程扩展名。');
  return { partNumber: fields[1]!, version: normalizeVersion(fields[2]!), extension };
}

export interface FileCandidate {
  relativePath: string;
  fileName: string;
}

export function candidateDetails(graph: ProjectGraph, candidate: FileCandidate) {
  const parts = relativeParts(candidate.relativePath);
  requireCondition(parts.at(-1) === candidate.fileName, 'FILE_NAME', '文件名与相对路径不一致。');
  const parsed = parseEngineeringName(candidate.fileName);
  requireCondition(parsed.partNumber === graph.project.partNumber, 'PART_NUMBER', `零件号不匹配：${parsed.partNumber}，当前项目为 ${graph.project.partNumber}。`);
  const node = graph.nodes.find(item => normalizeVersion(item.version) === parsed.version);
  return { parsed, node };
}

export function candidateState(graph: ProjectGraph, candidate: FileCandidate): string | null {
  try {
    const { node } = candidateDetails(graph, candidate);
    if (graph.files.some(file => relativeParts(file.relativePath).join('/') === relativeParts(candidate.relativePath).join('/'))) return '已登记相同路径，跳过；不覆盖原引用。';
    if (node?.releasedAt) return '已放行版本的文件引用已锁定。';
    return null;
  } catch (cause) {
    if (cause instanceof DomainError) return cause.message;
    throw cause;
  }
}

export function registerCandidates(graph: ProjectGraph, candidates: readonly FileCandidate[]): ProjectGraph {
  requireCondition(candidates.length > 0, 'SELECTION', '请至少选择一个有效文件。');
  const next = structuredClone(graph);
  for (const candidate of candidates) {
    const state = candidateState(next, candidate);
    requireCondition(state === null, 'CANDIDATE', state ?? '候选文件无效。');
    let { parsed, node } = candidateDetails(next, candidate);
    if (!node) {
      node = { id: crypto.randomUUID(), projectId: next.project.id, version: parsed.version, description: '', taskId: null, releasedAt: null };
      next.nodes.push(node);
    }
    next.files.push({
      id: crypto.randomUUID(), projectId: next.project.id, nodeId: node.id,
      fileName: candidate.fileName, relativePath: candidate.relativePath, extension: parsed.extension,
      candidateDate: null, parsingStatus: 'parsed',
    });
  }
  validateTransition(graph, next);
  return next;
}

export function rebindReference(graph: ProjectGraph, fileId: string, candidate: FileCandidate): ProjectGraph {
  validateGraph(graph);
  const next = structuredClone(graph);
  const file = next.files.find(item => item.id === fileId);
  requireCondition(file, 'FILE_REFERENCE', '文件引用不存在。');
  const { parsed, node } = candidateDetails(graph, candidate);
  requireCondition(node?.id === file.nodeId, 'VERSION_MISMATCH', '只能重绑到同项目、同完整版本的文件。');
  requireCondition(!next.files.some(item => item.id !== fileId && relativeParts(item.relativePath).join('/') === relativeParts(candidate.relativePath).join('/')), 'DUPLICATE_PATH', '目标相对路径已经登记。');
  Object.assign(file, { relativePath: candidate.relativePath, fileName: candidate.fileName, extension: parsed.extension, candidateDate: null, parsingStatus: 'parsed' });
  validateTransition(graph, next);
  return next;
}
