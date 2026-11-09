export type ArchiveLocation = 'shared' | 'local';

export interface Project {
  id: string;
  name: string;
  partNumber: string;
  engineeringDirectoryHint: string;
  wordDirectoryHint: string;
  revision: number;
}

export interface VersionNode {
  id: string;
  projectId: string;
  version: string;
  description: string;
  taskId: string | null;
  releasedAt: string | null;
}

export interface Edge {
  id: string;
  projectId: string;
  parentId: string;
  childId: string;
}

export interface Branch {
  id: string;
  projectId: string;
  name: string;
  description: string;
  color: string;
  headId: string;
  order?: number;
}

export function orderedBranches(branches: readonly Branch[]): Branch[] {
  return branches
    .map((branch, index) => ({ branch, index }))
    .sort((a, b) => (a.branch.order ?? a.index) - (b.branch.order ?? b.index) || a.index - b.index)
    .map(({ branch }) => branch);
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  description: string;
  externalTaskId: string | null;
}

export interface ProjectGraph {
  project: Project;
  nodes: VersionNode[];
  edges: Edge[];
  branches: Branch[];
  tasks: Task[];
}

export interface ProjectSnapshot {
  schemaVersion: 3;
  graph: Omit<ProjectGraph, 'project' | 'branches'> & {
    project: Pick<Project, 'id' | 'name' | 'partNumber' | 'revision'>;
    branches: Array<Omit<Branch, 'order'>>;
  };
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}

export function normalizeExternalTaskId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  requireCondition(
    normalized === '' || /^[0-9]+$/.test(normalized),
    'TASK_ID_FORMAT',
    'Task ID 只能填写数字。',
  );
  requireCondition(
    normalized.length <= 16,
    'TASK_ID_LENGTH',
    'Task ID 最多 16 位数字。',
  );
  return normalized || null;
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/[ \t]+/g, ' ');
}

export function createProject(name: string, partNumber: string): ProjectGraph {
  requireCondition(name.trim() && partNumber.trim(), 'REQUIRED', '项目名称和零件号不能为空。');
  return {
    project: {
      id: crypto.randomUUID(),
      name: name.trim(),
      partNumber: partNumber.trim(),
      engineeringDirectoryHint: '',
      wordDirectoryHint: '',
      revision: 0,
    },
    nodes: [], edges: [], branches: [], tasks: [],
  };
}
