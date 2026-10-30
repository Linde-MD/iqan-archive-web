import {
  DomainError, normalizeLoopId, normalizeVersion, requireCondition,
  type ProjectGraph, type Task, type VersionNode,
} from './model';

function uniqueIds(items: readonly { id: string }[], label: string) {
  const ids = new Set<string>();
  for (const item of items) {
    requireCondition(item.id.trim() && !ids.has(item.id), 'DUPLICATE_ID', `${label} ID 为空或重复：${item.id}`);
    ids.add(item.id);
  }
}

export function validateGraph(graph: ProjectGraph): void {
  const { project, nodes, edges, branches, tasks } = graph;
  requireCondition(project.id.trim() && project.name.trim() && project.partNumber.trim(), 'PROJECT', '项目身份、名称和零件号不能为空。');
  requireCondition(Number.isSafeInteger(project.revision) && project.revision >= 0, 'REVISION', '项目修订号无效。');
  for (const [label, items] of [
    ['版本', nodes], ['关系', edges], ['分支', branches], ['任务', tasks],
  ] as const) {
    uniqueIds(items, label);
    for (const item of items) requireCondition(item.projectId === project.id, 'CROSS_PROJECT', `${label}不能跨项目引用。`);
  }
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const taskIds = new Set(tasks.map(task => task.id));
  const versions = new Set<string>();
  const loopIds = new Set<string>();
  for (const task of tasks) {
    requireCondition(task.name.trim(), 'TASK_NAME', '任务名称不能为空。');
    const value = normalizeLoopId(task.loopId);
    requireCondition(value === task.loopId, 'LOOP_NORMALIZATION', 'Loop ID 必须先去除首尾空白，空值存为 null。');
    if (value !== null) {
      requireCondition(!loopIds.has(value), 'DUPLICATE_LOOP', `Loop ID 已被其他任务使用：${value}`);
      loopIds.add(value);
    }
  }
  for (const node of nodes) {
    requireCondition(node.version.trim() && node.version === node.version.trim(), 'VERSION', '版本号不能为空或含首尾空白。');
    const versionKey = normalizeVersion(node.version);
    requireCondition(!versions.has(versionKey), 'DUPLICATE_VERSION', `版本号重复：${node.version}`);
    versions.add(versionKey);
    requireCondition(node.taskId === null || taskIds.has(node.taskId), 'TASK_REFERENCE', '版本引用的任务不存在。');
    requireCondition(node.releasedAt === null || Number.isFinite(Date.parse(node.releasedAt)), 'RELEASE_TIME', '放行时间无效。');
  }
  const children = new Map(nodes.map(node => [node.id, [] as string[]]));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const pairs = new Set<string>();
  for (const edge of edges) {
    const parent = nodeMap.get(edge.parentId);
    const child = nodeMap.get(edge.childId);
    requireCondition(parent && child, 'NODE_REFERENCE', '父边引用了不存在的节点。');
    const key = JSON.stringify([edge.parentId, edge.childId]);
    requireCondition(!pairs.has(key), 'DUPLICATE_EDGE', '父边重复。');
    pairs.add(key);
    children.get(parent.id)!.push(child.id);
    incoming.set(child.id, incoming.get(child.id)! + 1);
    requireCondition(child.releasedAt === null || parent.releasedAt !== null, 'RELEASE_CLOSURE', '已放行节点的祖先必须全部放行。');
  }
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const child of children.get(queue[cursor]!)!) {
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  requireCondition(queue.length === nodes.length, 'CYCLE', '版本关系不能成环。');
  for (const branch of branches) {
    requireCondition(branch.name.trim() && nodeMap.has(branch.headId), 'BRANCH', '分支名称为空或头节点不存在。');
    requireCondition(/^#[0-9a-f]{6}$/i.test(branch.color), 'COLOR', '分支颜色须为六位十六进制颜色。');
  }
}

export function updatePartNumber(graph: ProjectGraph, value: string): ProjectGraph {
  requireCondition(value.trim(), 'REQUIRED', '项目零件号不能为空。');
  const next = structuredClone(graph);
  next.project.partNumber = value.trim();
  validateTransition(graph, next);
  return next;
}

function getNode(graph: ProjectGraph, id: string): VersionNode {
  const node = graph.nodes.find(item => item.id === id);
  requireCondition(node, 'NODE_REFERENCE', `节点不存在：${id}`);
  return node;
}

export function ancestors(graph: ProjectGraph, targetId: string): Set<string> {
  validateGraph(graph);
  getNode(graph, targetId);
  const parents = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of graph.edges) parents.get(edge.childId)!.push(edge.parentId);
  const result = new Set<string>();
  const pending = [targetId];
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...parents.get(id)!);
  }
  return result;
}

export function release(graph: ProjectGraph, targetId: string, time: string): ProjectGraph {
  requireCondition(Number.isFinite(Date.parse(time)), 'RELEASE_TIME', '放行时间无效。');
  const ids = ancestors(graph, targetId);
  const next = structuredClone(graph);
  for (const node of next.nodes) if (ids.has(node.id) && node.releasedAt === null) node.releasedAt = time;
  validateGraph(next);
  return next;
}

export function revokeRelease(graph: ProjectGraph, targetId: string): ProjectGraph {
  validateGraph(graph);
  getNode(graph, targetId);
  for (const node of graph.nodes) {
    if (node.id !== targetId && node.releasedAt !== null && ancestors(graph, node.id).has(targetId)) {
      throw new DomainError('RELEASED_DESCENDANT', '存在已放行后代，请先撤销后代放行。');
    }
  }
  const next = structuredClone(graph);
  getNode(next, targetId).releasedAt = null;
  return next;
}

export function updateTask(graph: ProjectGraph, task: Task): ProjectGraph {
  const next = structuredClone(graph);
  const normalized = { ...task, name: task.name.trim(), loopId: normalizeLoopId(task.loopId) };
  const index = next.tasks.findIndex(item => item.id === task.id);
  if (index < 0) next.tasks.push(normalized);
  else next.tasks[index] = normalized;
  validateGraph(next);
  return next;
}

export function deleteTask(graph: ProjectGraph, taskId: string): ProjectGraph {
  validateGraph(graph);
  requireCondition(graph.tasks.some(task => task.id === taskId), 'TASK_REFERENCE', '任务不存在。');
  const next = structuredClone(graph);
  next.tasks = next.tasks.filter(task => task.id !== taskId);
  for (const node of next.nodes) if (node.taskId === taskId) node.taskId = null;
  return next;
}

export function projectTaskView(graph: ProjectGraph, mode: 'all' | 'tasks', expanded: ReadonlySet<string>) {
  validateGraph(graph);
  return {
    nodes: graph.nodes.filter(node => mode === 'all' || node.taskId === null || expanded.has(node.taskId)),
    tasks: mode === 'all' ? [] : graph.tasks.map(task => ({
      task,
      expanded: expanded.has(task.id),
      nodeIds: graph.nodes.filter(node => node.taskId === task.id).map(node => node.id),
      branchHeads: graph.branches.filter(branch => graph.nodes.some(node => node.id === branch.headId && node.taskId === task.id)),
    })),
    edges: graph.edges,
  };
}

export interface DeletionPlan {
  nodeId: string;
  childParents: Record<string, string[]>;
  branchHeads: Record<string, string | null>;
}

export function planDeletion(graph: ProjectGraph, nodeId: string): DeletionPlan {
  validateGraph(graph);
  getNode(graph, nodeId);
  const replacementParents = graph.edges.filter(edge => edge.childId === nodeId).map(edge => edge.parentId);
  const childParents: Record<string, string[]> = Object.create(null);
  for (const childId of graph.edges.filter(edge => edge.parentId === nodeId).map(edge => edge.childId)) {
    childParents[childId] = [...new Set([
      ...graph.edges.filter(edge => edge.childId === childId && edge.parentId !== nodeId).map(edge => edge.parentId),
      ...replacementParents,
    ])];
  }
  // An affected branch requires an explicit replacement or explicit removal.
  return { nodeId, childParents, branchHeads: {} };
}

export function applyDeletion(graph: ProjectGraph, plan: DeletionPlan, confirmedVersion: string | null): ProjectGraph {
  validateGraph(graph);
  const node = getNode(graph, plan.nodeId);
  if (node.releasedAt !== null) {
    requireCondition(confirmedVersion === node.version, 'DELETE_CONFIRMATION', '删除已放行节点需额外确认并输入版本号。');
  }
  const expected = planDeletion(graph, node.id);
  requireCondition(
    JSON.stringify(Object.keys(expected.childParents).sort()) === JSON.stringify(Object.keys(plan.childParents).sort()),
    'DELETE_PLAN', '删除预览的子节点集合已变化，请重新预览。',
  );
  for (const childId of Object.keys(plan.childParents)) {
    requireCondition(getNode(graph, childId).releasedAt === null, 'RELEASE_LOCK', '重连不能修改已放行子节点的父边。');
  }
  const affected = graph.branches.filter(branch => branch.headId === node.id);
  requireCondition(
    JSON.stringify(affected.map(branch => branch.id).sort()) === JSON.stringify(Object.keys(plan.branchHeads).sort()),
    'BRANCH_REPLACEMENT', '必须明确设置受影响分支的新头，或明确删除分支。',
  );
  const next = structuredClone(graph);
  next.nodes = next.nodes.filter(item => item.id !== node.id);
  const children = new Set(Object.keys(plan.childParents));
  next.edges = next.edges.filter(edge => edge.parentId !== node.id && edge.childId !== node.id && !children.has(edge.childId));
  for (const [childId, parents] of Object.entries(plan.childParents)) {
    for (const parentId of new Set(parents)) {
      next.edges.push({ id: crypto.randomUUID(), projectId: graph.project.id, parentId, childId });
    }
  }
  next.branches = next.branches.flatMap(branch => {
    if (branch.headId !== node.id) return [branch];
    const headId = plan.branchHeads[branch.id];
    return headId === null ? [] : [{ ...branch, headId: headId! }];
  });
  validateGraph(next);
  return next;
}

export function validateTransition(before: ProjectGraph, after: ProjectGraph): void {
  validateGraph(before);
  validateGraph(after);
  requireCondition(before.project.id === after.project.id, 'PROJECT_ID', '不能变更项目身份。');
  for (const node of before.nodes.filter(item => item.releasedAt !== null)) {
    const updated = after.nodes.find(item => item.id === node.id);
    requireCondition(updated, 'RELEASE_LOCK', '已放行节点删除必须使用额外确认的删除命令。');
    const parents = (graph: ProjectGraph) => graph.edges.filter(edge => edge.childId === node.id).map(edge => edge.parentId).sort();
    requireCondition(
      node.version === updated.version
      && JSON.stringify(parents(before)) === JSON.stringify(parents(after)),
      'RELEASE_LOCK', '已放行版本的版本号和父边已锁定，请先撤销放行。',
    );
  }
}

export function createBranch(graph: ProjectGraph, branch: ProjectGraph['branches'][number]): ProjectGraph {
  const next = structuredClone(graph);
  next.branches.push(structuredClone(branch));
  validateGraph(next);
  return next;
}

export function appendVersion(
  graph: ProjectGraph,
  node: VersionNode,
  parentIds: readonly string[],
  targetBranchId: string | null,
): ProjectGraph {
  validateGraph(graph);
  requireCondition(node.releasedAt === null, 'INITIAL_RELEASE', '新版本初始状态必须未放行。');
  requireCondition(!graph.nodes.some(existing => existing.id === node.id), 'DUPLICATE_ID', '版本 ID 已存在。');
  requireCondition(new Set(parentIds).size === parentIds.length, 'DUPLICATE_PARENT', '父节点不能重复。');
  for (const id of parentIds) getNode(graph, id);
  const next = structuredClone(graph);
  next.nodes.push({ ...node, version: normalizeVersion(node.version) });
  for (const parentId of parentIds) {
    next.edges.push({ id: crypto.randomUUID(), projectId: graph.project.id, parentId, childId: node.id });
  }
  if (targetBranchId !== null) {
    const branch = next.branches.find(item => item.id === targetBranchId);
    requireCondition(branch, 'BRANCH_REFERENCE', '目标分支不存在。');
    requireCondition(parentIds.includes(branch.headId), 'BRANCH_PARENT', '推进分支时必须包含该分支当前头作为父节点。');
    branch.headId = node.id;
  }
  validateGraph(next);
  return next;
}

export function mergeVersion(
  graph: ProjectGraph,
  node: VersionNode,
  parentIds: readonly string[],
  targetBranchId: string,
): ProjectGraph {
  requireCondition(new Set(parentIds).size >= 2, 'MERGE_PARENTS', '合并需至少两个不同父节点。');
  return appendVersion(graph, node, parentIds, targetBranchId);
}

export interface NodeUpdate {
  version?: string;
  description?: string;
  taskId?: string | null;
}

export function updateNode(graph: ProjectGraph, nodeId: string, update: NodeUpdate): ProjectGraph {
  validateGraph(graph);
  const existing = getNode(graph, nodeId);
  const next = structuredClone(graph);
  const target = getNode(next, nodeId);
  if (update.version !== undefined) {
    if (existing.releasedAt !== null && update.version !== existing.version) {
      throw new DomainError('RELEASE_LOCK', '已放行版本的版本号已锁定，请先撤销放行。');
    }
    target.version = normalizeVersion(update.version);
  }
  if (update.description !== undefined) target.description = update.description.trim();
  if (update.taskId !== undefined) {
    requireCondition(
      update.taskId === null || graph.tasks.some(task => task.id === update.taskId),
      'TASK_REFERENCE',
      '版本引用的任务不存在。',
    );
    target.taskId = update.taskId;
  }
  validateGraph(next);
  return next;
}

export interface BranchUpdate {
  name?: string;
  description?: string;
  color?: string;
}

export function updateBranch(graph: ProjectGraph, branchId: string, update: BranchUpdate): ProjectGraph {
  validateGraph(graph);
  const branch = graph.branches.find(item => item.id === branchId);
  requireCondition(branch, 'BRANCH_REFERENCE', '分支不存在。');
  const next = structuredClone(graph);
  const target = next.branches.find(item => item.id === branchId)!;
  if (update.name !== undefined) target.name = update.name.trim();
  if (update.description !== undefined) target.description = update.description.trim();
  if (update.color !== undefined) target.color = update.color;
  validateGraph(next);
  return next;
}
