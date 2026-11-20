import { requireCondition, type ProjectGraph } from './model';
import { applyDeletionMany, setNodeParents, updateNode } from './graph';
import { changeVersionRelations } from './relations';

function record(value: unknown): Record<string, unknown> {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'COMMAND', '命令对象无效。');
  return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown): string[] {
  requireCondition(Array.isArray(value) && value.every(item => typeof item === 'string'), 'COMMAND', '版本列表无效。');
  return value;
}

export function applyCollaborationCommand(graph: ProjectGraph, value: unknown): ProjectGraph {
  const command = record(value);
  if (command.type === 'parents') {
    requireCondition(typeof command.nodeId === 'string', 'COMMAND', '缺少版本 ID。');
    return setNodeParents(graph, command.nodeId, strings(command.parentIds));
  }
  if (command.type === 'edit-node') {
    const update = record(command.update);
    requireCondition(typeof command.nodeId === 'string'
      && typeof update.version === 'string' && typeof update.description === 'string'
      && (update.taskId === null || typeof update.taskId === 'string')
      && Object.keys(update).every(key => ['version', 'description', 'taskId'].includes(key)),
    'COMMAND', '版本编辑命令无效。');
    return setNodeParents(updateNode(graph, command.nodeId, {
      version: update.version, description: update.description, taskId: update.taskId,
    }), command.nodeId, strings(command.parentIds));
  }
  if (command.type === 'relations') {
    requireCondition(command.action === 'clear' || command.action === 'linear', 'COMMAND', '关系操作无效。');
    return changeVersionRelations(graph, strings(command.nodeIds), command.action);
  }
  requireCondition(command.type === 'delete', 'COMMAND', '未知图命令。');
  const plan = record(command.plan);
  const childParents = Object.fromEntries(Object.entries(record(plan.childParents)).map(([id, parents]) => [id, strings(parents)]));
  const branchHeads = Object.fromEntries(Object.entries(record(plan.branchHeads)).map(([id, head]) => {
    requireCondition(head === null || typeof head === 'string', 'COMMAND', '分支替代头无效。');
    return [id, head];
  }));
  const confirmedVersions = Object.fromEntries(Object.entries(record(command.confirmedVersions)).map(([id, version]) => {
    requireCondition(typeof version === 'string', 'COMMAND', '删除确认无效。');
    return [id, version];
  }));
  return applyDeletionMany(graph, { nodeIds: strings(plan.nodeIds), childParents, branchHeads }, confirmedVersions);
}

export function assertOfflineChanges(base: ProjectGraph, next: ProjectGraph): void {
  const stable = (graph: ProjectGraph) => ({ ...graph.project, revision: 0 });
  requireCondition(JSON.stringify(stable(base)) === JSON.stringify(stable(next))
    && JSON.stringify(base.tasks) === JSON.stringify(next.tasks)
    && JSON.stringify(base.branches) === JSON.stringify(next.branches),
  'OFFLINE_READONLY', '离线时项目、任务和分支只读；仅可新增版本并编辑未同步版本。');
  const nodes = new Map(next.nodes.map(node => [node.id, node]));
  for (const node of base.nodes) {
    requireCondition(JSON.stringify(nodes.get(node.id)) === JSON.stringify(node),
      'OFFLINE_READONLY', '既有共享版本离线只读。');
  }
  const baseIds = new Set(base.nodes.map(node => node.id));
  const oldEdges = (graph: ProjectGraph) => graph.edges.filter(edge => baseIds.has(edge.childId));
  requireCondition(JSON.stringify(oldEdges(base)) === JSON.stringify(oldEdges(next)),
    'OFFLINE_READONLY', '不能离线修改既有版本的父关系。');
  for (const node of next.nodes) if (!baseIds.has(node.id)) {
    requireCondition(node.releasedAt === null && node.testingAt === null, 'OFFLINE_STATE', '待同步版本必须为未放行。');
  }
}
