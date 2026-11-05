import { validateGraph } from './graph';
import { DomainError, normalizeExternalTaskId, requireCondition, type ProjectGraph, type ProjectSnapshot } from './model';

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
    `${label}字段不符合 schemaVersion 3。`,
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
  const entityCount = nodes.length + edges.length + branches.length + tasks.length;
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
  const root = record(value, '快照', ['schemaVersion', 'graph']);
  requireCondition(root.schemaVersion === 3, 'SNAPSHOT_VERSION', '仅支持 schemaVersion 3 配置文件。');
  const source = record(root.graph, 'graph', ['project', 'nodes', 'edges', 'branches', 'tasks']);
  requireCondition(
    Array.isArray(source.nodes) && Array.isArray(source.edges) &&
      Array.isArray(source.branches) && Array.isArray(source.tasks),
    'SNAPSHOT_TYPE',
    'graph.nodes、edges、branches、tasks 必须为数组。',
  );
  const entityCount = source.nodes.length + source.edges.length + source.branches.length + source.tasks.length;
  requireCondition(entityCount <= MAX_SNAPSHOT_ENTITIES, 'SNAPSHOT_ENTITY_LIMIT', `配置实体超过 ${MAX_SNAPSHOT_ENTITIES} 个上限。`);

  const project = record(source.project, 'graph.project', ['id', 'name', 'partNumber', 'revision']);
  requireCondition(typeof project.revision === 'number' && Number.isSafeInteger(project.revision), 'SNAPSHOT_TYPE', 'graph.project.revision 必须为安全整数。');
  const graph: ProjectGraph = {
    project: {
      id: text(project.id, 'graph.project.id'),
      name: text(project.name, 'graph.project.name'),
      partNumber: text(project.partNumber, 'graph.project.partNumber'),
      revision: project.revision,
      engineeringDirectoryHint: '',
      wordDirectoryHint: '',
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
    tasks: parseItems(source.tasks, 'graph.tasks', ['id', 'projectId', 'name', 'description', 'externalTaskId'], item => ({
      id: text(item.id, 'task.id'),
      projectId: text(item.projectId, 'task.projectId'),
      name: text(item.name, 'task.name'),
      description: text(item.description, 'task.description'),
      externalTaskId: nullableText(item.externalTaskId, 'task.externalTaskId'),
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
