import {
  DomainError, normalizeExternalTaskId, normalizeVersion, requireCondition,
  orderedBranches, type ProjectGraph, type Task, type TaskOption, type VersionNode,
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
  const validateOptions = (options: readonly TaskOption[], label: string) => {
    uniqueIds(options, label);
    const names = new Set<string>();
    for (const option of options) {
      requireCondition(option.name.trim() && option.name === option.name.trim(), 'TASK_OPTION_NAME', `${label}名称不能为空或含首尾空白。`);
      requireCondition(!names.has(option.name.toLocaleLowerCase()), 'TASK_OPTION_DUPLICATE', `${label}名称不能重复：${option.name}`);
      names.add(option.name.toLocaleLowerCase());
    }
  };
  validateOptions(project.statusOptions, 'Status');
  validateOptions(project.typeOptions, 'Type');
  validateOptions(project.priorityOptions, 'Priority');
  validateOptions(project.assigneeOptions, 'Assignee');
  for (const [label, items] of [
    ['版本', nodes], ['关系', edges], ['分支', branches], ['任务', tasks],
  ] as const) {
    uniqueIds(items, label);
    for (const item of items) requireCondition(item.projectId === project.id, 'CROSS_PROJECT', `${label}不能跨项目引用。`);
  }
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const taskIds = new Set(tasks.map(task => task.id));
  const optionIds = {
    status: new Set(project.statusOptions.map(option => option.id)),
    type: new Set(project.typeOptions.map(option => option.id)),
    priority: new Set(project.priorityOptions.map(option => option.id)),
    assignee: new Set(project.assigneeOptions.map(option => option.id)),
  };
  const versions = new Set<string>();
  const externalTaskIds = new Set<string>();
  const taskOrderKeys = new Set<string>();
  for (const task of tasks) {
    requireCondition(task.name.trim(), 'TASK_NAME', '任务名称不能为空。');
    const value = normalizeExternalTaskId(task.externalTaskId);
    requireCondition(value === task.externalTaskId, 'TASK_ID_NORMALIZATION', 'Task ID 必须先去除首尾空白，空值存为 null。');
    if (value !== null) {
      requireCondition(!externalTaskIds.has(value), 'DUPLICATE_TASK_ID', `Task ID 已被其他任务使用：${value}`);
      externalTaskIds.add(value);
    }
    requireCondition(task.statusOptionId === null || optionIds.status.has(task.statusOptionId), 'TASK_STATUS_REFERENCE', '任务引用的 Status 选项不存在。');
    requireCondition(task.typeOptionId === null || optionIds.type.has(task.typeOptionId), 'TASK_TYPE_REFERENCE', '任务引用的 Type 选项不存在。');
    requireCondition(task.priorityOptionId === null || optionIds.priority.has(task.priorityOptionId), 'TASK_PRIORITY_REFERENCE', '任务引用的 priority 选项不存在。');
    requireCondition(task.assigneeId === null || optionIds.assignee.has(task.assigneeId), 'TASK_ASSIGNEE_REFERENCE', '任务引用的 assignee 不存在。');
    requireCondition(Number.isSafeInteger(task.sortOrder) && task.sortOrder >= 0, 'TASK_ORDER', '任务顺序无效。');
    const orderKey = `${task.statusOptionId ?? ''}:${task.sortOrder}`;
    requireCondition(!taskOrderKeys.has(orderKey), 'TASK_ORDER_DUPLICATE', '同一 Status 泳道内的任务顺序不能重复。');
    taskOrderKeys.add(orderKey);
    requireCondition(task.startDate === null || isCalendarDate(task.startDate), 'TASK_START_DATE', '开始日期必须为有效的 YYYY-MM-DD 日期。');
    requireCondition(task.dueDate === null || isCalendarDate(task.dueDate), 'TASK_DUE_DATE', '截止日期必须为有效的 YYYY-MM-DD 日期。');
    requireCondition(task.startDate === null || task.dueDate === null || task.dueDate >= task.startDate, 'TASK_DATE_RANGE', '截止日期不能早于开始日期。');
    uniqueIds(task.comments, `任务 ${task.id} 的评论`);
    for (const comment of task.comments) {
      requireCondition(comment.text.trim(), 'TASK_COMMENT_EMPTY', '评论内容不能为空。');
      const createdAt = Date.parse(comment.createdAt);
      const updatedAt = Date.parse(comment.updatedAt);
      requireCondition(Number.isFinite(createdAt) && Number.isFinite(updatedAt) && updatedAt >= createdAt, 'TASK_COMMENT_TIME', '评论时间无效。');
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
    requireCondition(branch.order === undefined || (Number.isSafeInteger(branch.order) && branch.order >= 0), 'BRANCH_ORDER', '分支顺序无效。');
  }
  const explicitBranchOrders = branches.flatMap(branch => branch.order === undefined ? [] : [branch.order]);
  requireCondition(
    new Set(explicitBranchOrders).size === explicitBranchOrders.length,
    'BRANCH_ORDER',
    '分支顺序不能重复。',
  );
  requireCondition(
    explicitBranchOrders.length === 0 || explicitBranchOrders.length === branches.length,
    'BRANCH_ORDER',
    '分支顺序必须全部设置或全部留空。',
  );
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function updatePartNumber(graph: ProjectGraph, value: string): ProjectGraph {
  requireCondition(value.trim(), 'REQUIRED', '项目零件号不能为空。');
  const next = structuredClone(graph);
  next.project.partNumber = value.trim();
  validateTransition(graph, next);
  return next;
}

function reindexTaskLanes(tasks: Task[]): void {
  const lanes = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.statusOptionId ?? '';
    const lane = lanes.get(key) ?? [];
    lane.push(task);
    lanes.set(key, lane);
  }
  for (const lane of lanes.values()) {
    lane.sort((left, right) => left.sortOrder - right.sortOrder
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
    lane.forEach((task, sortOrder) => { task.sortOrder = sortOrder; });
  }
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
  const children = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of graph.edges) children.get(edge.parentId)!.push(edge.childId);
  const descendants = new Set<string>();
  const pending = [targetId];
  while (pending.length) {
    const id = pending.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...children.get(id)!);
  }
  const next = structuredClone(graph);
  for (const node of next.nodes) if (descendants.has(node.id)) node.releasedAt = null;
  validateGraph(next);
  return next;
}

export function updateTask(graph: ProjectGraph, task: Task): ProjectGraph {
  const next = structuredClone(graph);
  const normalized = { ...task, name: task.name.trim(), externalTaskId: normalizeExternalTaskId(task.externalTaskId) };
  const index = next.tasks.findIndex(item => item.id === task.id);
  if (index < 0) next.tasks.push(normalized);
  else next.tasks[index] = normalized;
  validateGraph(next);
  return next;
}

export function updateTasks(graph: ProjectGraph, tasks: readonly Task[]): ProjectGraph {
  const next = structuredClone(graph);
  const taskById = new Map(next.tasks.map((task, index) => [task.id, index]));
  for (const task of tasks) {
    requireCondition(task.projectId === graph.project.id, 'CROSS_PROJECT', '任务不能跨项目引用。');
    const index = taskById.get(task.id);
    requireCondition(index !== undefined, 'TASK_REFERENCE', `任务不存在：${task.id}`);
    next.tasks[index] = structuredClone(task);
  }
  validateGraph(next);
  return next;
}

export function updateTaskOptions(
  graph: ProjectGraph,
  options: Pick<ProjectGraph['project'], 'statusOptions' | 'typeOptions' | 'priorityOptions' | 'assigneeOptions'>,
): ProjectGraph {
  const next = structuredClone(graph);
  const validIds = {
    status: new Set(options.statusOptions.map(option => option.id)),
    type: new Set(options.typeOptions.map(option => option.id)),
    priority: new Set(options.priorityOptions.map(option => option.id)),
    assignee: new Set(options.assigneeOptions.map(option => option.id)),
  };
  Object.assign(next.project, structuredClone(options));
  for (const task of next.tasks) {
    if (task.statusOptionId && !validIds.status.has(task.statusOptionId)) task.statusOptionId = null;
    if (task.typeOptionId && !validIds.type.has(task.typeOptionId)) task.typeOptionId = null;
    if (task.priorityOptionId && !validIds.priority.has(task.priorityOptionId)) task.priorityOptionId = null;
    if (task.assigneeId && !validIds.assignee.has(task.assigneeId)) task.assigneeId = null;
  }
  reindexTaskLanes(next.tasks);
  validateGraph(next);
  return next;
}

export function deleteTask(graph: ProjectGraph, taskId: string): ProjectGraph {
  validateGraph(graph);
  requireCondition(graph.tasks.some(task => task.id === taskId), 'TASK_REFERENCE', '任务不存在。');
  const next = structuredClone(graph);
  next.tasks = next.tasks.filter(task => task.id !== taskId);
  for (const node of next.nodes) if (node.taskId === taskId) node.taskId = null;
  reindexTaskLanes(next.tasks);
  validateGraph(next);
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

export interface MultiDeletionPlan {
  nodeIds: string[];
  childParents: Record<string, string[]>;
  branchHeads: Record<string, string | null>;
}

export function planDeletionMany(graph: ProjectGraph, nodeIds: readonly string[]): MultiDeletionPlan {
  validateGraph(graph);
  const removed = new Set(nodeIds);
  requireCondition(removed.size > 0 && removed.size === nodeIds.length, 'DELETE_PLAN', '请选择一个或多个不同版本。');
  for (const id of removed) getNode(graph, id);

  const parents = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const children = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    parents.get(edge.childId)!.push(edge.parentId);
    children.get(edge.parentId)!.push(edge.childId);
  }
  const boundaryAncestors = (startId: string): Set<string> => {
    const result = new Set<string>();
    const pending = [...(parents.get(startId) ?? [])];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (!removed.has(id)) result.add(id);
      else pending.push(...(parents.get(id) ?? []));
    }
    return result;
  };
  const childParents: Record<string, string[]> = Object.create(null);
  for (const childId of graph.nodes.filter(node => !removed.has(node.id) && (parents.get(node.id) ?? []).some(id => removed.has(id))).map(node => node.id)) {
    const nextParents = new Set((parents.get(childId) ?? []).filter(id => !removed.has(id)));
    for (const parentId of parents.get(childId) ?? []) {
      if (removed.has(parentId)) {
        for (const ancestorId of boundaryAncestors(parentId)) nextParents.add(ancestorId);
      }
    }
    childParents[childId] = [...nextParents];
  }
  return {
    nodeIds: [...removed],
    childParents,
    branchHeads: Object.fromEntries(graph.branches.filter(branch => removed.has(branch.headId)).map(branch => [branch.id, null])),
  };
}

export function applyDeletionMany(
  graph: ProjectGraph,
  plan: MultiDeletionPlan,
  confirmedVersions: Readonly<Record<string, string>>,
): ProjectGraph {
  validateGraph(graph);
  const expected = planDeletionMany(graph, plan.nodeIds);
  requireCondition(
    JSON.stringify([...Object.keys(expected.childParents)].sort()) === JSON.stringify([...Object.keys(plan.childParents)].sort())
    && JSON.stringify(Object.keys(expected.branchHeads).sort()) === JSON.stringify(Object.keys(plan.branchHeads).sort()),
    'DELETE_PLAN', '删除预览已变化，请重新预览。',
  );
  const removed = new Set(plan.nodeIds);
  for (const id of removed) {
    const node = getNode(graph, id);
    if (node.releasedAt !== null) {
      requireCondition(confirmedVersions[id] === node.version, 'DELETE_CONFIRMATION', `删除已放行版本需输入版本号确认：${node.version}`);
    }
  }
  for (const childId of Object.keys(plan.childParents)) {
    const child = getNode(graph, childId);
    requireCondition(child.releasedAt === null, 'RELEASE_LOCK', '重连不能修改已放行子节点的父边。');
  }
  for (const [branchId, headId] of Object.entries(plan.branchHeads)) {
    const branch = graph.branches.find(item => item.id === branchId);
    requireCondition(branch && removed.has(branch.headId), 'BRANCH_REPLACEMENT', '删除预览中的分支头已变化。');
    requireCondition(headId === null || (!removed.has(headId) && graph.nodes.some(node => node.id === headId)), 'BRANCH_REPLACEMENT', '分支新头必须是未删除的现有版本，或明确删除分支。');
  }
  const next = structuredClone(graph);
  next.nodes = next.nodes.filter(node => !removed.has(node.id));
  const affectedChildren = new Set(Object.keys(plan.childParents));
  next.edges = next.edges.filter(edge => !removed.has(edge.parentId) && !removed.has(edge.childId) && !affectedChildren.has(edge.childId));
  for (const [childId, parentIds] of Object.entries(plan.childParents)) {
    for (const parentId of parentIds) {
      next.edges.push({ id: crypto.randomUUID(), projectId: graph.project.id, parentId, childId });
    }
  }
  next.branches = next.branches.flatMap(branch => {
    if (!removed.has(branch.headId)) return [branch];
    const headId = plan.branchHeads[branch.id];
    return headId ? [{ ...branch, headId }] : [];
  });
  validateGraph(next);
  return next;
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
    requireCondition(node.version === updated.version,
      'RELEASE_LOCK', '已放行版本的版本号已锁定，请先撤销放行。');
  }
}

export function createBranch(graph: ProjectGraph, branch: ProjectGraph['branches'][number]): ProjectGraph {
  const next = structuredClone(graph);
  const branches = orderedBranches(next.branches);
  next.branches = [
    ...branches.map((item, order) => ({ ...item, order })),
    { ...structuredClone(branch), order: branches.length },
  ];
  validateGraph(next);
  return next;
}

export function reorderBranches(graph: ProjectGraph, branchIds: readonly string[]): ProjectGraph {
  validateGraph(graph);
  const branches = orderedBranches(graph.branches);
  const availableIds = new Set(branches.map(branch => branch.id));
  requireCondition(
    branchIds.length === branches.length
      && new Set(branchIds).size === branches.length
      && branchIds.every(id => availableIds.has(id)),
    'BRANCH_ORDER',
    '分支顺序必须且只能包含项目中的全部分支。',
  );
  const orderById = new Map(branchIds.map((id, index) => [id, index]));
  const next = structuredClone(graph);
  next.branches = branches
    .map(branch => ({ ...branch, order: orderById.get(branch.id)! }))
    .sort((a, b) => a.order! - b.order!);
  validateGraph(next);
  return next;
}

export function deleteBranch(graph: ProjectGraph, branchId: string): ProjectGraph {
  validateGraph(graph);
  requireCondition(graph.branches.some(branch => branch.id === branchId), 'BRANCH_REFERENCE', '分支不存在。');
  const next = structuredClone(graph);
  next.branches = next.branches.filter(branch => branch.id !== branchId);
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

export function setNodeParents(graph: ProjectGraph, childId: string, parentIds: readonly string[]): ProjectGraph {
  validateGraph(graph);
  const child = getNode(graph, childId);
  requireCondition(new Set(parentIds).size === parentIds.length, 'DUPLICATE_PARENT', '父节点不能重复。');
  const currentParents = graph.edges.filter(edge => edge.childId === childId).map(edge => edge.parentId);
  if (currentParents.length === parentIds.length && currentParents.every(id => parentIds.includes(id))) {
    return structuredClone(graph);
  }
  for (const id of parentIds) {
    requireCondition(id !== childId, 'SELF_PARENT', '版本不能成为自己的父节点。');
    getNode(graph, id);
  }
  const next = structuredClone(graph);
  const retained = new Map(
    next.edges.filter(edge => edge.childId === childId).map(edge => [edge.parentId, edge]),
  );
  next.edges = next.edges.filter(edge => edge.childId !== childId);
  for (const parentId of parentIds) {
    next.edges.push(retained.get(parentId) ?? {
      id: crypto.randomUUID(), projectId: graph.project.id, parentId, childId,
    });
  }
  if (child.releasedAt !== null) {
    const parents = new Map(next.nodes.map(node => [node.id, [] as string[]]));
    for (const edge of next.edges) parents.get(edge.childId)?.push(edge.parentId);
    const ancestorIds = new Set<string>();
    const pending = [childId];
    while (pending.length) {
      const ancestorId = pending.pop()!;
      if (ancestorIds.has(ancestorId)) continue;
      ancestorIds.add(ancestorId);
      pending.push(...(parents.get(ancestorId) ?? []));
    }
    for (const ancestorId of ancestorIds) {
      const ancestor = getNode(next, ancestorId);
      if (ancestor.releasedAt === null) ancestor.releasedAt = child.releasedAt;
    }
  }
  validateTransition(graph, next);
  return next;
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
  headId?: string;
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
  if (update.headId !== undefined) target.headId = update.headId;
  if (update.name !== undefined) target.name = update.name.trim();
  if (update.description !== undefined) target.description = update.description.trim();
  if (update.color !== undefined) target.color = update.color;
  validateGraph(next);
  return next;
}
