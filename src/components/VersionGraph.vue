<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { liveQuery } from 'dexie';
import type { Branch, ProjectGraph, VersionNode } from '../domain/model';
import type { ArchiveRepository } from '../storage/database';
import { layoutGitGraph, GIT_GRAPH, recommendedParentNodes, type GitGraphEdge } from '../domain/git-graph';
import { planDeletionMany, type MultiDeletionPlan } from '../domain/graph';
import { compareVersions, type VersionOrder } from '../domain/version-order';
import AppIcon from './AppIcon.vue';
import ParentVersionPicker from './ParentVersionPicker.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string }>();
const versionOrder = defineModel<VersionOrder>('versionOrder', { default: 'oldest' });
const emit = defineEmits<{ busy: [value: boolean] }>();

const graph = shallowRef<ProjectGraph>();
const error = ref('');
const status = ref('');
const saving = ref(false);
const errorHeading = ref<HTMLElement>();
const graphScroller = ref<HTMLDivElement>();
const menuElement = ref<HTMLDivElement>();
const editorSidebar = ref<HTMLElement>();
const scale = ref(1);
const selectedNodeIds = ref<string[]>([]);
const branchFilter = ref<string[] | null>(null);
const branchFilterDetails = ref<HTMLDetailsElement>();
const branchQuery = ref('');
const filteredBranches = computed(() => (graph.value?.branches ?? [])
  .filter(branch => branch.name.toLocaleLowerCase().includes(branchQuery.value.trim().toLocaleLowerCase())));
const branchFilterLabel = computed(() => {
  if (branchFilter.value === null) return '显示全部分支';
  const selected = graph.value?.branches.filter(branch => branchFilter.value?.includes(branch.id)) ?? [];
  return selected.length ? selected.map(branch => branch.name).join('、') : '未选择分支';
});

function toggleBranchFilter(id: string) {
  const selected = branchFilter.value ?? graph.value?.branches.map(branch => branch.id) ?? [];
  branchFilter.value = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
}

function closeBranchFilter(event: Event) {
  if (event.target instanceof Node && !branchFilterDetails.value?.contains(event.target) && branchFilterDetails.value) {
    branchFilterDetails.value.open = false;
  }
}
const activeBranchId = ref<string | null>(null);
const menu = ref<{ kind: 'node' | 'branch'; id: string; x: number; y: number } | null>(null);
const menuReturnFocus = ref<HTMLElement | null>(null);
const panel = ref<'node-add' | 'node-edit' | 'parent-edit' | 'merge' | 'branch-add' | 'branch-edit' | null>(null);
const branchDeleteTarget = ref<string | null>(null);
const deletionPlan = ref<MultiDeletionPlan | null>(null);
const deletionChildParentChoices = ref<Record<string, string[]>>({});
const deletionBranchChoices = ref<Record<string, string>>({});
const deletionConfirmations = ref<Record<string, string>>({});
const nodeForm = ref({ version: '', description: '', parentIds: [] as string[], targetBranchId: '' });
const branchForm = ref({ id: '', name: '', description: '', color: '#2563eb', headId: '' });
const branchEditRevision = ref(0);
const editorOpen = computed(() => !!(panel.value || branchDeleteTarget.value || deletionPlan.value));
const branchMoveDialog = ref<HTMLDialogElement>();
const draggedBranch = ref<{ branchId: string; headId: string; revision: number } | null>(null);
const dropTargetId = ref<string | null>(null);
const pendingBranchMove = ref<{ branchId: string; headId: string; revision: number; targetId: string; name: string } | null>(null);
const branchHeadOptions = computed(() => [...(graph.value?.nodes ?? [])]
  .sort((a, b) => compareVersions(a.version, b.version)));

watch(pendingBranchMove, async value => {
  await nextTick();
  if (value) branchMoveDialog.value?.showModal();
  else branchMoveDialog.value?.close();
});

function startBranchDrag(event: DragEvent, branch: Branch) {
  if (saving.value || editorOpen.value || !event.dataTransfer || !graph.value) {
    event.preventDefault();
    return;
  }
  draggedBranch.value = { branchId: branch.id, headId: branch.headId, revision: graph.value.project.revision };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', branch.name);
  closeMenu(false);
}

function endBranchDrag() {
  draggedBranch.value = null;
  dropTargetId.value = null;
}

function onBranchDragOver(event: DragEvent, nodeId: string) {
  if (!draggedBranch.value || saving.value || draggedBranch.value.headId === nodeId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropTargetId.value = nodeId;
}

function dropBranch(event: DragEvent, targetId: string) {
  const drag = draggedBranch.value;
  const branch = graph.value?.branches.find(item => item.id === drag?.branchId);
  if (!drag || !branch || saving.value || drag.headId === targetId) return;
  event.preventDefault();
  pendingBranchMove.value = { ...drag, targetId, name: branch.name };
  endBranchDrag();
}

async function confirmBranchMove() {
  const move = pendingBranchMove.value;
  if (!move || saving.value) return;
  await operation(`移动分支 ${move.name}`, async () => {
    graph.value = await props.repository.saveBranch(props.projectId, move.revision, move.branchId, { headId: move.targetId });
    status.value = `分支“${move.name}”指针已更新。`;
  });
  pendingBranchMove.value = null;
  graphScroller.value?.focus({ preventScroll: true });
}

function updateSidebarHeight() {
  const sidebar = editorSidebar.value;
  if (!sidebar) return;
  const top = Math.max(16, sidebar.getBoundingClientRect().top);
  sidebar.style.setProperty('--sidebar-available-height', `${Math.max(120, window.innerHeight - top - 16)}px`);
}

function closeEditor() {
  if (saving.value) return;
  panel.value = null;
  branchDeleteTarget.value = null;
  deletionPlan.value = null;
}

function onSidebarFocusOut(event: FocusEvent) {
  if (editorOpen.value && window.matchMedia('(max-width: 1100px)').matches
    && event.relatedTarget instanceof Node && !editorSidebar.value?.contains(event.relatedTarget)) closeEditor();
}

interface UndoEntry {
  before: ProjectGraph;
  afterRevision: number;
  label: string;
}

const undoHistory = ref<UndoEntry[]>([]);
const redoHistory = ref<UndoEntry[]>([]);
const undoAvailable = computed(() => {
  const last = undoHistory.value.at(-1);
  return !!last && !saving.value && graph.value?.project.revision === last.afterRevision;
});
const undoLabel = computed(() => undoHistory.value.at(-1)?.label ?? '');
const redoAvailable = computed(() => {
  const last = redoHistory.value.at(-1);
  return !!last && !saving.value && graph.value?.project.revision === last.afterRevision;
});

function clearHistory() {
  undoHistory.value = [];
  redoHistory.value = [];
}

function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '图操作失败，请重试。';
  status.value = '';
  void nextTick(() => {
    if (editorOpen.value && editorSidebar.value) editorSidebar.value.scrollTop = 0;
    errorHeading.value?.focus({ preventScroll: editorOpen.value });
  });
}

const subscription = liveQuery(() => props.repository.get(props.projectId)).subscribe({
  next: value => {
    const previousRevision = graph.value?.project.revision;
    if (previousRevision !== undefined && value.project.revision !== previousRevision
      && !saving.value && (undoHistory.value.length || redoHistory.value.length)
      && value.project.revision !== (undoHistory.value.at(-1) ?? redoHistory.value.at(-1))?.afterRevision) {
      clearHistory();
      status.value = '版本图已在其他标签页更新，撤销和重做记录已清除。';
    }
    graph.value = value;
  },
  error: cause => showError(cause),
});
onUnmounted(() => subscription.unsubscribe());

const graphLayout = computed(() => graph.value
  ? layoutGitGraph(graph.value, versionOrder.value, branchFilter.value)
  : null);
const displayHeight = computed(() => Math.max(420, (graphLayout.value?.height ?? 0) + 40));
const selectedNodes = computed(() => {
  const nodes = new Map((graph.value?.nodes ?? []).map(node => [node.id, node]));
  return selectedNodeIds.value.flatMap(id => nodes.has(id) ? [nodes.get(id)!] : []);
});
const selectedNode = computed(() => selectedNodes.value.length === 1 ? selectedNodes.value[0] : undefined);
const selectedBranch = computed(() => graph.value?.branches.find(branch => branch.id === activeBranchId.value));
const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map(node => [node.id, node])));
const parentIdsOf = computed(() => {
  const parents = new Map((graph.value?.nodes ?? []).map(node => [node.id, [] as string[]]));
  for (const edge of graph.value?.edges ?? []) parents.get(edge.childId)?.push(edge.parentId);
  return parents;
});
const childIdsOf = computed(() => {
  const children = new Map((graph.value?.nodes ?? []).map(node => [node.id, [] as string[]]));
  for (const edge of graph.value?.edges ?? []) children.get(edge.parentId)?.push(edge.childId);
  return children;
});
const parentTarget = computed(() => panel.value === 'parent-edit' ? selectedNode.value?.version : nodeForm.value.version);
const parentExcludedId = computed(() => panel.value === 'parent-edit' ? selectedNode.value?.id ?? null : null);
const rankedParentOptions = computed(() => {
  if (!graph.value || !parentTarget.value) return [];
  return recommendedParentNodes(graph.value, parentTarget.value, parentExcludedId.value)
    .filter(node => !nodeForm.value.parentIds.includes(node.id));
});
const parentSelectionUnchanged = computed(() => {
  if (!selectedNode.value) return true;
  const current = [...(parentIdsOf.value.get(selectedNode.value.id) ?? [])].sort();
  const updated = [...nodeForm.value.parentIds].sort();
  return current.length === updated.length && current.every((id, index) => id === updated[index]);
});
const releasedDeletionNodes = computed(() => {
  if (!deletionPlan.value || !graph.value) return [];
  return deletionPlan.value.nodeIds.flatMap(id => {
    const node = nodeById.value.get(id);
    return node?.releasedAt ? [node] : [];
  });
});
const deletionReady = computed(() => {
  if (!deletionPlan.value) return false;
  const branchChoicesReady = Object.values(deletionBranchChoices.value).every(value => value !== '');
  const confirmationsReady = releasedDeletionNodes.value.every(node => deletionConfirmations.value[node.id] === node.version);
  const childrenAreEditable = Object.keys(deletionPlan.value.childParents)
    .every(id => nodeById.value.get(id)?.releasedAt === null);
  return branchChoicesReady && confirmationsReady && childrenAreEditable && !saving.value;
});
const laneWidth = computed(() => graphLayout.value?.trackWidth ?? 0);
const canvasWidth = computed(() => (graphLayout.value?.width ?? 0) + 300);
const contentHeight = computed(() => Math.max(40, (graphLayout.value?.height ?? 0) + 40));

function clearSelectionsForFilter() {
  const visible = new Set(graphLayout.value?.rows.map(row => row.node.id) ?? []);
  selectedNodeIds.value = selectedNodeIds.value.filter(id => visible.has(id));
  if (!graphLayout.value?.branchTracks.some(branch => branch.id === activeBranchId.value)) activeBranchId.value = null;
  menu.value = null;
}
watch(branchFilter, clearSelectionsForFilter);
watch(menu, value => {
  if (value) void nextTick(() => menuElement.value?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
});
watch([panel, branchDeleteTarget, deletionPlan], async ([nextPanel, nextBranchDelete, nextDeletion], [previousPanel, previousBranchDelete, previousDeletion]) => {
  await nextTick();
  if (nextPanel || nextBranchDelete || nextDeletion) {
    const sidebar = editorSidebar.value;
    if (!sidebar) return;
    updateSidebarHeight();
    sidebar.scrollTop = 0;
    const target = sidebar.querySelector<HTMLElement>('.graph-form input:not(:disabled), .graph-form textarea:not(:disabled), .graph-form select:not(:disabled)')
      ?? sidebar.querySelector<HTMLElement>('.graph-form h3');
    target?.focus({ preventScroll: true });
  } else if (previousPanel || previousBranchDelete || previousDeletion) {
    graphScroller.value?.focus({ preventScroll: true });
  }
});
watch(panel, value => {
  if (!value) return;
  branchDeleteTarget.value = null;
  deletionPlan.value = null;
});
watch(() => props.projectId, () => {
  pendingBranchMove.value = null;
  endBranchDrag();
  selectedNodeIds.value = [];
  activeBranchId.value = null;
  branchFilter.value = null;
  branchQuery.value = '';
  if (branchFilterDetails.value) branchFilterDetails.value.open = false;
  clearHistory();
  void refresh();
});

async function operation(label: string, action: () => Promise<void>, recordUndo = true) {
  const before = graph.value ? structuredClone(graph.value) : null;
  saving.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '';
  try {
    await action();
    const after = graph.value;
    if (recordUndo && before && after && after.project.revision > before.project.revision) {
      redoHistory.value = [];
      undoHistory.value.push({ before, afterRevision: after.project.revision, label });
      if (undoHistory.value.length > 50) undoHistory.value.shift();
    }
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
    emit('busy', false);
    const last = undoHistory.value.at(-1) ?? redoHistory.value.at(-1);
    if (last && graph.value && graph.value.project.revision !== last.afterRevision) {
      clearHistory();
      status.value = '版本图已在其他标签页更新，撤销和重做记录已清除。请确认最新状态后继续。';
    }
  }
}

async function refresh() {
  await operation('', async () => {
    graph.value = await props.repository.get(props.projectId);
    selectedNodeIds.value = [];
    activeBranchId.value = null;
    menu.value = null;
    panel.value = null;
    branchDeleteTarget.value = null;
  }, false);
}

async function undo() {
  await restoreHistory(false);
}

async function restoreHistory(redo: boolean) {
  const source = redo ? redoHistory.value : undoHistory.value;
  const destination = redo ? undoHistory.value : redoHistory.value;
  const label = redo ? '重做' : '撤销';
  const entry = source.at(-1);
  const current = graph.value;
  if (!entry || !current || saving.value) return;
  if (current.project.revision !== entry.afterRevision) {
    clearHistory();
    showError(new Error(`其他标签页已更新项目，${label}已取消；请重新读取版本图后重试。`));
    return;
  }
  saving.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '';
  try {
    const before = structuredClone(current);
    graph.value = await props.repository.restoreUndo(props.projectId, current.project.revision, entry.before);
    source.pop();
    destination.push({ before, afterRevision: graph.value.project.revision, label: entry.label });
    for (const history of [source, destination]) {
      const previous = history.at(-1);
      if (previous) previous.afterRevision = graph.value.project.revision;
    }
    selectedNodeIds.value = [];
    activeBranchId.value = null;
    status.value = `已${label}：${entry.label}`;
  } catch (cause) {
    clearHistory();
    showError(cause);
  } finally {
    saving.value = false;
    emit('busy', false);
  }
}

function onGlobalKeyDown(event: KeyboardEvent) {
  if (pendingBranchMove.value) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (key === 'z' || key === 'y')) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (key === 'z' ? !undoAvailable.value : !redoAvailable.value) return;
    event.preventDefault();
    void restoreHistory(key === 'y');
  }
  if (event.key === 'Escape') {
    if (menu.value) {
      closeMenu();
      return;
    }
    if (!saving.value) {
      panel.value = null;
      branchDeleteTarget.value = null;
      deletionPlan.value = null;
    }
  }
}

function closeMenu(restoreFocus = true) {
  menu.value = null;
  const target = menuReturnFocus.value;
  menuReturnFocus.value = null;
  if (restoreFocus && target) void nextTick(() => target.focus());
}

function onMenuKeyDown(event: KeyboardEvent) {
  const menuItems = [...(menuElement.value?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  if (!menuItems.length) return;
  const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
  let nextIndex: number | null = null;
  if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % menuItems.length;
  else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = menuItems.length - 1;
  if (nextIndex !== null) {
    event.preventDefault();
    menuItems[nextIndex]?.focus();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown);
  window.addEventListener('pointerdown', closeBranchFilter);
  window.addEventListener('resize', updateSidebarHeight);
  window.addEventListener('scroll', updateSidebarHeight, { passive: true });
  void refresh();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeyDown);
  window.removeEventListener('pointerdown', closeBranchFilter);
  window.removeEventListener('resize', updateSidebarHeight);
  window.removeEventListener('scroll', updateSidebarHeight);
});

function zoomAt(factor: number, clientX?: number, clientY?: number) {
  const scroller = graphScroller.value;
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const pointX = clientX === undefined ? rect.left + rect.width / 2 : clientX;
  const pointY = clientY === undefined ? rect.top + rect.height / 2 : clientY;
  const localX = pointX - rect.left;
  const localY = pointY - rect.top;
  const contentX = (scroller.scrollLeft + localX) / scale.value;
  const contentY = (scroller.scrollTop + localY) / scale.value;
  const previous = scale.value;
  scale.value = Math.max(0.45, Math.min(2.5, previous * factor));
  void nextTick(() => {
    scroller.scrollLeft = Math.max(0, contentX * scale.value - localX);
    scroller.scrollTop = Math.max(0, contentY * scale.value - localY);
  });
}

function resetZoom() {
  scale.value = 1;
  void nextTick(() => {
    if (graphScroller.value) {
      graphScroller.value.scrollLeft = 0;
      graphScroller.value.scrollTop = 0;
    }
  });
}

function onWheel(event: WheelEvent) {
  const scroller = graphScroller.value;
  if (!scroller) return;
  if (event.shiftKey && !event.ctrlKey) {
    event.preventDefault();
    scroller.scrollLeft += event.deltaY || event.deltaX;
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.1 : 0.9, event.clientX, event.clientY);
  }
}

function edgePath(edge: GitGraphEdge): string {
  const startX = GIT_GRAPH.laneStart + edge.fromLane * GIT_GRAPH.laneGap;
  const endX = GIT_GRAPH.laneStart + edge.toLane * GIT_GRAPH.laneGap;
  const startY = 40 + edge.fromRow * GIT_GRAPH.rowHeight + GIT_GRAPH.rowHeight / 2;
  const endY = 40 + edge.toRow * GIT_GRAPH.rowHeight + GIT_GRAPH.rowHeight / 2;
  if (startX === endX) return `M ${startX} ${startY} L ${endX} ${endY}`;
  const midY = (startY + endY) / 2;
  return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
}

function nodeColor(node: VersionNode): string {
  const branches = graphLayout.value?.memberships.get(node.id) ?? [];
  return branches[0]?.color ?? '#8799b2';
}

function selectNode(nodeId: string, additive: boolean) {
  if (additive) {
    selectedNodeIds.value = selectedNodeIds.value.includes(nodeId)
      ? selectedNodeIds.value.filter(id => id !== nodeId)
      : [...selectedNodeIds.value, nodeId];
  } else {
    selectedNodeIds.value = [nodeId];
  }
  activeBranchId.value = null;
  menu.value = null;
}

function openNodeMenu(event: MouseEvent, nodeId: string) {
  event.preventDefault();
  menuReturnFocus.value = event.currentTarget as HTMLElement;
  if (!selectedNodeIds.value.includes(nodeId)) selectedNodeIds.value = [nodeId];
  activeBranchId.value = null;
  const rect = graphScroller.value!.getBoundingClientRect();
  menu.value = {
    kind: 'node',
    id: nodeId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function selectBranch(branchId: string) {
  activeBranchId.value = branchId;
  selectedNodeIds.value = [];
  closeMenu(false);
}

function openBranchMenu(event: MouseEvent, branchId: string) {
  event.preventDefault();
  event.stopPropagation();
  menuReturnFocus.value = event.currentTarget as HTMLElement;
  selectBranch(branchId);
  const rect = graphScroller.value!.getBoundingClientRect();
  menu.value = {
    kind: 'branch',
    id: branchId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function openNodeAdd(parentIds: readonly string[] = []) {
  nodeForm.value = { version: '', description: '', parentIds: [...parentIds], targetBranchId: '' };
  panel.value = 'node-add';
  closeMenu(false);
}

function openNodeEdit() {
  if (!selectedNode.value) return;
  nodeForm.value = {
    version: selectedNode.value.version,
    description: selectedNode.value.description,
    parentIds: [],
    targetBranchId: '',
  };
  panel.value = 'node-edit';
}

function openParentEdit() {
  if (!selectedNode.value || selectedNode.value.releasedAt) return;
  nodeForm.value = {
    version: selectedNode.value.version,
    description: selectedNode.value.description,
    parentIds: [...(parentIdsOf.value.get(selectedNode.value.id) ?? [])],
    targetBranchId: '',
  };
  panel.value = 'parent-edit';
}

function openMerge() {
  nodeForm.value = { version: '', description: '', parentIds: [...selectedNodeIds.value], targetBranchId: '' };
  panel.value = 'merge';
}

function addParentCandidate(id: string) {
  if (saving.value || !rankedParentOptions.value.some(node => node.id === id)) return;
  nodeForm.value.parentIds.push(id);
}

function removeParent(parentId: string) {
  nodeForm.value.parentIds = nodeForm.value.parentIds.filter(id => id !== parentId);
  const targetBranch = graph.value?.branches.find(branch => branch.id === nodeForm.value.targetBranchId);
  if (targetBranch && !nodeForm.value.parentIds.includes(targetBranch.headId)) nodeForm.value.targetBranchId = '';
}

function deletionParentCandidates(childId: string): VersionNode[] {
  const child = nodeById.value.get(childId);
  if (!graph.value || !child || !deletionPlan.value) return [];
  return recommendedParentNodes(graph.value, child.version, child.id)
    .filter(node => !deletionPlan.value!.nodeIds.includes(node.id));
}

async function submitNode() {
  await operation(panel.value === 'node-edit' ? '编辑版本' : panel.value === 'merge' ? '合并版本' : '新增版本', async () => {
    const current = graph.value!;
    if (panel.value === 'node-add') {
      const node = createNode(current, nodeForm.value);
      graph.value = await props.repository.addNode(
        props.projectId, current.project.revision, node, nodeForm.value.parentIds, nodeForm.value.targetBranchId || null,
      );
      status.value = '版本已新增。';
    } else if (panel.value === 'node-edit') {
      graph.value = await props.repository.saveNode(props.projectId, current.project.revision, selectedNode.value!.id, {
        version: nodeForm.value.version,
        description: nodeForm.value.description,
      });
      status.value = '版本已更新。';
    } else if (panel.value === 'merge') {
      const node = createNode(current, nodeForm.value);
      graph.value = await props.repository.merge(
        props.projectId, current.project.revision, node, nodeForm.value.parentIds, nodeForm.value.targetBranchId,
      );
      status.value = '合并版本已创建。';
    } else {
      return;
    }
    panel.value = null;
    selectedNodeIds.value = [];
  });
}

function createNode(current: ProjectGraph, form: typeof nodeForm.value): VersionNode {
  return {
    id: crypto.randomUUID(),
    projectId: current.project.id,
    version: form.version.trim(),
    description: form.description.trim(),
    taskId: null,
    releasedAt: null,
  };
}

async function submitParentEdit() {
  if (!selectedNode.value) return;
  await operation('设置父版本', async () => {
    const current = graph.value!;
    graph.value = await props.repository.saveNodeParents(
      props.projectId, current.project.revision, selectedNode.value!.id, nodeForm.value.parentIds,
    );
    status.value = '父版本已更新。';
    panel.value = null;
  });
}

function openBranchAdd(headId: string) {
  branchForm.value = { id: '', name: '', description: '', color: '#2563eb', headId };
  panel.value = 'branch-add';
  closeMenu(false);
}

function openBranchEdit() {
  const branch = selectedBranch.value;
  if (!branch) return;
  branchForm.value = { ...branch };
  branchEditRevision.value = graph.value!.project.revision;
  panel.value = 'branch-edit';
}

async function submitBranch() {
  await operation(panel.value === 'branch-add' ? '创建分支' : '编辑分支', async () => {
    const current = graph.value!;
    if (panel.value === 'branch-add') {
      const branch: Branch = {
        ...branchForm.value,
        id: crypto.randomUUID(),
        projectId: current.project.id,
        name: branchForm.value.name.trim(),
        description: branchForm.value.description.trim(),
      };
      graph.value = await props.repository.addBranch(props.projectId, current.project.revision, branch);
      activeBranchId.value = branch.id;
      status.value = `分支“${branch.name}”已创建。`;
    } else if (panel.value === 'branch-edit') {
      graph.value = await props.repository.saveBranch(props.projectId, branchEditRevision.value, branchForm.value.id, {
        headId: branchForm.value.headId,
        name: branchForm.value.name,
        description: branchForm.value.description,
        color: branchForm.value.color,
      });
      status.value = '分支信息已更新。';
    }
    panel.value = null;
  });
}

async function releaseBranch() {
  const branch = selectedBranch.value;
  if (!branch) return;
  await operation(`放行分支 ${branch.name}`, async () => {
    const current = graph.value!;
    graph.value = await props.repository.release(props.projectId, current.project.revision, branch.headId);
    status.value = `分支“${branch.name}”的头节点及全部祖先已放行。`;
  });
}

async function releaseSelectedNode() {
  if (!selectedNode.value) return;
  const node = selectedNode.value;
  await operation(node.releasedAt ? '撤销版本放行' : '放行版本', async () => {
    const current = graph.value!;
    graph.value = node.releasedAt
      ? await props.repository.revoke(props.projectId, current.project.revision, node.id)
      : await props.repository.release(props.projectId, current.project.revision, node.id);
    status.value = node.releasedAt ? '放行已撤销。' : '版本及全部祖先已放行。';
  });
}

function openDeletion() {
  const current = graph.value;
  if (!current || selectedNodeIds.value.length === 0) return;
  deletionPlan.value = planDeletionMany(current, selectedNodeIds.value);
  deletionChildParentChoices.value = Object.fromEntries(
    Object.entries(deletionPlan.value.childParents).map(([id, parents]) => [id, [...parents]]),
  );
  deletionBranchChoices.value = Object.fromEntries(Object.keys(deletionPlan.value.branchHeads).map(id => [id, '']));
  deletionConfirmations.value = Object.fromEntries(
    deletionPlan.value.nodeIds
      .filter(id => nodeById.value.get(id)?.releasedAt)
      .map(id => [id, '']),
  );
  panel.value = null;
  branchDeleteTarget.value = null;
  closeMenu(false);
}

async function confirmDeletion() {
  const plan = deletionPlan.value;
  if (!plan) return;
  await operation(plan.nodeIds.length > 1 ? '删除多个版本' : '删除版本', async () => {
    const current = graph.value!;
    const branchHeads = Object.fromEntries(Object.entries(deletionBranchChoices.value).map(([id, value]) => [
      id, value === '__delete__' ? null : value,
    ]));
    graph.value = await props.repository.deleteNodes(
      props.projectId, current.project.revision,
      { ...plan, childParents: deletionChildParentChoices.value, branchHeads },
      deletionConfirmations.value,
    );
    status.value = `已删除 ${plan.nodeIds.length} 个版本，并按预览更新关系。`;
    deletionPlan.value = null;
    selectedNodeIds.value = [];
  });
}

async function confirmBranchDelete() {
  const branch = graph.value?.branches.find(item => item.id === branchDeleteTarget.value);
  if (!branch) return;
  await operation(`删除分支 ${branch.name}`, async () => {
    const current = graph.value!;
    graph.value = await props.repository.deleteBranch(props.projectId, current.project.revision, branch.id);
    activeBranchId.value = null;
    if (branchFilter.value !== null) branchFilter.value = branchFilter.value.filter(id => id !== branch.id);
    branchDeleteTarget.value = null;
    status.value = `分支“${branch.name}”已删除；版本及父子关系保留。`;
  });
}

function openBranchDelete() {
  if (!selectedBranch.value) return;
  panel.value = null;
  deletionPlan.value = null;
  branchDeleteTarget.value = selectedBranch.value.id;
  closeMenu(false);
}

function startNodeAction(action: 'add' | 'edit' | 'parents' | 'release' | 'delete' | 'branch' | 'merge') {
  const count = selectedNodeIds.value.length;
  if (action === 'add') openNodeAdd(count === 1 ? selectedNodeIds.value : []);
  else if (action === 'edit' && count === 1) openNodeEdit();
  else if (action === 'parents' && count === 1) openParentEdit();
  else if (action === 'release' && count === 1) void releaseSelectedNode();
  else if (action === 'delete' && count > 0) openDeletion();
  else if (action === 'branch' && count === 1) openBranchAdd(selectedNodeIds.value[0]!);
  else if (action === 'merge' && count >= 2) openMerge();
}
</script>

<template>
  <section class="panel graph-workspace" aria-labelledby="graph-title" :aria-busy="saving">
    <div class="section-heading">
      <div><p class="eyebrow">VERSION GRAPH</p><h2 id="graph-title">版本分支图</h2></div>
      <div class="actions">
        <button class="secondary icon-button" :disabled="saving" aria-label="缩小图形" title="缩小图形" @click="zoomAt(0.85)"><AppIcon name="zoom-out" /></button>
        <button class="secondary icon-button" :disabled="saving" aria-label="放大图形" title="放大图形" @click="zoomAt(1.15)"><AppIcon name="zoom-in" /></button>
        <button class="secondary icon-button" :disabled="saving" aria-label="回到画布顶部并重置缩放" title="回到画布顶部并重置缩放" @click="resetZoom"><AppIcon name="fit" /></button>
        <button class="secondary icon-button" :disabled="saving" aria-label="重新读取图" title="重新读取图" @click="refresh"><AppIcon name="refresh" /></button>
      </div>
    </div>

    <div v-if="error && !graph" role="alert" class="error"><h3 ref="errorHeading" tabindex="-1">图操作未完成</h3><p>{{ error }}</p></div>

    <div v-if="graph" class="graph-meta">
      <span><strong>{{ graph.project.name }}</strong> · 零件号 <code>{{ graph.project.partNumber }}</code></span>
      <span class="count">{{ graph.nodes.length }} 个版本 · {{ graph.branches.length }} 个分支</span>
    </div>

    <div v-if="graph" class="graph-toolbar">
      <div class="graph-toolbar-row">
        <div class="graph-filter">
          <span id="branch-filter-label">分支范围</span>
          <details ref="branchFilterDetails" class="branch-filter-picker" @keydown.esc.stop.prevent="branchFilterDetails!.open = false; branchFilterDetails!.querySelector('summary')?.focus()">
            <summary aria-labelledby="branch-filter-label branch-filter-value" :title="branchFilterLabel"><span id="branch-filter-value">{{ branchFilterLabel }}</span><span aria-hidden="true">▾</span></summary>
            <div class="branch-filter-popover">
              <label for="branch-filter-search">搜索分支</label>
              <input id="branch-filter-search" v-model="branchQuery" type="search" placeholder="按名称筛选…" />
              <div class="branch-filter-commands">
                <button class="secondary" :disabled="saving" @click="branchFilter = null">显示全部</button>
                <button class="secondary" :disabled="saving" @click="branchFilter = []">全不选</button>
              </div>
              <div class="branch-filter-options" role="group" aria-label="选择显示的分支">
                <label v-for="branch in filteredBranches" :key="branch.id" class="branch-filter-option">
                  <input type="checkbox" :checked="branchFilter === null || branchFilter.includes(branch.id)" :disabled="saving" @change="toggleBranchFilter(branch.id)" />
                  <span class="graph-branch-swatch" :style="{ background: branch.color }" aria-hidden="true"></span>
                  <span>{{ branch.name }}</span>
                </label>
                <p v-if="!filteredBranches.length" class="form-help">{{ graph.branches.length ? '没有匹配的分支。' : '尚无分支。' }}</p>
              </div>
              <p class="form-help">多选显示历史并集；游离版本始终保留。</p>
            </div>
          </details>
        </div>
        <button class="tool-button" :disabled="saving" :aria-label="`切换版本排序，当前${versionOrder === 'oldest' ? '旧到新' : '新到旧'}`" :title="`切换版本排序，当前${versionOrder === 'oldest' ? '旧到新' : '新到旧'}；父子关系优先`" @click="versionOrder = versionOrder === 'oldest' ? 'newest' : 'oldest'">
          <AppIcon name="sort" /><span class="tool-caption">{{ versionOrder === 'oldest' ? '旧 → 新' : '新 → 旧' }}</span>
        </button>
        <button class="tool-button" :disabled="!undoAvailable" aria-label="撤销上一步" aria-keyshortcuts="Control+z Meta+z" :title="undoLabel ? `撤销：${undoLabel}（Ctrl/Cmd+Z）` : '撤销上一步（Ctrl/Cmd+Z）'" @click="undo">
          <AppIcon name="undo" /><span class="tool-caption">撤销</span>
        </button>
        <button class="tool-button tool-button-accent" :disabled="saving" aria-label="新增未关联版本" title="新增版本，默认放入未关联版本列" @click="openNodeAdd()"><AppIcon name="plus" /><span class="tool-caption">新增版本</span></button>
      </div>

      <div class="graph-toolbar-row">
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1" aria-label="新增子版本" title="为选中的一个版本新增子版本" @click="startNodeAction('add')"><AppIcon name="plus" /><span class="tool-caption">新增子版本</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1" aria-label="编辑版本" title="编辑选中版本的版本号与说明；已放行版本仅可编辑说明" @click="startNodeAction('edit')"><AppIcon name="edit" /><span class="tool-caption">编辑</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1 || !!selectedNode?.releasedAt" aria-label="设置父版本" title="搜索选择父版本；已放行版本不可修改父边" @click="startNodeAction('parents')"><AppIcon name="link" /><span class="tool-caption">设置父版本</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length < 2" aria-label="合并版本" title="选择至少两个版本后创建合并版本" @click="startNodeAction('merge')"><AppIcon name="merge" /><span class="tool-caption">合并</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1" :aria-label="selectedNode?.releasedAt ? '撤销放行' : '放行版本'" :title="selectedNode?.releasedAt ? '撤销选中版本的放行；不可破坏已放行后代闭包' : '放行选中版本及其全部祖先'" @click="startNodeAction('release')">
          <AppIcon :name="selectedNode?.releasedAt ? 'unrelease' : 'release'" /><span class="tool-caption">{{ selectedNode?.releasedAt ? '撤销放行' : '放行' }}</span>
        </button>
        <button class="tool-button tool-button-danger" :disabled="saving || selectedNodeIds.length === 0" aria-label="删除所选版本" title="预览删除所选版本及关系重连，确认后才执行" @click="startNodeAction('delete')"><AppIcon name="trash" /><span class="tool-caption">删除版本</span></button>
        <button class="tool-button" :disabled="saving || (selectedNodeIds.length !== 1 && !selectedBranch)" aria-label="创建分支" title="从选中版本或分支头创建分支" @click="selectedBranch ? openBranchAdd(selectedBranch.headId) : startNodeAction('branch')"><AppIcon name="branch" /><span class="tool-caption">创建分支</span></button>
      </div>

      <div v-if="selectedBranch" class="graph-branch-actions" :style="{ '--branch-color': selectedBranch.color }">
        <span class="branch-selected-indicator">{{ selectedBranch.name }}<small>· 头：{{ nodeById.get(selectedBranch.headId)?.version ?? '未知' }}</small></span>
        <button class="tool-button" :disabled="saving" aria-label="编辑分支" title="编辑选中分支的名称、说明与颜色" @click="openBranchEdit"><AppIcon name="edit" /><span class="tool-caption">编辑分支</span></button>
        <button class="tool-button" :disabled="saving" aria-label="放行分支" title="放行选中分支的头版本及全部祖先" @click="releaseBranch"><AppIcon name="release" /><span class="tool-caption">放行分支</span></button>
        <button class="tool-button" :disabled="saving" aria-label="从此分支创建分支" title="从选中分支的头版本创建分支" @click="openBranchAdd(selectedBranch.headId)"><AppIcon name="branch" /><span class="tool-caption">创建分支</span></button>
        <button class="tool-button tool-button-danger" :disabled="saving" aria-label="删除分支" title="删除分支记录，保留版本及父子关系；需确认" @click="openBranchDelete"><AppIcon name="trash" /><span class="tool-caption">删除分支</span></button>
      </div>
      <span role="status" class="selection-count">已选 {{ selectedNodeIds.length }} / {{ graph.nodes.length }} 个版本 · Ctrl/Cmd 点击多选</span>
    </div>

    <div v-if="graph" class="graph-layout" :class="{ 'is-editing': editorOpen }">
      <div
        ref="graphScroller"
        class="graph-canvas-scroll"
        role="region"
        tabindex="0"
        aria-label="版本历史图。普通滚轮上下滚动，Shift 加滚轮左右滚动，Ctrl 加滚轮缩放。"
        @wheel="onWheel"
      >
        <div class="git-graph-canvas" :style="{ width: `${canvasWidth * scale}px`, height: `${displayHeight * scale}px` }">
          <div class="git-graph-zoom-content" :style="{ width: `${canvasWidth}px`, height: `${displayHeight}px`, transform: `scale(${scale})` }">
            <div class="git-graph-column-head" :style="{ gridTemplateColumns: `${laneWidth}px minmax(720px, 1fr) 280px` }">
              <span>分支轨道</span><span>版本与改动信息 · 分支标签位于版本右侧</span><span>未关联版本</span>
            </div>
            <svg
              v-if="graphLayout"
              class="git-graph-lines"
              :width="laneWidth"
              :height="contentHeight"
              :viewBox="`0 0 ${laneWidth} ${contentHeight}`"
              aria-hidden="true"
            >
              <path
                v-for="edge in graphLayout.edges"
                :key="edge.id"
                :d="edgePath(edge)"
                class="git-graph-edge"
                :style="{ stroke: edge.color }"
              />
              <circle
                v-for="row in graphLayout.rows.filter(row => !row.isolated)"
                :key="row.node.id"
                :cx="GIT_GRAPH.laneStart + row.laneIndex * GIT_GRAPH.laneGap"
                :cy="40 + row.rowIndex * GIT_GRAPH.rowHeight + GIT_GRAPH.rowHeight / 2"
                r="6"
                class="git-graph-commit"
                :style="{ stroke: nodeColor(row.node) }"
              />
            </svg>
            <div class="git-graph-rows">
              <div
                v-for="row in graphLayout?.rows ?? []"
                :key="row.node.id"
                class="git-graph-row"
                :class="{ selected: selectedNodeIds.includes(row.node.id), isolated: row.isolated, 'branch-drop-target': dropTargetId === row.node.id }"
                @dragover="onBranchDragOver($event, row.node.id)"
                @dragleave="dropTargetId === row.node.id && (dropTargetId = null)"
                @drop="dropBranch($event, row.node.id)"
                :style="{ gridTemplateColumns: `${laneWidth}px minmax(720px, 1fr) 280px` }"
              >
                <div class="git-graph-lanes" aria-hidden="true"></div>
                <div class="git-graph-main-cell">
                  <button
                    v-if="!row.isolated"
                    class="git-row-commit"
                    :class="{ 'is-released': row.node.releasedAt }"
                    :aria-label="`版本 ${row.node.version}${row.node.releasedAt ? '，已放行' : '，未放行'}${row.node.description ? `，${row.node.description}` : ''}`"
                    :aria-pressed="selectedNodeIds.includes(row.node.id)"
                    @click="selectNode(row.node.id, $event.ctrlKey || $event.metaKey)"
                    @contextmenu="openNodeMenu($event, row.node.id)"
                  >
                    <AppIcon class="git-release-icon" :name="row.node.releasedAt ? 'release' : 'unrelease'" />
                    <span class="git-commit-version">{{ row.node.version }}</span>
                    <span class="git-commit-description">{{ row.node.description || '（无改动说明）' }}</span>
                  </button>
                  <span v-if="!row.isolated && row.branchHeads.length" class="git-branch-labels">
                    <button
                      v-for="branch in row.branchHeads"
                      :key="branch.id"
                      class="git-branch-label"
                      :class="{ selected: activeBranchId === branch.id }"
                      :style="{ '--branch-color': branch.color }"
                      :aria-pressed="activeBranchId === branch.id"
                      :draggable="!saving && !editorOpen"
                      title="拖到版本行以移动分支指针，或通过编辑分支选择版本"
                      @dragstart="startBranchDrag($event, branch)"
                      @dragend="endBranchDrag"
                      @click="selectBranch(branch.id)"
                      @contextmenu="openBranchMenu($event, branch.id)"
                    >{{ branch.name }}</button>
                  </span>
                </div>
                <div class="git-graph-orphan-cell">
                  <button
                    v-if="row.isolated"
                    class="git-row-commit git-row-orphan"
                    :class="{ selected: selectedNodeIds.includes(row.node.id), 'is-released': row.node.releasedAt }"
                    :aria-label="`未关联版本 ${row.node.version}${row.node.releasedAt ? '，已放行' : '，未放行'}${row.node.description ? `，${row.node.description}` : ''}`"
                    :aria-pressed="selectedNodeIds.includes(row.node.id)"
                    @click="selectNode(row.node.id, $event.ctrlKey || $event.metaKey)"
                    @contextmenu="openNodeMenu($event, row.node.id)"
                  >
                    <AppIcon class="git-release-icon" :name="row.node.releasedAt ? 'release' : 'unrelease'" />
                    <span class="git-commit-version">{{ row.node.version }}</span>
                    <span class="git-commit-description">{{ row.node.description || '（无改动说明）' }}</span>
                  </button>
                  <span v-if="row.isolated && row.branchHeads.length" class="git-branch-labels">
                    <button
                      v-for="branch in row.branchHeads" :key="branch.id" class="git-branch-label"
                      :class="{ selected: activeBranchId === branch.id }"
                      :style="{ '--branch-color': branch.color }" :aria-pressed="activeBranchId === branch.id"
                      :draggable="!saving && !editorOpen"
                      title="拖到版本行以移动分支指针，或通过编辑分支选择版本"
                      @dragstart="startBranchDrag($event, branch)" @dragend="endBranchDrag"
                      @click="selectBranch(branch.id)" @contextmenu="openBranchMenu($event, branch.id)"
                    >{{ branch.name }}</button>
                  </span>
                </div>
              </div>
              <p v-if="!graph.nodes.length" class="git-graph-empty">暂无版本。可新增未关联版本，或从已有版本创建子版本。</p>
            </div>
          </div>
        </div>
      </div>

      <div v-if="menu" ref="menuElement" class="graph-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu" tabindex="-1" :aria-label="menu.kind === 'node' ? '版本操作' : '分支操作'" @keydown="onMenuKeyDown">
        <template v-if="menu.kind === 'node' && selectedNodeIds.length > 1">
          <button role="menuitem" :disabled="saving" @click="startNodeAction('merge'); closeMenu(false)"><AppIcon name="merge" />合并所选版本</button>
          <button role="menuitem" :disabled="saving" @click="openDeletion"><AppIcon name="trash" />删除所选版本</button>
        </template>
        <template v-else-if="menu.kind === 'node'">
          <button role="menuitem" :disabled="saving" @click="openNodeAdd([menu.id]); closeMenu(false)"><AppIcon name="plus" />新增子版本</button>
          <button role="menuitem" :disabled="saving" @click="openBranchAdd(menu.id)"><AppIcon name="branch" />创建分支</button>
          <button role="menuitem" :disabled="saving" @click="openNodeEdit(); closeMenu(false)"><AppIcon name="edit" />编辑</button>
          <button role="menuitem" :disabled="saving || !!selectedNode?.releasedAt" @click="openParentEdit(); closeMenu(false)"><AppIcon name="link" />设置父版本</button>
          <button role="menuitem" :disabled="saving" @click="releaseSelectedNode(); closeMenu(false)"><AppIcon name="release" />{{ selectedNode?.releasedAt ? '撤销放行' : '放行' }}</button>
          <button role="menuitem" :disabled="saving" @click="openDeletion"><AppIcon name="trash" />删除</button>
        </template>
        <template v-else>
          <button role="menuitem" :disabled="saving" @click="openBranchAdd(selectedBranch!.headId); closeMenu(false)"><AppIcon name="branch" />创建分支</button>
          <button role="menuitem" :disabled="saving" @click="openBranchEdit(); closeMenu(false)"><AppIcon name="edit" />编辑分支</button>
          <button role="menuitem" :disabled="saving" @click="releaseBranch(); closeMenu(false)"><AppIcon name="release" />放行分支</button>
          <button role="menuitem" :disabled="saving" @click="openBranchDelete"><AppIcon name="trash" />删除分支</button>
        </template>
      </div>

      <div ref="editorSidebar" class="graph-sidebar" :class="{ 'is-editing': editorOpen }" @focusout="onSidebarFocusOut">
        <div v-if="editorOpen" class="graph-editor-heading">
          <span>图操作面板</span>
          <button class="icon-button" :disabled="saving" aria-label="关闭操作面板" title="关闭操作面板（Escape）" @click="closeEditor"><AppIcon name="clear" /></button>
        </div>
        <div v-if="error" role="alert" class="error"><h3 ref="errorHeading" tabindex="-1">图操作未完成</h3><p>{{ error }}</p></div>
        <p role="status" class="status">{{ status }}</p>
      <template v-if="!editorOpen">
      <aside v-if="selectedNode" class="graph-detail" aria-label="版本详情">
        <p class="eyebrow">VERSION DETAIL</p>
        <h3>{{ selectedNode.version }}</h3>
        <p class="form-help">{{ selectedNode.description || '（无改动说明）' }}</p>
        <p class="workspace-details">状态：{{ selectedNode.releasedAt ? '已放行' : '未放行' }}</p>
        <p class="workspace-details">父版本：{{ (parentIdsOf.get(selectedNode.id) ?? []).map(id => nodeById.get(id)?.version ?? id).join('、') || '无（未关联）' }}</p>
        <p class="workspace-details">子版本：{{ (childIdsOf.get(selectedNode.id) ?? []).map(id => nodeById.get(id)?.version ?? id).join('、') || '无' }}</p>
        <p class="workspace-details">分支：{{ (graphLayout?.memberships.get(selectedNode.id) ?? []).map(branch => branch.name).join('、') || '未关联' }}</p>
      </aside>

      <aside v-else-if="selectedBranch" class="graph-detail" aria-label="分支详情">
        <p class="eyebrow">BRANCH DETAIL</p>
        <h3><span class="graph-branch-swatch" :style="{ background: selectedBranch.color }"></span>{{ selectedBranch.name }}</h3>
        <p class="form-help">{{ selectedBranch.description || '（无分支说明）' }}</p>
        <p class="workspace-details">头版本：{{ nodeById.get(selectedBranch.headId)?.version ?? '未知' }}</p>
        <div class="graph-detail-actions">
          <button class="tool-button" :disabled="saving" aria-label="编辑分支" title="编辑分支名称、说明与颜色" @click="openBranchEdit"><AppIcon name="edit" /><span class="tool-caption">编辑</span></button>
          <button class="tool-button" :disabled="saving" aria-label="放行分支" title="放行分支头及全部祖先" @click="releaseBranch"><AppIcon name="release" /><span class="tool-caption">放行分支</span></button>
          <button class="tool-button" :disabled="saving" aria-label="从此分支创建分支" title="从当前分支头创建分支" @click="openBranchAdd(selectedBranch.headId)"><AppIcon name="branch" /><span class="tool-caption">创建分支</span></button>
          <button class="tool-button tool-button-danger" :disabled="saving" aria-label="删除分支" title="删除分支记录，版本及父子关系保留；需确认" @click="openBranchDelete"><AppIcon name="trash" /><span class="tool-caption">删除分支</span></button>
        </div>
      </aside>

      <aside v-else class="graph-detail" aria-label="分支图例">
        <p class="eyebrow">BRANCHES</p>
        <ul class="graph-branch-list">
          <li v-for="branch in graph.branches" :key="branch.id">
            <button class="graph-branch-swatch-button" :aria-label="`选择分支 ${branch.name}`" :aria-pressed="activeBranchId === branch.id" @click="selectBranch(branch.id)">
              <span class="graph-branch-swatch" :style="{ background: branch.color }"></span>
            </button>
            <button class="graph-branch-name" :aria-pressed="activeBranchId === branch.id" @click="selectBranch(branch.id)" @contextmenu="openBranchMenu($event, branch.id)">
              {{ branch.name }}<small>头：{{ nodeById.get(branch.headId)?.version ?? '未知' }}</small>
            </button>
          </li>
        </ul>
        <p v-if="!graph.branches.length" class="form-help">尚无分支。选择版本后创建分支；未关联版本会显示在独立列中。</p>
      </aside>
      </template>

    <div v-if="branchDeleteTarget" class="graph-form" role="dialog" aria-modal="false" aria-label="删除分支确认">
      <h3 tabindex="-1">删除分支记录</h3>
      <p>将删除“{{ graph?.branches.find(branch => branch.id === branchDeleteTarget)?.name }}”分支记录，不会删除版本、关系或磁盘文件。</p>
      <div class="actions">
        <button class="danger" :disabled="saving" @click="confirmBranchDelete"><AppIcon name="trash" />确认删除分支</button>
        <button class="secondary" :disabled="saving" @click="branchDeleteTarget = null">取消</button>
      </div>
    </div>

    <div v-if="panel === 'node-add' || panel === 'node-edit' || panel === 'merge'" class="graph-form" role="dialog" aria-modal="false" :aria-label="panel === 'merge' ? '合并版本' : panel === 'node-edit' ? '编辑版本' : '新增版本'">
      <h3 tabindex="-1">{{ panel === 'merge' ? '合并版本' : panel === 'node-edit' ? '编辑版本' : nodeForm.parentIds.length ? '新增子版本' : '新增未关联版本' }}</h3>
      <form @submit.prevent="submitNode">
        <label for="git-version">版本号 <span>必填，含日期文本，连续空白归一且区分大小写唯一</span></label>
        <input id="git-version" v-model="nodeForm.version" required :disabled="saving || (panel === 'node-edit' && !!selectedNode?.releasedAt)" placeholder="例如：1479-1 20260115" />
        <label for="git-description">改动说明</label>
        <textarea id="git-description" v-model="nodeForm.description" :disabled="saving" rows="3" placeholder="记录本次版本改动"></textarea>
        <template v-if="panel !== 'node-edit'">
          <ParentVersionPicker :options="rankedParentOptions" :disabled="saving" @add="addParentCandidate" />
          <ul v-if="nodeForm.parentIds.length" class="selected-parent-list" aria-label="已选父版本">
            <li v-for="id in nodeForm.parentIds" :key="id">
              {{ nodeById.get(id)?.version ?? id }}
              <button type="button" class="secondary icon-button" :disabled="saving" :aria-label="`移除父版本 ${nodeById.get(id)?.version ?? id}`" @click="removeParent(id)"><AppIcon name="clear" /></button>
            </li>
          </ul>
          <p v-else class="form-help">没有选择父版本：版本将显示在“未关联版本”列。</p>
          <label for="git-target-branch">{{ panel === 'merge' ? '合并目标分支' : '推进目标分支' }}</label>
          <select id="git-target-branch" v-model="nodeForm.targetBranchId" :disabled="saving">
            <option v-if="panel !== 'merge'" value="">不推进分支</option>
            <option
              v-for="branch in graph?.branches"
              :key="branch.id"
              :value="branch.id"
              :disabled="!nodeForm.parentIds.includes(branch.headId)"
            >{{ branch.name }}</option>
          </select>
        </template>
        <div class="actions">
          <button type="submit" :disabled="saving || !nodeForm.version.trim() || (panel === 'merge' && (nodeForm.parentIds.length < 2 || !nodeForm.targetBranchId))">
            <AppIcon name="check" />{{ panel === 'merge' ? '创建合并版本' : panel === 'node-edit' ? '保存版本' : '新增版本' }}
          </button>
          <button type="button" class="secondary" :disabled="saving" @click="panel = null">取消</button>
        </div>
      </form>
    </div>

    <div v-if="panel === 'parent-edit'" class="graph-form" role="dialog" aria-modal="false" aria-label="设置父版本">
      <h3 tabindex="-1">设置父版本 · {{ selectedNode?.version }}</h3>
      <form @submit.prevent="submitParentEdit">
        <ParentVersionPicker :options="rankedParentOptions" :disabled="saving" @add="addParentCandidate" />
        <ul v-if="nodeForm.parentIds.length" class="selected-parent-list" aria-label="已选父版本">
          <li v-for="id in nodeForm.parentIds" :key="id">
            {{ nodeById.get(id)?.version ?? id }}
            <button type="button" class="secondary icon-button" :disabled="saving" :aria-label="`移除父版本 ${nodeById.get(id)?.version ?? id}`" @click="removeParent(id)"><AppIcon name="clear" /></button>
          </li>
        </ul>
        <p v-else class="form-help">留空表示该版本为根版本。关系修改不自动改变分支头。</p>
        <div class="actions">
          <button type="submit" :disabled="saving || parentSelectionUnchanged || !!selectedNode?.releasedAt"><AppIcon name="check" />保存父版本</button>
          <button type="button" class="secondary" :disabled="saving" @click="panel = null">取消</button>
        </div>
      </form>
    </div>

    <div v-if="panel === 'branch-add' || panel === 'branch-edit'" class="graph-form" role="dialog" aria-modal="false" :aria-label="panel === 'branch-add' ? '创建分支' : '编辑分支'">
      <h3 tabindex="-1">{{ panel === 'branch-add' ? '创建分支' : '编辑分支' }}</h3>
      <form @submit.prevent="submitBranch">
        <label for="git-branch-name">分支名称</label>
        <input id="git-branch-name" v-model="branchForm.name" required :disabled="saving" />
        <label for="git-branch-description">分支说明</label>
        <textarea id="git-branch-description" v-model="branchForm.description" rows="2" :disabled="saving"></textarea>
        <label for="git-branch-color">分支颜色</label>
        <input id="git-branch-color" v-model="branchForm.color" type="color" :disabled="saving" />
        <template v-if="panel === 'branch-edit'">
          <label for="git-branch-head">分支指针</label>
          <select id="git-branch-head" v-model="branchForm.headId" :disabled="saving">
            <option v-for="node in branchHeadOptions" :key="node.id" :value="node.id">{{ node.version }}</option>
          </select>
          <p class="form-help">仅移动分支头，不修改父子关系或放行状态。</p>
        </template>
        <p class="form-help">分支头：{{ nodeById.get(branchForm.headId)?.version ?? '未知' }}。删除分支记录不会删除版本历史。</p>
        <div class="actions">
          <button type="submit" :disabled="saving || !branchForm.name.trim()"><AppIcon name="check" />{{ panel === 'branch-add' ? '创建分支' : '保存分支' }}</button>
          <button type="button" class="secondary" :disabled="saving" @click="panel = null">取消</button>
        </div>
      </form>
    </div>

    <div v-if="deletionPlan" class="graph-form" role="dialog" aria-modal="false" aria-label="删除版本预览">
      <h3 tabindex="-1">删除 {{ deletionPlan.nodeIds.length }} 个版本</h3>
      <p class="form-help">删除前预览父子关系重连；已放行子版本不能重连。本操作仅修改版本图，不会删除磁盘文件或其他未选版本。</p>
      <ul class="deletion-preview-list">
        <li v-for="id in deletionPlan.nodeIds" :key="id">{{ nodeById.get(id)?.version ?? id }}</li>
      </ul>
      <div v-if="Object.keys(deletionPlan.childParents).length" class="deletion-rewires">
        <h4>重连子版本</h4>
        <p class="form-help">可调整每个子版本的父集合；取消所有勾选会将其设为根版本。</p>
        <div v-for="childId in Object.keys(deletionPlan.childParents)" :key="childId" class="deletion-child">
          <strong>{{ nodeById.get(childId)?.version }} 的新父版本</strong>
          <p v-if="nodeById.get(childId)?.releasedAt" class="deletion-blocked">该子版本已放行，不能重连；请先撤销其放行。</p>
          <div class="deletion-parent-options" role="group" :aria-label="`为 ${nodeById.get(childId)?.version} 选择新父版本`">
            <label v-for="node in deletionParentCandidates(childId)" :key="node.id" class="deletion-parent-option">
              <input v-model="deletionChildParentChoices[childId]" type="checkbox" :value="node.id" :disabled="saving || !!nodeById.get(childId)?.releasedAt" />
              <span>{{ node.version }}</span>
            </label>
          </div>
        </div>
      </div>
      <div v-if="Object.keys(deletionBranchChoices).length" class="deletion-rewires">
        <h4>受影响分支</h4>
        <label v-for="branchId in Object.keys(deletionBranchChoices)" :key="branchId" :for="`branch-head-${branchId}`">
          {{ graph?.branches.find(branch => branch.id === branchId)?.name }}
          <select :id="`branch-head-${branchId}`" v-model="deletionBranchChoices[branchId]" :disabled="saving">
            <option value="">选择新头或删除分支…</option>
            <option value="__delete__">删除分支记录</option>
            <option v-for="node in graph?.nodes.filter(node => !deletionPlan?.nodeIds.includes(node.id))" :key="node.id" :value="node.id">{{ node.version }}</option>
          </select>
        </label>
      </div>
      <div v-if="releasedDeletionNodes.length" class="deletion-rewires">
        <h4>确认删除已放行版本</h4>
        <label v-for="node in releasedDeletionNodes" :key="node.id" :for="`confirm-delete-${node.id}`">
          输入版本号：{{ node.version }}
          <input :id="`confirm-delete-${node.id}`" v-model="deletionConfirmations[node.id]" :disabled="saving" autocomplete="off" />
        </label>
      </div>
      <div class="actions">
        <button class="danger" :disabled="!deletionReady" @click="confirmDeletion"><AppIcon name="trash" />确认删除</button>
        <button class="secondary" :disabled="saving" @click="deletionPlan = null">取消</button>
      </div>
    </div>
      </div>
    </div>
    <dialog ref="branchMoveDialog" class="branch-move-dialog" aria-labelledby="branch-move-heading" @cancel="saving ? $event.preventDefault() : (pendingBranchMove = null)" @close="pendingBranchMove = null">
      <template v-if="pendingBranchMove">
        <h3 id="branch-move-heading">确认移动分支指针</h3>
        <p>分支：{{ pendingBranchMove.name }}</p>
        <p>原版本：{{ nodeById.get(pendingBranchMove.headId)?.version ?? '已删除' }}</p>
        <p>目标版本：{{ nodeById.get(pendingBranchMove.targetId)?.version ?? '已删除' }}</p>
        <p class="form-help">仅改变分支头，不修改版本关系、放行状态或磁盘文件。</p>
        <div class="actions">
          <button :disabled="saving" @click="confirmBranchMove">确认移动</button>
          <button class="secondary" :disabled="saving" autofocus @click="pendingBranchMove = null">取消</button>
        </div>
      </template>
    </dialog>
  </section>
</template>
