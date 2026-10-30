import { DomainError, normalizeVersion, requireCondition, type ProjectGraph } from './model';
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
  extension: '.idax' | '.idsx' | '.idvx';
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

export function registerCandidates(graph: ProjectGraph, candidates: readonly FileCandidate[]): ProjectGraph {
  requireCondition(candidates.length > 0, 'SELECTION', '请至少选择一个有效文件。');
  const next = structuredClone(graph);
  for (const candidate of candidates) {
    const { parsed, node } = candidateDetails(next, candidate);
    if (!node) {
      next.nodes.push({ id: crypto.randomUUID(), projectId: next.project.id, version: parsed.version, description: '', taskId: null, releasedAt: null });
    }
  }
  requireCondition(next.nodes.length > graph.nodes.length, 'SELECTION', '所选文件均已有对应版本，无需登记。');
  validateTransition(graph, next);
  return next;
}

export function matchScannedFiles(graph: ProjectGraph, candidates: readonly FileCandidate[]) {
  validateGraph(graph);
  const matches = new Map(graph.nodes.map(node => [node.id, [] as FileCandidate[]]));
  const rows = candidates.map(candidate => {
    try {
      const { parsed, node } = candidateDetails(graph, candidate);
      if (node) matches.get(node.id)!.push(candidate);
      return { ...candidate, version: parsed.version, nodeId: node?.id ?? null, reason: null };
    } catch (cause) {
      if (!(cause instanceof DomainError)) throw cause;
      return { ...candidate, version: null, nodeId: null, reason: cause.message };
    }
  });
  return { rows, matches, missing: graph.nodes.filter(node => matches.get(node.id)!.length === 0) };
}
