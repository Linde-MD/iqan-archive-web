import { orderedBranches, requireCondition, type Branch, type Edge, type ProjectGraph, type ProjectSnapshot, type Task, type VersionNode } from './model';

export interface EntityChanges<T> {
  upsert: T[];
  delete: string[];
}

export interface ProjectChanges {
  revision: number;
  project?: ProjectSnapshot['graph']['project'];
  nodes?: EntityChanges<VersionNode>;
  edges?: EntityChanges<Edge>;
  tasks?: EntityChanges<Task>;
  branches?: EntityChanges<Branch>;
}

export type ProjectDelta = Omit<ProjectChanges, 'revision'> & {
  baseRevision: number | null;
  revision: number;
};

function comparisonJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : item);
}

function changes<T extends { id: string }>(before: readonly T[], after: readonly T[]): EntityChanges<T> | undefined {
  const previous = new Map(before.map(item => [item.id, item]));
  const next = new Map(after.map(item => [item.id, item]));
  const upsert = after.filter(item => comparisonJson(previous.get(item.id)) !== comparisonJson(item));
  const removed = before.filter(item => !next.has(item.id)).map(item => item.id);
  return upsert.length || removed.length ? { upsert, delete: removed } : undefined;
}

function projectFields(graph: ProjectGraph): ProjectSnapshot['graph']['project'] {
  const { id, name, partNumber, revision, statusOptions, typeOptions, priorityOptions, assigneeOptions } = graph.project;
  return { id, name, partNumber, revision, statusOptions, typeOptions, priorityOptions, assigneeOptions };
}

export function diffProjectGraphs(before: ProjectGraph, after: ProjectGraph): ProjectChanges {
  const changeset: ProjectChanges = { revision: before.project.revision };
  if (comparisonJson(projectFields(before)) !== comparisonJson({ ...projectFields(after), revision: before.project.revision })) {
    changeset.project = projectFields(after);
  }
  const nodes = changes(before.nodes, after.nodes);
  const edges = changes(before.edges, after.edges);
  const tasks = changes(before.tasks, after.tasks);
  const previousBranches = orderedBranches(before.branches).map((branch, order) => ({ ...branch, order }));
  const nextBranches = orderedBranches(after.branches).map((branch, order) => ({ ...branch, order }));
  const branches = changes(previousBranches, nextBranches);
  if (nodes) changeset.nodes = nodes;
  if (edges) changeset.edges = edges;
  if (tasks) changeset.tasks = tasks;
  if (branches) changeset.branches = branches;
  return changeset;
}

export function hasProjectChanges({ project, nodes, edges, tasks, branches }: ProjectChanges): boolean {
  return Boolean(project || nodes || edges || tasks || branches);
}

export function createProjectDelta(before: ProjectGraph | null, after: ProjectGraph): ProjectDelta {
  if (!before) {
    return {
      baseRevision: null,
      revision: after.project.revision,
      project: projectFields(after),
      nodes: { upsert: after.nodes, delete: [] },
      edges: { upsert: after.edges, delete: [] },
      tasks: { upsert: after.tasks, delete: [] },
      branches: {
        upsert: orderedBranches(after.branches).map((branch, order) => ({ ...branch, order })),
        delete: [],
      },
    };
  }
  const { revision: _baseRevision, ...delta } = diffProjectGraphs(before, after);
  return { ...delta, baseRevision: before.project.revision, revision: after.project.revision };
}

function deltaObject(value: unknown, label: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value),
    'PROJECT_DELTA', `${label}必须为对象。`);
  return value as Record<string, unknown>;
}

function parseEntityDelta<T extends { id: string; projectId: string }>(
  value: unknown,
  projectId: string,
  label: string,
): EntityChanges<T> | undefined {
  if (value === undefined) return undefined;
  const patch = deltaObject(value, `${label}变更`);
  requireCondition(Object.keys(patch).length === 2 && Object.hasOwn(patch, 'upsert') && Object.hasOwn(patch, 'delete')
    && Array.isArray(patch.upsert) && Array.isArray(patch.delete),
  'PROJECT_DELTA', `${label}变更格式无效。`);
  const upsert = patch.upsert.map(item => {
    const row = deltaObject(item, `${label}记录`);
    requireCondition(typeof row.id === 'string' && row.projectId === projectId,
      'PROJECT_DELTA', `${label}记录身份无效。`);
    return item as T;
  });
  const removed = patch.delete.map(id => {
    requireCondition(typeof id === 'string', 'PROJECT_DELTA', `${label}删除 ID 无效。`);
    return id;
  });
  const ids = new Set(upsert.map(item => item.id));
  const removedIds = new Set(removed);
  requireCondition(ids.size === upsert.length && removedIds.size === removed.length
    && [...ids].every(id => !removedIds.has(id)),
  'PROJECT_DELTA', `${label}变更包含重复或冲突的 ID。`);
  return { upsert, delete: removed };
}

export function parseProjectDelta(value: unknown, expectedProjectId?: string): ProjectDelta {
  const row = deltaObject(value, '项目变更回执');
  const allowed = ['baseRevision', 'revision', 'project', 'nodes', 'edges', 'tasks', 'branches'];
  requireCondition(Object.keys(row).every(key => allowed.includes(key))
    && (row.baseRevision === null || (typeof row.baseRevision === 'number' && Number.isSafeInteger(row.baseRevision) && row.baseRevision >= 0))
    && typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0,
  'PROJECT_DELTA', '项目变更回执修订无效。');
  const project = row.project === undefined ? undefined : deltaObject(row.project, '项目变更回执项目');
  requireCondition(row.baseRevision === null
    ? row.revision === 0
    : row.revision === (row.baseRevision as number) + 1,
  'PROJECT_DELTA', '项目变更回执修订关系无效。');
  if (project) {
    const fields = ['id', 'name', 'partNumber', 'revision', 'statusOptions', 'typeOptions', 'priorityOptions', 'assigneeOptions'];
    requireCondition(Object.keys(project).length === fields.length && Object.keys(project).every(key => fields.includes(key))
      && typeof project.id === 'string' && project.revision === row.revision,
    'PROJECT_DELTA', '项目变更回执项目无效。');
  }
  const projectId = typeof project?.id === 'string' ? project.id : expectedProjectId ?? '';
  requireCondition(!project || !expectedProjectId || project.id === expectedProjectId,
    'PROJECT_DELTA', '项目变更回执身份不一致。');
  const delta: ProjectDelta = {
    baseRevision: row.baseRevision as number | null,
    revision: row.revision as number,
  };
  if (project) delta.project = project as ProjectSnapshot['graph']['project'];
  const nodes = parseEntityDelta<VersionNode>(row.nodes, projectId, '版本节点');
  const edges = parseEntityDelta<Edge>(row.edges, projectId, '父子边');
  const tasks = parseEntityDelta<Task>(row.tasks, projectId, '任务');
  const branches = parseEntityDelta<Branch>(row.branches, projectId, '分支');
  if (nodes) delta.nodes = nodes;
  if (edges) delta.edges = edges;
  if (tasks) delta.tasks = tasks;
  if (branches) delta.branches = branches;
  requireCondition(delta.baseRevision !== null || Boolean(delta.project),
    'PROJECT_DELTA', '新项目回执缺少项目摘要。');
  const resolvedProjectId = delta.project?.id ?? expectedProjectId;
  requireCondition(resolvedProjectId && [delta.nodes?.upsert, delta.edges?.upsert, delta.tasks?.upsert, delta.branches?.upsert]
    .every(items => !items || items.every(item => item.projectId === resolvedProjectId)),
  'PROJECT_DELTA', '项目变更回执身份不一致。');
  return delta;
}

function applyEntityDelta<T extends { id: string }>(
  current: T[],
  patch: EntityChanges<T> | undefined,
  label: string,
): T[] {
  if (!patch) return current;
  const removals = new Set(patch.delete);
  requireCondition(patch.delete.every(id => current.some(item => item.id === id)),
    'PROJECT_DELTA', `${label}删除记录不存在。`);
  const next = current.filter(item => !removals.has(item.id));
  for (const item of patch.upsert) {
    const index = next.findIndex(previous => previous.id === item.id);
    if (index < 0) next.push(item);
    else next[index] = item;
  }
  return next;
}

export function applyProjectDelta(current: ProjectGraph | null, delta: ProjectDelta): ProjectGraph {
  if (current) {
    requireCondition(delta.baseRevision === current.project.revision && delta.revision === current.project.revision + 1,
      'PROJECT_DELTA_BASE', '本机副本与提交回执基线不一致。');
  } else {
    requireCondition(delta.baseRevision === null && delta.revision === 0 && delta.project,
      'PROJECT_DELTA_BASE', '新项目回执缺少有效的初始项目摘要。');
  }
  const projectId = current?.project.id ?? delta.project!.id;
  requireCondition(!delta.project || delta.project.id === projectId,
    'PROJECT_DELTA', '项目变更回执身份与本机副本不一致。');
  const next: ProjectGraph = current ? structuredClone(current) : {
    project: {
      ...delta.project!,
      engineeringDirectoryHint: '',
      wordDirectoryHint: '',
    },
    nodes: [],
    edges: [],
    tasks: [],
    branches: [],
  };
  if (delta.project) next.project = { ...next.project, ...delta.project };
  next.nodes = applyEntityDelta(next.nodes, delta.nodes, '版本节点');
  next.edges = applyEntityDelta(next.edges, delta.edges, '父子边');
  next.tasks = applyEntityDelta(next.tasks, delta.tasks, '任务');
  next.branches = orderedBranches(applyEntityDelta(next.branches, delta.branches, '分支'));
  next.project.revision = delta.revision;
  return next;
}
