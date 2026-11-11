import { validateGraph } from './graph';
import { DomainError, migratePriorityOptions, normalizeExternalTaskId, requireCondition, type ProjectGraph, type ProjectSnapshot, type TaskComment, type TaskOption } from './model';

export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_SNAPSHOT_ENTITIES = 100_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string, fields: readonly string[]): JsonRecord {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'SNAPSHOT_SHAPE', `${label}必须为对象。`);
  const result = value as JsonRecord;
  const keys = Object.keys(result);
  requireCondition(
    keys.length === fields.length && keys.every(key => fields.includes(key)),
    'SNAPSHOT_FIELDS',
    `${label}字段不符合快照 schema。`,
  );
  return result;
}

function text(value: unknown, label: string): string {
  requireCondition(typeof value === 'string', 'SNAPSHOT_TYPE', `${label}必须为文本。`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  requireCondition(value === null || typeof value === 'string', 'SNAPSHOT_TYPE', `${label}必须为文本或 null。`);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value), 'SNAPSHOT_TYPE', `${label}必须为安全整数。`);
  return value;
}

function parseItems<T>(
  value: unknown,
  label: string,
  fields: readonly string[],
  parse: (item: JsonRecord, index: number) => T,
): T[] {
  requireCondition(Array.isArray(value), 'SNAPSHOT_TYPE', `${label}必须为数组。`);
  return value.map((item, index) => parse(record(item, `${label}[${index}]`, fields), index));
}

export function serializeProjectSnapshot(snapshot: ProjectSnapshot): string {
  const { nodes, edges, branches, tasks } = snapshot.graph;
  const project = snapshot.graph.project;
  const entityCount = nodes.length + edges.length + branches.length + tasks.length
    + project.statusOptions.length + project.typeOptions.length + project.priorityOptions.length + project.assigneeOptions.length
    + tasks.reduce((count, task) => count + task.comments.length, 0);
  requireCondition(entityCount <= MAX_SNAPSHOT_ENTITIES, 'SNAPSHOT_ENTITY_LIMIT', `配置实体超过 ${MAX_SNAPSHOT_ENTITIES} 个上限，无法导出为可恢复备份。`);
  const json = JSON.stringify({
    ...snapshot,
    graph: {
      ...snapshot.graph,
      branches: branches.map(({ id, projectId, name, description, color, headId }) => ({
        id, projectId, name, description, color, headId,
      })),
    },
  }, null, 2);
  requireCondition(new TextEncoder().encode(json).byteLength <= MAX_SNAPSHOT_BYTES, 'SNAPSHOT_SIZE_LIMIT', '配置 JSON 超过 20 MiB，无法导出为可恢复备份。');
  return json;
}

export function parseProjectSnapshot(value: unknown): ProjectGraph {
  let root = record(value, '快照', ['schemaVersion', 'graph']);
  requireCondition(root.schemaVersion === 3 || root.schemaVersion === 4 || root.schemaVersion === 5, 'SNAPSHOT_VERSION', '仅支持 schemaVersion 3、4 和 5 配置文件。');
  if (root.schemaVersion === 3) {
    const legacy = record(root.graph, 'graph', ['project', 'nodes', 'edges', 'branches', 'tasks']);
    requireCondition(Array.isArray(legacy.tasks), 'SNAPSHOT_TYPE', 'graph.tasks 必须为数组。');
    const legacyProject = record(legacy.project, 'graph.project', ['id', 'name', 'partNumber', 'revision']);
    const legacyTasks = parseItems(legacy.tasks, 'graph.tasks', [
      'id', 'projectId', 'name', 'description', 'externalTaskId',
    ], item => ({
      id: text(item.id, 'task.id'),
      projectId: text(item.projectId, 'task.projectId'),
      name: text(item.name, 'task.name'),
      description: text(item.description, 'task.description'),
      externalTaskId: nullableText(item.externalTaskId, 'task.externalTaskId'),
    }));
    const orderedTasks = [...legacyTasks].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const orderById = new Map(orderedTasks.map((task, sortOrder) => [task.id, sortOrder]));
    const makeOptions = (names: readonly string[]): TaskOption[] => names.map(name => ({ id: crypto.randomUUID(), name }));
    const statusOptions = makeOptions(['Backlog', 'Pending', 'In Progress', 'release pending', 'Done']);
    const typeOptions = makeOptions([
      'Project Devel...', 'Series Mainte...', 'Field/After-...', 'CO Support', 'Bug/Issue', 'Technical Imp...', 'Internal',
    ]);
    root = {
      schemaVersion: 4,
      graph: {
        ...legacy,
        project: {
          ...legacyProject,
          statusOptions,
          typeOptions,
          priorityOptions: [],
          assigneeOptions: [],
        },
        tasks: legacyTasks.map(task => ({
          ...task,
          statusOptionId: null,
          typeOptionId: null,
          priorityOptionId: null,
          assigneeId: null,
          startDate: null,
          dueDate: null,
          sortOrder: orderById.get(task.id)!,
          comments: [],
        })),
      },
    };
  }
  if (root.schemaVersion === 4) {
    const legacy = record(root.graph, 'graph', ['project', 'nodes', 'edges', 'branches', 'tasks']);
    const legacyProject = record(legacy.project, 'graph.project', [
      'id', 'name', 'partNumber', 'revision', 'statusOptions', 'typeOptions', 'priorityOptions', 'assigneeOptions',
    ]);
    const priorityOptions = parseItems(legacyProject.priorityOptions, 'graph.project.priorityOptions', ['id', 'name'], item => ({
      id: text(item.id, 'priority.id'),
      name: text(item.name, 'priority.name'),
    }));
    root = {
      schemaVersion: 5,
      graph: {
        ...legacy,
        project: {
          ...legacyProject,
          priorityOptions: migratePriorityOptions(priorityOptions),
        },
      },
    };
  }
  const source = record(root.graph, 'graph', ['project', 'nodes', 'edges', 'branches', 'tasks']);
  requireCondition(
    Array.isArray(source.nodes) && Array.isArray(source.edges) &&
      Array.isArray(source.branches) && Array.isArray(source.tasks),
    'SNAPSHOT_TYPE',
    'graph.nodes、edges、branches、tasks 必须为数组。',
  );
  const project = record(source.project, 'graph.project', [
    'id', 'name', 'partNumber', 'revision', 'statusOptions', 'typeOptions', 'priorityOptions', 'assigneeOptions',
  ]);
  requireCondition(typeof project.revision === 'number' && Number.isSafeInteger(project.revision), 'SNAPSHOT_TYPE', 'graph.project.revision 必须为安全整数。');
  const optionFields = ['statusOptions', 'typeOptions', 'priorityOptions', 'assigneeOptions'] as const;
  requireCondition(optionFields.every(field => Array.isArray(project[field])), 'SNAPSHOT_TYPE', '项目任务选项必须为数组。');
  const commentCount = source.tasks.reduce((count, task) => {
    if (task !== null && typeof task === 'object' && !Array.isArray(task) && Array.isArray((task as JsonRecord).comments)) {
      return count + ((task as JsonRecord).comments as unknown[]).length;
    }
    return count;
  }, 0);
  const entityCount = source.nodes.length + source.edges.length + source.branches.length + source.tasks.length
    + optionFields.reduce((count, field) => count + (project[field] as unknown[]).length, 0) + commentCount;
  requireCondition(entityCount <= MAX_SNAPSHOT_ENTITIES, 'SNAPSHOT_ENTITY_LIMIT', `配置实体超过 ${MAX_SNAPSHOT_ENTITIES} 个上限。`);
  const parseOptions = (field: 'statusOptions' | 'typeOptions' | 'priorityOptions' | 'assigneeOptions'): TaskOption[] => {
    if (field === 'priorityOptions') {
      return parseItems(project[field], `graph.project.${field}`, ['id', 'name', 'indicatorCount', 'indicatorColor'], (item, index) => ({
        id: text(item.id, `project option ${index}.id`),
        name: text(item.name, `project option ${index}.name`),
        indicatorCount: safeInteger(item.indicatorCount, `project option ${index}.indicatorCount`),
        indicatorColor: text(item.indicatorColor, `project option ${index}.indicatorColor`),
      }));
    }
    return parseItems(project[field], `graph.project.${field}`, ['id', 'name'], (item, index) => ({
      id: text(item.id, `project option ${index}.id`),
      name: text(item.name, `project option ${index}.name`),
    }));
  };
  const graph: ProjectGraph = {
    project: {
      id: text(project.id, 'graph.project.id'),
      name: text(project.name, 'graph.project.name'),
      partNumber: text(project.partNumber, 'graph.project.partNumber'),
      revision: project.revision,
      engineeringDirectoryHint: '',
      wordDirectoryHint: '',
      statusOptions: parseOptions('statusOptions'),
      typeOptions: parseOptions('typeOptions'),
      priorityOptions: parseOptions('priorityOptions'),
      assigneeOptions: parseOptions('assigneeOptions'),
    },
    nodes: parseItems(source.nodes, 'graph.nodes', ['id', 'projectId', 'version', 'description', 'taskId', 'releasedAt'], item => ({
      id: text(item.id, 'node.id'),
      projectId: text(item.projectId, 'node.projectId'),
      version: text(item.version, 'node.version'),
      description: text(item.description, 'node.description'),
      taskId: nullableText(item.taskId, 'node.taskId'),
      releasedAt: nullableText(item.releasedAt, 'node.releasedAt'),
    })),
    edges: parseItems(source.edges, 'graph.edges', ['id', 'projectId', 'parentId', 'childId'], item => ({
      id: text(item.id, 'edge.id'),
      projectId: text(item.projectId, 'edge.projectId'),
      parentId: text(item.parentId, 'edge.parentId'),
      childId: text(item.childId, 'edge.childId'),
    })),
    branches: parseItems(source.branches, 'graph.branches', ['id', 'projectId', 'name', 'description', 'color', 'headId'], (item, index) => ({
      id: text(item.id, 'branch.id'),
      projectId: text(item.projectId, 'branch.projectId'),
      name: text(item.name, 'branch.name'),
      description: text(item.description, 'branch.description'),
      color: text(item.color, 'branch.color'),
      headId: text(item.headId, 'branch.headId'),
      order: index,
    })),
    tasks: parseItems(source.tasks, 'graph.tasks', [
      'id', 'projectId', 'name', 'description', 'externalTaskId', 'statusOptionId', 'typeOptionId', 'priorityOptionId',
      'assigneeId', 'startDate', 'dueDate', 'sortOrder', 'comments',
    ], item => ({
      id: text(item.id, 'task.id'),
      projectId: text(item.projectId, 'task.projectId'),
      name: text(item.name, 'task.name'),
      description: text(item.description, 'task.description'),
      externalTaskId: nullableText(item.externalTaskId, 'task.externalTaskId'),
      statusOptionId: nullableText(item.statusOptionId, 'task.statusOptionId'),
      typeOptionId: nullableText(item.typeOptionId, 'task.typeOptionId'),
      priorityOptionId: nullableText(item.priorityOptionId, 'task.priorityOptionId'),
      assigneeId: nullableText(item.assigneeId, 'task.assigneeId'),
      startDate: nullableText(item.startDate, 'task.startDate'),
      dueDate: nullableText(item.dueDate, 'task.dueDate'),
      sortOrder: safeInteger(item.sortOrder, 'task.sortOrder'),
      comments: parseItems(item.comments, 'task.comments', ['id', 'text', 'createdAt', 'updatedAt'], comment => ({
        id: text(comment.id, 'comment.id'),
        text: text(comment.text, 'comment.text'),
        createdAt: text(comment.createdAt, 'comment.createdAt'),
        updatedAt: text(comment.updatedAt, 'comment.updatedAt'),
      } satisfies TaskComment)),
    })),
  };
  const taskIds = new Set<string>();
  for (const task of graph.tasks) {
    let taskId: string | null;
    try {
      taskId = normalizeExternalTaskId(task.externalTaskId);
    } catch (cause) {
      if (cause instanceof DomainError) {
        throw new DomainError(cause.code, `任务 ${task.id} 的 externalTaskId 无效：${cause.message}`);
      }
      throw cause;
    }
    requireCondition(taskId === task.externalTaskId, 'TASK_ID_NORMALIZATION', `任务 ${task.id} 的 externalTaskId 必须为 null 或已去除首尾空白的数字。`);
    if (taskId !== null) {
      requireCondition(!taskIds.has(taskId), 'DUPLICATE_TASK_ID', `任务 ${task.id} 的 externalTaskId 与其他任务重复：${taskId}`);
      taskIds.add(taskId);
    }
  }
  validateGraph(graph);
  return graph;
}

export async function readProjectSnapshotFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<ProjectGraph> {
  requireCondition(file.size <= MAX_SNAPSHOT_BYTES, 'SNAPSHOT_SIZE_LIMIT', 'JSON 文件超过 20 MiB 上限。');
  const bytes = await file.arrayBuffer();
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError('SNAPSHOT_ENCODING', 'JSON 文件必须使用有效的 UTF-8 编码。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new DomainError('SNAPSHOT_JSON', '文件内容不是有效的 JSON。');
  }
  return parseProjectSnapshot(parsed);
}
