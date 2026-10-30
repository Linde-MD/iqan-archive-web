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
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  description: string;
  loopId: string | null;
}

export interface ProjectGraph {
  project: Project;
  nodes: VersionNode[];
  edges: Edge[];
  branches: Branch[];
  tasks: Task[];
}

export interface ProjectSnapshot {
  schemaVersion: 2;
  graph: Omit<ProjectGraph, 'project'> & {
    project: Pick<Project, 'id' | 'name' | 'partNumber' | 'revision'>;
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

export function normalizeLoopId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  requireCondition(
    Array.from(normalized).length <= 16,
    'LOOP_LENGTH',
    'Loop ID 最多 16 个 Unicode 码点。',
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
