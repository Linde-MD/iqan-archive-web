import { requireCondition, type ProjectGraph } from './model';
import { validateGraph, validateTransition } from './graph';
import { compareVersionNodes } from './version-order';

export type BatchRelationAction = 'clear' | 'linear';

export function changeVersionRelations(
  graph: ProjectGraph, nodeIds: readonly string[], action: BatchRelationAction,
): ProjectGraph {
  validateGraph(graph);
  const selected = new Set(nodeIds);
  requireCondition(selected.size >= 2 && selected.size === nodeIds.length, 'RELATION_SELECTION', '请选择至少两个不同版本。');
  const nodes = graph.nodes.filter(node => selected.has(node.id));
  requireCondition(nodes.length === selected.size, 'NODE_REFERENCE', '所选版本已不存在，请重新选择。');
  const related = graph.edges.filter(edge => selected.has(edge.parentId) || selected.has(edge.childId));
  const next = structuredClone(graph);
  if (action === 'clear') {
    requireCondition(related.length > 0, 'NO_RELATIONS', '所选版本没有可清除的父子关联。');
    requireCondition(
      !related.some(edge => graph.nodes.find(node => node.id === edge.childId)?.releasedAt !== null),
      'RELEASE_LOCK', '已放行版本的父边在批量清除中已锁定；如需更换请使用单节点设置父版本。',
    );
    const removed = new Set(related.map(edge => edge.id));
    next.edges = next.edges.filter(edge => !removed.has(edge.id));
  } else {
    requireCondition(action === 'linear', 'RELATION_ACTION', '不支持的父子关联操作。');
    requireCondition(related.length === 0, 'NOT_ISOLATED', '仅可为全部没有父子关联的游离版本构建线性关联。');
    nodes.sort((a, b) => compareVersionNodes(a, b, 'oldest'));
    requireCondition(nodes.slice(1).every(node => node.releasedAt === null),
      'RELEASE_LOCK', '批量线性关联不能为已放行版本新增父边。');
    for (let index = 1; index < nodes.length; index++) {
      next.edges.push({
        id: crypto.randomUUID(), projectId: graph.project.id,
        parentId: nodes[index - 1]!.id, childId: nodes[index]!.id,
      });
    }
  }
  validateTransition(graph, next);
  return next;
}
