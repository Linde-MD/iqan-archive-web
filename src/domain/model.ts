export type ArchiveLocation = 'shared' | 'local';

export interface TaskOption {
  id: string;
  name: string;
  indicatorCount?: number;
  indicatorColor?: string;
}

export const DEFAULT_PRIORITY_PRESENTATIONS = [
  { name: '最高', indicatorCount: 3, indicatorColor: '#f05252' },
  { name: '较高', indicatorCount: 2, indicatorColor: '#f27ba5' },
  { name: '普通', indicatorCount: 2, indicatorColor: '#eabf35' },
  { name: '最低', indicatorCount: 1, indicatorColor: '#20bfa9' },
  { name: '较低', indicatorCount: 1, indicatorColor: '#35b8ed' },
] as const;

export function createDefaultPriorityOptions(): TaskOption[] {
  return DEFAULT_PRIORITY_PRESENTATIONS.map(presentation => ({ id: crypto.randomUUID(), ...presentation }));
}

export function createPriorityOption(name: string, index: number): TaskOption {
  const presentation = DEFAULT_PRIORITY_PRESENTATIONS[index % DEFAULT_PRIORITY_PRESENTATIONS.length]!;
  return { id: crypto.randomUUID(), name, indicatorCount: presentation.indicatorCount, indicatorColor: presentation.indicatorColor };
}

export function migratePriorityOptions(options: readonly TaskOption[]): TaskOption[] {
  if (!options.length) return createDefaultPriorityOptions();
  return options.map((option, index) => {
    const presentation = DEFAULT_PRIORITY_PRESENTATIONS[index % DEFAULT_PRIORITY_PRESENTATIONS.length]!;
    return {
      ...option,
      indicatorCount: option.indicatorCount ?? presentation.indicatorCount,
      indicatorColor: option.indicatorColor ?? presentation.indicatorColor,
    };
  });
}

export interface TaskComment {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  partNumber: string;
  engineeringDirectoryHint: string;
  wordDirectoryHint: string;
  revision: number;
  statusOptions: TaskOption[];
  typeOptions: TaskOption[];
  priorityOptions: TaskOption[];
  assigneeOptions: TaskOption[];
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
  statusOptionId: string | null;
  typeOptionId: string | null;
  priorityOptionId: string | null;
  assigneeId: string | null;
  startDate: string | null;
  dueDate: string | null;
  sortOrder: number;
  comments: TaskComment[];
}

export interface ProjectGraph {
  project: Project;
  nodes: VersionNode[];
  edges: Edge[];
  branches: Branch[];
  tasks: Task[];
}

export interface ProjectSnapshot {
  schemaVersion: 5;
  graph: Omit<ProjectGraph, 'project' | 'branches'> & {
    project: Pick<Project, 'id' | 'name' | 'partNumber' | 'revision' | 'statusOptions' | 'typeOptions' | 'priorityOptions' | 'assigneeOptions'>;
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
      statusOptions: [
        { id: crypto.randomUUID(), name: 'Backlog' },
        { id: crypto.randomUUID(), name: 'Pending' },
        { id: crypto.randomUUID(), name: 'In Progress' },
        { id: crypto.randomUUID(), name: 'release pending' },
        { id: crypto.randomUUID(), name: 'Done' },
      ],
      typeOptions: [
        'Project Devel...', 'Series Mainte...', 'Field/After-...', 'CO Support', 'Bug/Issue', 'Technical Imp...', 'Internal',
      ].map(name => ({ id: crypto.randomUUID(), name })),
      priorityOptions: createDefaultPriorityOptions(),
      assigneeOptions: [],
    },
    nodes: [], edges: [], branches: [], tasks: [],
  };
}
