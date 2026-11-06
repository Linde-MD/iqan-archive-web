<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { liveQuery } from 'dexie';
import { orderedBranches, type Branch, type ProjectGraph, type Task, type VersionNode } from '../domain/model';
import { matchComparisonDocuments, type FileCandidate } from '../domain/filenames';
import { buildDocumentOpenUri } from '../domain/iqan-protocol';
import { checkPermission, fileOperationErrorMessage, locateFile, scanDirectory, type DirectoryHandle } from '../files/directories';
import type { ArchiveRepository } from '../storage/database';
import { layoutGitGraph, GIT_GRAPH, recommendedParentNodes, gitGraphEdgePath } from '../domain/git-graph';
import { planDeletionMany, type MultiDeletionPlan } from '../domain/graph';
import { compareVersions, type VersionOrder } from '../domain/version-order';
import { changeVersionRelations, type BatchRelationAction } from '../domain/relations';
import { projectTaskViewLayout, taskViewRuns, type TaskRun, type TaskViewLayout } from '../domain/task-view';
import AppIcon from './AppIcon.vue';
import IqanIntegrationDialog from './IqanIntegrationDialog.vue';
import ParentVersionPicker from './ParentVersionPicker.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import { renderMarkdown } from '../utils/markdown';

const props = defineProps<{ repository: ArchiveRepository; projectId: string }>();
const versionOrder = defineModel<VersionOrder>('versionOrder', { default: 'newest' });
const emit = defineEmits<{ busy: [value: boolean]; documents: [] }>();

const graph = shallowRef<ProjectGraph>();
const error = ref('');
const status = ref('');
const saving = ref(false);
const errorHeading = ref<HTMLElement>();
const graphScroller = ref<HTMLDivElement>();
const versionHint = ref<HTMLDivElement>();
const hintedNode = shallowRef<VersionNode>();
let hintCloseTimer: ReturnType<typeof setTimeout> | undefined;
let nodeClickTimer: ReturnType<typeof setTimeout> | undefined;

function clearNodeClickTimer() {
  clearTimeout(nodeClickTimer);
  nodeClickTimer = undefined;
}

function keepVersionHint() {
  clearTimeout(hintCloseTimer);
}

function hideVersionHint() {
  keepVersionHint();
  versionHint.value?.hidePopover();
  hintedNode.value = undefined;
}

function scheduleHintClose() {
  keepVersionHint();
  hintCloseTimer = setTimeout(hideVersionHint, 150);
}

function positionVersionHintAtPointer(event: MouseEvent) {
  const hint = versionHint.value;
  if (!hint?.matches(':popover-open')) return;
  const bounds = hint.getBoundingClientRect();
  const gap = 16;
  const left = event.clientX + gap + bounds.width <= window.innerWidth - 8
    ? event.clientX + gap : event.clientX - gap - bounds.width;
  const top = event.clientY + gap + bounds.height <= window.innerHeight - 8
    ? event.clientY + gap : event.clientY - gap - bounds.height;
  hint.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8))}px`;
  hint.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8))}px`;
}

async function showVersionHint(event: MouseEvent | FocusEvent, node: VersionNode) {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  keepVersionHint();
  hintedNode.value = node;
  await nextTick();
  const hint = versionHint.value;
  if (!hint || hintedNode.value !== node || !anchor.isConnected) return;
  hint.showPopover();
  if (event instanceof MouseEvent) {
    positionVersionHintAtPointer(event);
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const bounds = hint.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8));
  const below = rect.bottom + 8;
  const top = below + bounds.height <= window.innerHeight - 8
    ? below : Math.max(8, rect.top - bounds.height - 8);
  hint.style.left = `${left}px`;
  hint.style.top = `${top}px`;
}

function onHintScroll(event: Event) {
  if (event.target instanceof Node && versionHint.value?.contains(event.target)) return;
  hideVersionHint();
}
const graphWorkspace = ref<HTMLElement>();
const fullscreenButton = ref<HTMLButtonElement>();
const isFullscreen = ref(false);
const fullscreenPending = ref(false);
const fullscreenToolsVisible = ref(true);
const fullscreenSidebarVisible = ref(true);
const comparisonDocumentsByNode = shallowRef(new Map<string, FileCandidate[]>());
const documentScanError = ref('');
const documentChoice = shallowRef<{ nodeId: string; version: string; files: FileCandidate[] }>();
const selectedDocumentPath = ref('');
const documentChoiceDialog = ref<HTMLDialogElement>();
let documentScanController: AbortController | undefined;
let documentRootSnapshot: DirectoryHandle | undefined;

async function toggleFullscreen() {
  if (fullscreenPending.value) return;
  fullscreenPending.value = true;
  try {
    if (document.fullscreenElement === graphWorkspace.value) await document.exitFullscreen();
    else {
      if (!graphWorkspace.value?.requestFullscreen) throw new Error('当前浏览器不支持全屏查看，请使用支持全屏的浏览器。');
      fullscreenSidebarVisible.value = editorOpen.value || !window.matchMedia('(max-width: 720px)').matches;
      await graphWorkspace.value.requestFullscreen();
    }
  } catch (cause) {
    showError(cause);
  } finally {
    fullscreenPending.value = false;
  }
}

function onFullscreenChange() {
  hideVersionHint();
  const scroller = graphScroller.value;
  const left = scroller?.scrollLeft ?? 0;
  const top = scroller?.scrollTop ?? 0;
  isFullscreen.value = document.fullscreenElement === graphWorkspace.value;
  void nextTick(() => {
    updateSidebarHeight();
    if (scroller) {
      scroller.scrollLeft = left;
      scroller.scrollTop = top;
    }
    if (!editorOpen.value) fullscreenButton.value?.focus({ preventScroll: true });
  });
}

function toggleFullscreenSidebar() {
  fullscreenSidebarVisible.value = !fullscreenSidebarVisible.value;
  if (!fullscreenSidebarVisible.value) void nextTick(() => fullscreenButton.value?.focus({ preventScroll: true }));
}
const canvasViewport = ref<HTMLDivElement>();
const viewportSize = ref<{ width: number; height: number } | null>(null);
let resizeStart: { pointerId: number; x: number; y: number; width: number; height: number } | null = null;

function resizeViewport(width: number, height: number) {
  const available = canvasViewport.value?.parentElement?.getBoundingClientRect().width ?? width;
  const sidebarWidth = window.matchMedia('(min-width: 1101px)').matches ? 376 : 0;
  const maxWidth = Math.max(0, available - sidebarWidth);
  viewportSize.value = {
    width: Math.max(Math.min(280, maxWidth), Math.min(maxWidth, width)),
    height: Math.max(240, Math.min(1600, height)),
  };
}

function startViewportResize(event: PointerEvent) {
  if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement) || !canvasViewport.value) return;
  const rect = canvasViewport.value.getBoundingClientRect();
  resizeStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
  event.currentTarget.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveViewportResize(event: PointerEvent) {
  if (!resizeStart || resizeStart.pointerId !== event.pointerId) return;
  resizeViewport(resizeStart.width + event.clientX - resizeStart.x, resizeStart.height + event.clientY - resizeStart.y);
}

function endViewportResize() {
  resizeStart = null;
}

function onResizeKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') {
    viewportSize.value = null;
    return;
  }
  const rect = canvasViewport.value?.getBoundingClientRect();
  if (!rect) return;
  const step = event.shiftKey ? 80 : 20;
  resizeViewport(rect.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
    rect.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0));
}
const menuElement = ref<HTMLDivElement>();
const editorSidebar = ref<HTMLElement>();
const iqanIntegration = ref<InstanceType<typeof IqanIntegrationDialog>>();
const scale = ref(1);
const selectedNodeIds = ref<string[]>([]);
const selectionAnchorId = ref<string | null>(null);
const nodeSwitchTargetId = ref('');
const graphMode = ref<'all' | 'tasks'>('all');
const expandedTaskRunIds = ref<string[]>([]);
watch(selectedNodeIds, ids => {
  if (!ids.length) selectionAnchorId.value = null;
}, { flush: 'sync' });
const branchFilter = ref<string[] | null>(null);
const hideIsolated = ref(false);
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
const panel = ref<'node-add' | 'node-edit' | 'parent-edit' | 'merge' | 'branch-add' | 'branch-edit' | 'branch-manager' | 'relations' | 'tasks' | null>(null);
const nodeSwitchDialog = ref<HTMLDialogElement>();
type NodeSwitchSource = 'node-add' | 'node-edit' | 'parent-edit' | 'merge' | 'branch-add' | 'branch-edit' | 'tasks'
  | 'deletion-preview' | 'branch-delete' | 'relation-preview';
const pendingNodeSwitch = ref<{ nodeId: string; mode: 'details' | 'edit'; source: NodeSwitchSource } | null>(null);
const nodeTaskId = ref('');
const taskForm = ref({ id: '', name: '', description: '', externalTaskId: '' });
const nodeDraftBaseline = ref('');
const branchDraftBaseline = ref('');
const nodeDraftValue = () => JSON.stringify([nodeForm.value, nodeTaskId.value]);
const branchDraftValue = () => JSON.stringify([
  branchForm.value.name, branchForm.value.description, branchForm.value.color, branchForm.value.headId,
]);
const taskRevision = ref(0);
const taskDeleteId = ref<string | null>(null);
const taskQuery = ref('');
const filteredTasks = computed(() => (graph.value?.tasks ?? []).filter(task =>
  `${task.name} ${task.externalTaskId ?? ''}`.toLocaleLowerCase().includes(taskQuery.value.trim().toLocaleLowerCase())));
const taskDeleteTarget = computed(() => graph.value?.tasks.find(task => task.id === taskDeleteId.value));
const taskEditDirty = computed(() => {
  if (panel.value !== 'tasks') return false;
  if (!taskForm.value.id) {
    return !!(taskForm.value.name || taskForm.value.description || taskForm.value.externalTaskId);
  }
  const task = graph.value?.tasks.find(item => item.id === taskForm.value.id);
  return !task
    || taskForm.value.name !== task.name
    || taskForm.value.description !== task.description
    || taskForm.value.externalTaskId !== (task.externalTaskId ?? '');
});
const nodeFormDirty = computed(() => {
  if (panel.value === 'node-edit') return nodeEditDirty.value;
  if (panel.value === 'parent-edit') return !parentSelectionUnchanged.value;
  return (panel.value === 'node-add' || panel.value === 'merge')
    && nodeDraftValue() !== nodeDraftBaseline.value;
});
const branchFormDirty = computed(() => (panel.value === 'branch-add' || panel.value === 'branch-edit')
  && branchDraftValue() !== branchDraftBaseline.value);
const editorDraftDirty = computed(() => {
  if (deletionPlan.value || branchDeleteTarget.value || panel.value === 'relations') return true;
  if (panel.value === 'tasks') return taskEditDirty.value;
  if (panel.value === 'node-add' || panel.value === 'node-edit' || panel.value === 'parent-edit' || panel.value === 'merge') {
    return nodeFormDirty.value;
  }
  return branchFormDirty.value;
});
const editorDraftSource = computed<NodeSwitchSource | null>(() => {
  if (deletionPlan.value) return 'deletion-preview';
  if (branchDeleteTarget.value) return 'branch-delete';
  if (panel.value === 'relations') return 'relation-preview';
  if (panel.value === 'tasks') return 'tasks';
  if (panel.value === 'node-add' || panel.value === 'node-edit' || panel.value === 'parent-edit'
    || panel.value === 'merge' || panel.value === 'branch-add' || panel.value === 'branch-edit') return panel.value;
  return null;
});
const editorDraftLabel = computed(() => {
  switch (pendingNodeSwitch.value?.source) {
    case 'tasks': return '任务管理中的任务草稿';
    case 'branch-add': return '新建分支草稿';
    case 'branch-edit': return '分支编辑草稿';
    case 'node-add': return '新增版本草稿';
    case 'node-edit': return '版本编辑草稿';
    case 'parent-edit': return '父版本修改草稿';
    case 'merge': return '合并版本草稿';
    case 'deletion-preview': return '删除版本预览尚未确认';
    case 'branch-delete': return '删除分支确认尚未完成';
    case 'relation-preview': return '父子关联预览尚未确认';
    default: return '当前面板中的修改';
  }
});
const nodeSwitchCanSave = computed(() => !['deletion-preview', 'branch-delete', 'relation-preview'].includes(
  pendingNodeSwitch.value?.source ?? '',
));
const nodeSwitchSaveDisabled = computed(() => {
  if (saving.value) return true;
  switch (pendingNodeSwitch.value?.source) {
    case 'tasks': return !taskForm.value.name.trim() || graph.value?.project.revision !== taskRevision.value;
    case 'branch-add':
    case 'branch-edit': return !branchForm.value.name.trim();
    case 'node-add': return !nodeForm.value.version.trim();
    case 'merge': return !nodeForm.value.version.trim() || nodeForm.value.parentIds.length < 2 || !nodeForm.value.targetBranchId;
    case 'node-edit': return !nodeForm.value.version.trim();
    case 'parent-edit': return !selectedNode.value || parentSelectionUnchanged.value || !!selectedNode.value.releasedAt;
    default: return true;
  }
});

function taskLabel(task: Task): string {
  return `${task.externalTaskId ? `${task.externalTaskId} · ` : ''}${task.name}`;
}

function editTask(task?: Task) {
  taskForm.value = task ? { ...task, externalTaskId: task.externalTaskId ?? '' } : { id: '', name: '', description: '', externalTaskId: '' };
  taskRevision.value = graph.value!.project.revision;
  taskDeleteId.value = null;
  error.value = '';
  void nextTick(() => editorSidebar.value?.querySelector<HTMLInputElement>('#git-task-name')?.focus({ preventScroll: true }));
}

function openTasks() {
  panel.value = 'tasks';
  editTask();
  closeMenu(false);
}

function openBranchManager() {
  panel.value = 'branch-manager';
  closeMenu(false);
}

async function moveBranchOrder(branchId: string, offset: -1 | 1) {
  const current = graph.value;
  if (!current || saving.value) return;
  const branches = orderedBranches(current.branches);
  const index = branches.findIndex(branch => branch.id === branchId);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= branches.length) return;
  const next = [...branches];
  [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
  await operation(`调整分支顺序：${branches[index]!.name}`, async () => {
    graph.value = await props.repository.saveBranchOrder(
      props.projectId,
      current.project.revision,
      next.map(branch => branch.id),
    );
    status.value = `分支“${branches[index]!.name}”已${offset < 0 ? '上移' : '下移'}。`;
  });
}

async function saveTaskDraft(): Promise<boolean> {
  return operation(taskForm.value.id ? '编辑任务' : '创建任务', async () => {
    const current = graph.value!;
    graph.value = await props.repository.saveTask(props.projectId, taskRevision.value, {
      ...taskForm.value, id: taskForm.value.id || crypto.randomUUID(), projectId: current.project.id,
    });
    status.value = '任务已保存。Task ID 是手工维护的外部编号，未进行远端验证。';
  });
}

async function submitTask() {
  if (await saveTaskDraft()) editTask();
}

function openTaskDelete(task: Task) {
  editTask(task);
  taskDeleteId.value = task.id;
  void nextTick(() => editorSidebar.value?.querySelector<HTMLElement>('.task-delete-confirm h3')?.focus({ preventScroll: true }));
}

async function confirmTaskDelete() {
  const task = taskDeleteTarget.value;
  if (!task || saving.value) return;
  await operation('删除任务', async () => {
    graph.value = await props.repository.deleteTask(props.projectId, taskRevision.value, task.id);
    status.value = '任务已删除，所属版本已解除任务关联；版本与父子关系保持不变。';
    editTask();
  });
}
const relationPreview = shallowRef<{
  action: BatchRelationAction; nodeIds: string[]; revision: number; edges: ProjectGraph['edges'];
}>();
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
const orderedBranchList = computed(() => orderedBranches(graph.value?.branches ?? []));
const nodeEditDirty = computed(() => panel.value === 'node-edit' && !!selectedNode.value && (
  nodeForm.value.version !== selectedNode.value.version
  || nodeForm.value.description !== selectedNode.value.description
  || nodeTaskId.value !== (selectedNode.value.taskId ?? '')
));
const pendingNodeSwitchTarget = computed(() => pendingNodeSwitch.value
  ? nodeById.value.get(pendingNodeSwitch.value.nodeId)
  : undefined);

watch(documentChoice, async value => {
  await nextTick();
  if (value && documentChoiceDialog.value && !documentChoiceDialog.value.open) {
    documentChoiceDialog.value.showModal();
    documentChoiceDialog.value.querySelector<HTMLSelectElement>('select')?.focus();
  } else if (!value && documentChoiceDialog.value?.open) documentChoiceDialog.value.close();
});

async function refreshComparisonDocuments() {
  documentScanController?.abort();
  const controller = new AbortController();
  documentScanController = controller;
  comparisonDocumentsByNode.value = new Map();
  documentScanError.value = '';
  try {
    const binding = await props.repository.db.directoryBindings.get([props.projectId, 'word']);
    if (!binding || !await checkPermission(binding.handle)) return;
    documentRootSnapshot = binding.handle;
    const candidates = await scanDirectory(binding.handle, 'word', controller.signal, () => undefined);
    const [latestGraph, latestBinding] = await Promise.all([
      props.repository.get(props.projectId),
      props.repository.db.directoryBindings.get([props.projectId, 'word']),
    ]);
    if (controller.signal.aborted || !latestBinding || !(await sameDocumentDirectory(binding.handle, latestBinding.handle))) return;
    comparisonDocumentsByNode.value = matchComparisonDocuments(latestGraph, candidates);
  } catch (cause) {
    if (!controller.signal.aborted) documentScanError.value = fileOperationErrorMessage(cause);
  } finally {
    if (documentScanController === controller) documentScanController = undefined;
  }
}

async function sameDocumentDirectory(snapshot: DirectoryHandle, current: DirectoryHandle): Promise<boolean> {
  return snapshot.isSameEntry ? current.isSameEntry ? snapshot.isSameEntry(current) : false : snapshot === current;
}

async function openNodeDocuments(event: MouseEvent, node: VersionNode) {
  event.preventDefault();
  event.stopPropagation();
  if (saving.value || editorOpen.value) return;
  const available = comparisonDocumentsByNode.value.get(node.id) ?? [];
  if (!available.length) {
    showError(new Error(documentScanError.value || `未找到版本“${node.version}”对应的软件对比文档。`));
    return;
  }
  if (available.length > 1) {
    selectedDocumentPath.value = available[0]!.relativePath;
    documentChoice.value = { nodeId: node.id, version: node.version, files: available };
    return;
  }
  await requestNodeDocument(node.id, available[0]!.relativePath);
}

async function requestNodeDocument(nodeId: string, relativePath: string) {
  if (saving.value) return;
  documentChoice.value = undefined;
  const activeGraph = graph.value;
  if (!activeGraph) return;
  const originalNode = activeGraph.nodes.find(node => node.id === nodeId);
  if (!originalNode) { showError(new Error('版本已不存在，请重新读取版本图。')); return; }
  saving.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '正在检查软件对比文档…';
  try {
    const [binding, latestGraph] = await Promise.all([
      props.repository.db.directoryBindings.get([props.projectId, 'word']),
      props.repository.get(props.projectId),
    ]);
    if (!binding || !documentRootSnapshot || !(await sameDocumentDirectory(documentRootSnapshot, binding.handle)))
      throw new Error('软件对比文档目录绑定已改变，请重新扫描目录。');
    if (!await checkPermission(binding.handle)) throw new Error('软件对比文档目录授权已失效，请重新授权。');
    const latestNode = latestGraph.nodes.find(node => node.id === nodeId);
    if (!latestNode || latestNode.version !== originalNode.version || latestGraph.project.partNumber !== activeGraph.project.partNumber)
      throw new Error('项目零件号或版本信息已变化，请重新读取版本图。');
    const candidates = await scanDirectory(binding.handle, 'word', new AbortController().signal, () => undefined);
    const matching = matchComparisonDocuments(latestGraph, candidates).get(nodeId) ?? [];
    if (!matching.some(file => file.relativePath === relativePath))
      throw new Error(`文档“${relativePath}”已不再对应版本“${latestNode.version}”，请重新扫描。`);
    await locateFile(binding.handle, relativePath);
    const [finalGraph, finalBinding] = await Promise.all([
      props.repository.get(props.projectId),
      props.repository.db.directoryBindings.get([props.projectId, 'word']),
    ]);
    if (!finalBinding || !(await sameDocumentDirectory(binding.handle, finalBinding.handle))
      || finalGraph.project.partNumber !== latestGraph.project.partNumber
      || finalGraph.nodes.find(item => item.id === nodeId)?.version !== latestNode.version)
      throw new Error('检查期间目录或版本已变化，请重新扫描后再打开。');
    const uri = buildDocumentOpenUri(props.projectId, binding.handle.name, relativePath);
    window.location.assign(uri);
    status.value = '已请求本地启动器，请查看系统提示。网页无法确认 Word 是否已打开文档。';
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
    emit('busy', false);
  }
}

watch(pendingBranchMove, async value => {
  await nextTick();
  if (value) branchMoveDialog.value?.showModal();
  else branchMoveDialog.value?.close();
});

watch(pendingNodeSwitch, async value => {
  await nextTick();
  if (value && nodeSwitchDialog.value && !nodeSwitchDialog.value.open) nodeSwitchDialog.value.showModal();
  else if (!value && nodeSwitchDialog.value?.open) nodeSwitchDialog.value.close();
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
  clearNodeClickTimer();
  panel.value = null;
  branchDeleteTarget.value = null;
  deletionPlan.value = null;
}

function onSidebarFocusOut(event: FocusEvent) {
  if (event.relatedTarget === fullscreenButton.value
    || (event.relatedTarget instanceof Node && nodeSwitchDialog.value?.contains(event.relatedTarget))
    || (event.relatedTarget instanceof HTMLElement && event.relatedTarget.matches('.git-row-commit'))) return;
  if (!isFullscreen.value && editorOpen.value && window.matchMedia('(max-width: 1100px)').matches
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
  fullscreenSidebarVisible.value = true;
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

const taskBaseLayout = computed(() => graph.value
  ? layoutGitGraph(graph.value, versionOrder.value, branchFilter.value, hideIsolated.value)
  : null);
const taskRuns = computed(() => graph.value && taskBaseLayout.value
  ? taskViewRuns(graph.value, taskBaseLayout.value)
  : []);
const graphLayout = computed<TaskViewLayout | null>(() => {
  const layout = taskBaseLayout.value;
  if (!layout) return null;
  if (graphMode.value === 'tasks') {
    return projectTaskViewLayout(layout, taskRuns.value, new Set(expandedTaskRunIds.value));
  }
  return {
    ...layout,
    rows: layout.rows.map(row => ({ ...row, key: `version:${row.node.id}`, kind: 'version' as const })),
  };
});
const displayHeight = computed(() => Math.max(420, (graphLayout.value?.height ?? 0) + GIT_GRAPH.headerHeight));
const selectedNodes = computed(() => {
  const nodes = new Map((graph.value?.nodes ?? []).map(node => [node.id, node]));
  return selectedNodeIds.value.flatMap(id => nodes.has(id) ? [nodes.get(id)!] : []);
});
const selectedNode = computed(() => selectedNodes.value.length === 1 ? selectedNodes.value[0] : undefined);
watch(selectedNode, node => {
  if (node) nodeSwitchTargetId.value = node.id;
}, { flush: 'sync' });
const selectedTask = computed(() => graph.value?.tasks.find(task => task.id === selectedNode.value?.taskId));
const selectedRelations = computed(() => {
  const ids = new Set(selectedNodeIds.value);
  return graph.value?.edges.filter(edge => ids.has(edge.parentId) || ids.has(edge.childId)) ?? [];
});
const canBuildLinearRelations = computed(() => selectedNodes.value.length >= 2 && selectedRelations.value.length === 0);
const selectedBranch = computed(() => graph.value?.branches.find(branch => branch.id === activeBranchId.value));
const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map(node => [node.id, node])));
const nodeSwitchTarget = computed({
  get: () => nodeById.value.has(nodeSwitchTargetId.value)
    ? nodeSwitchTargetId.value
    : selectedNode.value?.id ?? graph.value?.nodes[0]?.id ?? '',
  set: (nodeId: string) => { nodeSwitchTargetId.value = nodeId; },
});
function taskRunVersions(run: TaskRun): string[] {
  return run.nodeIds.flatMap(id => {
    const version = nodeById.value.get(id)?.version;
    return version ? [version] : [];
  });
}
function taskRunReleasedCount(run: TaskRun): number {
  return run.nodeIds.filter(id => nodeById.value.get(id)?.releasedAt).length;
}
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
const canvasWidth = computed(() => (graphLayout.value?.width ?? 0) + (hideIsolated.value ? 20 : 300));
const graphColumns = computed(() => `${laneWidth.value}px minmax(720px, 1fr)${hideIsolated.value ? '' : ' 280px'}`);
const contentHeight = computed(() => (graphLayout.value?.height ?? 0) + GIT_GRAPH.headerHeight);

function clearSelectionsForFilter() {
  const visible = new Set(graphLayout.value?.rows.map(row => row.node.id) ?? []);
  selectedNodeIds.value = selectedNodeIds.value.filter(id => visible.has(id));
  if (!graphLayout.value?.branchTracks.some(branch => branch.id === activeBranchId.value)) activeBranchId.value = null;
  menu.value = null;
}
function setGraphMode(mode: 'all' | 'tasks') {
  if (graphMode.value === mode) return;
  graphMode.value = mode;
  selectedNodeIds.value = [];
  selectionAnchorId.value = null;
  activeBranchId.value = null;
  menu.value = null;
  hideVersionHint();
}

async function toggleTaskRun(run: TaskRun) {
  const isExpanded = expandedTaskRunIds.value.includes(run.id);
  expandedTaskRunIds.value = isExpanded
    ? expandedTaskRunIds.value.filter(id => id !== run.id)
    : [...expandedTaskRunIds.value, run.id];
  if (isExpanded) {
    const hiddenNodeIds = new Set(run.nodeIds);
    selectedNodeIds.value = selectedNodeIds.value.filter(id => !hiddenNodeIds.has(id));
    if (selectionAnchorId.value && hiddenNodeIds.has(selectionAnchorId.value)) selectionAnchorId.value = null;
    menu.value = null;
    hideVersionHint();
  }
  await nextTick();
  const toggle = [...document.querySelectorAll<HTMLButtonElement>('[data-task-run-id]')]
    .find(button => button.dataset.taskRunId === run.id);
  toggle?.focus({ preventScroll: true });
}
watch(branchFilter, clearSelectionsForFilter);
watch(hideIsolated, () => {
  hideVersionHint();
  closeEditor();
  clearSelectionsForFilter();
});
watch(menu, value => {
  if (value) void nextTick(() => menuElement.value?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
});
watch([panel, branchDeleteTarget, deletionPlan, nodeForm, branchForm], async ([nextPanel, nextBranchDelete, nextDeletion], [previousPanel, previousBranchDelete, previousDeletion]) => {
  if (nextPanel || nextBranchDelete || nextDeletion) fullscreenSidebarVisible.value = true;
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
  selectionAnchorId.value = null;
  graphMode.value = 'all';
  expandedTaskRunIds.value = [];
  activeBranchId.value = null;
  branchFilter.value = null;
  hideIsolated.value = false;
  branchQuery.value = '';
  taskQuery.value = '';
  if (branchFilterDetails.value) branchFilterDetails.value.open = false;
  clearHistory();
  void refresh();
});

async function operation(label: string, action: () => Promise<void>, recordUndo = true): Promise<boolean> {
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
    return true;
  } catch (cause) {
    showError(cause);
    return false;
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
  if (documentChoice.value && event.key === 'Escape') {
    event.preventDefault();
    documentChoice.value = undefined;
    return;
  }
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
    if (hintedNode.value) {
      hideVersionHint();
      return;
    }
    if (isFullscreen.value) return;
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

function onMenuOutsidePointerDown(event: PointerEvent) {
  if (menu.value && !event.composedPath().includes(menuElement.value as EventTarget)) {
    closeMenu(false);
  }
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
  window.addEventListener('scroll', onHintScroll, true);
  window.addEventListener('resize', hideVersionHint);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('keydown', onGlobalKeyDown);
  window.addEventListener('pointerdown', closeBranchFilter);
  window.addEventListener('pointerdown', onMenuOutsidePointerDown, true);
  window.addEventListener('resize', updateSidebarHeight);
  window.addEventListener('scroll', updateSidebarHeight, { passive: true });
  void refresh();
  void refreshComparisonDocuments();
});
onUnmounted(() => {
  documentScanController?.abort();
  clearNodeClickTimer();
  hideVersionHint();
  window.removeEventListener('scroll', onHintScroll, true);
  window.removeEventListener('resize', hideVersionHint);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  window.removeEventListener('keydown', onGlobalKeyDown);
  window.removeEventListener('pointerdown', closeBranchFilter);
  window.removeEventListener('pointerdown', onMenuOutsidePointerDown, true);
  window.removeEventListener('resize', updateSidebarHeight);
  window.removeEventListener('scroll', updateSidebarHeight);
});

function zoomAt(factor: number, clientX?: number, clientY?: number) {
  hideVersionHint();
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

function nodeColor(node: VersionNode): string {
  const branches = graphLayout.value?.memberships.get(node.id) ?? [];
  return branches[0]?.color ?? '#8799b2';
}

function selectNode(nodeId: string, additive: boolean, range = false) {
  const rows = graphLayout.value?.rows ?? [];
  const anchorIndex = rows.findIndex(row => row.node.id === selectionAnchorId.value);
  const targetIndex = rows.findIndex(row => row.node.id === nodeId);
  if (range && anchorIndex >= 0 && targetIndex >= 0) {
    const ids = rows.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
      .map(row => row.node.id);
    selectedNodeIds.value = additive ? [...new Set([...selectedNodeIds.value, ...ids])] : ids;
  } else if (additive) {
    selectedNodeIds.value = selectedNodeIds.value.includes(nodeId)
      ? selectedNodeIds.value.filter(id => id !== nodeId)
      : [...selectedNodeIds.value, nodeId];
  } else {
    selectedNodeIds.value = [nodeId];
  }
  if (!range || anchorIndex < 0) selectionAnchorId.value = selectedNodeIds.value.length ? nodeId : null;
  activeBranchId.value = null;
  menu.value = null;
}

function onNodeClick(nodeId: string, event: MouseEvent) {
  if (editorOpen.value) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (editorDraftDirty.value) {
      clearNodeClickTimer();
      nodeClickTimer = setTimeout(() => {
        nodeClickTimer = undefined;
        requestNodeSwitch(nodeId, 'details');
      }, 500);
      return;
    }
    requestNodeSwitch(nodeId, 'details');
    return;
  }
  if (editorOpen.value) return;
  selectNode(nodeId, event.ctrlKey || event.metaKey, event.shiftKey);
}

function openNodeMenu(event: MouseEvent, nodeId: string) {
  event.preventDefault();
  menuReturnFocus.value = event.currentTarget as HTMLElement;
  if (!selectedNodeIds.value.includes(nodeId)) {
    selectedNodeIds.value = [nodeId];
    selectionAnchorId.value = nodeId;
  }
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
  nodeTaskId.value = '';
  nodeForm.value = { version: '', description: '', parentIds: [...parentIds], targetBranchId: '' };
  nodeDraftBaseline.value = nodeDraftValue();
  panel.value = 'node-add';
  closeMenu(false);
}

function openNodeEdit() {
  if (!selectedNode.value) return;
  nodeTaskId.value = selectedNode.value.taskId ?? '';
  nodeForm.value = {
    version: selectedNode.value.version,
    description: selectedNode.value.description,
    parentIds: [],
    targetBranchId: '',
  };
  nodeDraftBaseline.value = nodeDraftValue();
  panel.value = 'node-edit';
}

function openNodeEditFor(nodeId: string) {
  const node = nodeById.value.get(nodeId);
  if (!node) return;
  clearNodeClickTimer();
  branchDeleteTarget.value = null;
  deletionPlan.value = null;
  relationPreview.value = undefined;
  selectedNodeIds.value = [nodeId];
  selectionAnchorId.value = nodeId;
  activeBranchId.value = null;
  closeMenu(false);
  nodeTaskId.value = node.taskId ?? '';
  nodeForm.value = { version: node.version, description: node.description, parentIds: [], targetBranchId: '' };
  nodeDraftBaseline.value = nodeDraftValue();
  error.value = '';
  status.value = '';
  panel.value = 'node-edit';
}

function openNodeDetailsFor(nodeId: string) {
  if (!nodeById.value.has(nodeId)) return;
  clearNodeClickTimer();
  panel.value = null;
  branchDeleteTarget.value = null;
  deletionPlan.value = null;
  relationPreview.value = undefined;
  selectedNodeIds.value = [nodeId];
  selectionAnchorId.value = nodeId;
  activeBranchId.value = null;
  closeMenu(false);
  error.value = '';
  status.value = '';
  panel.value = null;
}

function openNodeTarget(nodeId: string, mode: 'details' | 'edit') {
  if (mode === 'details') openNodeDetailsFor(nodeId);
  else openNodeEditFor(nodeId);
}

function requestNodeSwitch(nodeId: string, mode: 'details' | 'edit') {
  if (saving.value || pendingNodeSwitch.value || !nodeById.value.has(nodeId)) return;
  if (panel.value === 'node-edit' && selectedNode.value?.id === nodeId && mode === 'edit') return;
  const source = editorDraftSource.value;
  if (source && editorDraftDirty.value) {
    pendingNodeSwitch.value = { nodeId, mode, source };
    return;
  }
  openNodeTarget(nodeId, mode);
}

function navigateFromEditor(mode: 'details' | 'edit') {
  if (!nodeSwitchTarget.value) {
    status.value = '当前项目没有可切换的版本。';
    return;
  }
  requestNodeSwitch(nodeSwitchTarget.value, mode);
}

function editNodeFromDoubleClick(nodeId: string) {
  clearNodeClickTimer();
  requestNodeSwitch(nodeId, 'edit');
}

function cancelNodeSwitch() {
  pendingNodeSwitch.value = null;
}

function discardAndSwitchNode() {
  const target = pendingNodeSwitch.value;
  pendingNodeSwitch.value = null;
  if (target) openNodeTarget(target.nodeId, target.mode);
}

async function saveAndSwitchNode() {
  const target = pendingNodeSwitch.value;
  if (!target || saving.value || !nodeSwitchCanSave.value) return;
  let saved = false;
  if (target.source === 'tasks') saved = await saveTaskDraft();
  else if (target.source === 'parent-edit') saved = await submitParentEdit();
  else if (target.source === 'branch-add' || target.source === 'branch-edit') saved = await submitBranch();
  else saved = await submitNode();
  if (!saved) return;
  pendingNodeSwitch.value = null;
  openNodeTarget(target.nodeId, target.mode);
}

function openParentEdit() {
  if (!selectedNode.value || selectedNode.value.releasedAt) return;
  nodeForm.value = {
    version: selectedNode.value.version,
    description: selectedNode.value.description,
    parentIds: [...(parentIdsOf.value.get(selectedNode.value.id) ?? [])],
    targetBranchId: '',
  };
  nodeTaskId.value = selectedNode.value.taskId ?? '';
  nodeDraftBaseline.value = nodeDraftValue();
  panel.value = 'parent-edit';
}

function openMerge() {
  nodeTaskId.value = '';
  nodeForm.value = { version: '', description: '', parentIds: [...selectedNodeIds.value], targetBranchId: '' };
  nodeDraftBaseline.value = nodeDraftValue();
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
    .filter(node => !deletionPlan.value!.nodeIds.includes(node.id)
      && !deletionChildParentChoices.value[childId]?.includes(node.id));
}

function addDeletionParent(childId: string, parentId: string) {
  if (saving.value || nodeById.value.get(childId)?.releasedAt
    || !deletionParentCandidates(childId).some(node => node.id === parentId)) return;
  deletionChildParentChoices.value[childId]?.push(parentId);
}

function removeDeletionParent(childId: string, parentId: string) {
  if (saving.value || nodeById.value.get(childId)?.releasedAt) return;
  deletionChildParentChoices.value[childId] = (deletionChildParentChoices.value[childId] ?? [])
    .filter(id => id !== parentId);
}

async function submitNode(): Promise<boolean> {
  const actionPanel = panel.value;
  if (actionPanel !== 'node-add' && actionPanel !== 'node-edit' && actionPanel !== 'merge') return false;
  return operation(actionPanel === 'node-edit' ? '编辑版本' : actionPanel === 'merge' ? '合并版本' : '新增版本', async () => {
    const current = graph.value!;
    if (actionPanel === 'node-add') {
      const node = createNode(current, nodeForm.value);
      graph.value = await props.repository.addNode(
        props.projectId, current.project.revision, node, nodeForm.value.parentIds, nodeForm.value.targetBranchId || null,
      );
      status.value = '版本已新增。';
    } else if (actionPanel === 'node-edit') {
      graph.value = await props.repository.saveNode(props.projectId, current.project.revision, selectedNode.value!.id, {
        version: nodeForm.value.version,
        description: nodeForm.value.description,
        taskId: nodeTaskId.value || null,
      });
      status.value = '版本已更新。';
    } else if (actionPanel === 'merge') {
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
    taskId: nodeTaskId.value || null,
    releasedAt: null,
  };
}

async function submitParentEdit(): Promise<boolean> {
  if (!selectedNode.value) return false;
  return operation('设置父版本', async () => {
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
  branchDraftBaseline.value = branchDraftValue();
  panel.value = 'branch-add';
  closeMenu(false);
}

function openBranchEdit(branchId?: string) {
  const branch = branchId
    ? graph.value?.branches.find(item => item.id === branchId)
    : selectedBranch.value;
  if (!branch) return;
  branchForm.value = { ...branch };
  branchDraftBaseline.value = branchDraftValue();
  branchEditRevision.value = graph.value!.project.revision;
  panel.value = 'branch-edit';
}

async function submitBranch() {
  return operation(panel.value === 'branch-add' ? '创建分支' : '编辑分支', async () => {
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

function openRelationPreview(action: BatchRelationAction) {
  if (saving.value || !graph.value) return;
  closeMenu(false);
  try {
    const current = graph.value;
    const nodeIds = [...selectedNodeIds.value];
    const next = changeVersionRelations(current, nodeIds, action);
    const oldEdges = new Set(current.edges.map(edge => edge.id));
    relationPreview.value = {
      action, nodeIds, revision: current.project.revision,
      edges: action === 'clear' ? [...selectedRelations.value] : next.edges.filter(edge => !oldEdges.has(edge.id)),
    };
    error.value = '';
    status.value = '';
    panel.value = 'relations';
  } catch (cause) {
    showError(cause);
  }
}

async function confirmRelations() {
  const preview = relationPreview.value;
  if (!preview || saving.value) return;
  await operation(preview.action === 'clear' ? '清除父子关联' : '构建线性关联', async () => {
    graph.value = await props.repository.changeRelations(props.projectId, preview.revision, preview.nodeIds, preview.action);
    status.value = `已${preview.action === 'clear' ? '清除' : '构建'} ${preview.edges.length} 条父子关联，版本及分支指针保持不变。`;
    panel.value = null;
    relationPreview.value = undefined;
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
  fullscreenSidebarVisible.value = true;
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

function startIqanAction(action: 'open' | 'compare', nodeIds: readonly string[]) {
  if (saving.value || editorOpen.value) return;
  closeMenu(false);
  iqanIntegration.value?.open(action, nodeIds);
}

function onIqanDialogClosed() {
  void nextTick(() => graphScroller.value?.focus({ preventScroll: true }));
}
</script>

<template>
  <section ref="graphWorkspace" class="panel graph-workspace" :class="{ 'is-fullscreen': isFullscreen, 'fullscreen-sidebar-hidden': !fullscreenSidebarVisible }" aria-labelledby="graph-title" :aria-busy="saving">
    <div class="graph-controls">
    <div class="section-heading">
      <div><p class="eyebrow">VERSION GRAPH</p><h2 id="graph-title">版本分支图</h2></div>
      <div class="actions">
        <button ref="fullscreenButton" class="secondary icon-button" :disabled="fullscreenPending" :aria-label="isFullscreen ? '退出全屏' : '全屏查看分支图'" :title="isFullscreen ? '退出全屏（Esc）' : '全屏查看分支图'" :aria-pressed="isFullscreen" @click="toggleFullscreen"><AppIcon :name="isFullscreen ? 'collapse' : 'fit'" /></button>
        <template v-if="isFullscreen">
          <button class="secondary icon-button" aria-label="切换悬浮工具栏" title="显示/隐藏悬浮工具栏" :aria-expanded="fullscreenToolsVisible" aria-controls="graph-command-toolbar" @click="fullscreenToolsVisible = !fullscreenToolsVisible"><AppIcon name="tools" /></button>
          <button class="secondary icon-button" aria-label="切换悬浮编辑窗口" title="显示/隐藏悬浮编辑窗口，保留未保存输入" :aria-expanded="fullscreenSidebarVisible" aria-controls="graph-inspector" @click="toggleFullscreenSidebar"><AppIcon name="edit" /></button>
        </template>
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

    <div v-if="graph" v-show="!isFullscreen || fullscreenToolsVisible" id="graph-command-toolbar" class="graph-toolbar">
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
              <p class="form-help">多选显示历史并集；游离版本可通过旁边开关隐藏。</p>
            </div>
          </details>
        </div>
        <label class="graph-isolated-toggle">
          <input v-model="hideIsolated" type="checkbox" role="switch" :disabled="saving || editorOpen" />
          <span>隐藏未关联版本</span>
        </label>
        <div class="graph-mode-toggle" role="group" aria-label="版本图浏览模式">
          <button type="button" class="secondary" :aria-pressed="graphMode === 'all'" :disabled="saving" @click="setGraphMode('all')">全部版本</button>
          <button type="button" class="secondary" :aria-pressed="graphMode === 'tasks'" :disabled="saving" @click="setGraphMode('tasks')">按任务聚合</button>
        </div>
        <button class="tool-button" :disabled="saving" :aria-label="`切换版本排序，当前${versionOrder === 'oldest' ? '旧到新' : '新到旧'}`" :title="`切换版本排序，当前${versionOrder === 'oldest' ? '旧到新' : '新到旧'}；父子关系优先`" @click="versionOrder = versionOrder === 'oldest' ? 'newest' : 'oldest'">
          <AppIcon name="sort" /><span class="tool-caption">{{ versionOrder === 'oldest' ? '旧 → 新' : '新 → 旧' }}</span>
        </button>
        <button class="tool-button" :disabled="!undoAvailable" aria-label="撤销上一步" aria-keyshortcuts="Control+z Meta+z" :title="undoLabel ? `撤销：${undoLabel}（Ctrl/Cmd+Z）` : '撤销上一步（Ctrl/Cmd+Z）'" @click="undo">
          <AppIcon name="undo" /><span class="tool-caption">撤销</span>
        </button>
        <button class="tool-button tool-button-accent" :disabled="saving" aria-label="新增未关联版本" title="新增版本，默认放入未关联版本列" @click="openNodeAdd()"><AppIcon name="plus" /><span class="tool-caption">新增版本</span></button>
        <button class="tool-button" :disabled="saving" aria-label="管理任务" title="创建、编辑任务与外部 Task ID；删除任务仅解除版本关联" @click="openTasks"><AppIcon name="file" /><span class="tool-caption">任务管理</span></button>
        <button class="tool-button" :disabled="saving || editorOpen" aria-label="查看软件对比文档" title="软件对比文档" @click="emit('documents')"><AppIcon name="documents" /><span class="tool-caption">软件对比文档</span></button>
        <button class="tool-button" :disabled="saving || editorOpen" aria-label="管理分支顺序" title="查看全部分支并调整顺序；顺序决定共享节点与连线的颜色及优先轨道" @click="openBranchManager"><AppIcon name="branch" /><span class="tool-caption">分支管理</span></button>
      </div>

      <div class="graph-toolbar-row">
        <button class="tool-button" :disabled="saving || editorOpen || selectedNodeIds.length !== 1" aria-label="在 IQANdesign 中打开选中版本" title="重新扫描并检查文件后，请求本地启动器打开工程" @click="startIqanAction('open', selectedNodeIds)"><AppIcon name="file" /><span class="tool-caption">打开工程</span></button>
        <button class="tool-button tool-button-accent" :disabled="saving || editorOpen || selectedNodeIds.length !== 2" aria-label="对比选中的两个版本" title="按当前选择顺序预览并对比两个工程文件" @click="startIqanAction('compare', selectedNodeIds)"><AppIcon name="compare" /><span class="tool-caption">对比工程</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1" aria-label="新增子版本" title="为选中的一个版本新增子版本" @click="startNodeAction('add')"><AppIcon name="plus" /><span class="tool-caption">新增子版本</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1" aria-label="编辑版本" title="编辑选中版本的版本号与说明；已放行版本仅可编辑说明" @click="startNodeAction('edit')"><AppIcon name="edit" /><span class="tool-caption">编辑</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1 || !!selectedNode?.releasedAt" aria-label="设置父版本" title="搜索选择父版本；已放行版本不可修改父边" @click="startNodeAction('parents')"><AppIcon name="link" /><span class="tool-caption">设置父版本</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length < 2" aria-label="合并版本" title="选择至少两个版本后创建合并版本" @click="startNodeAction('merge')"><AppIcon name="merge" /><span class="tool-caption">合并</span></button>
        <button class="tool-button tool-button-danger" :disabled="saving || selectedNodeIds.length < 2 || !selectedRelations.length" aria-label="清除父子关联" title="预览清除所选版本的全部直接父子边，包括与未选版本的关系；已放行父边不可修改" @click="openRelationPreview('clear')"><AppIcon name="clear" /><span class="tool-caption">清除关联</span></button>
        <button class="tool-button" :disabled="saving || !canBuildLinearRelations" aria-label="构建线性关联" title="将所选游离版本按版本号从旧到新线性关联；不受当前显示排序影响" @click="openRelationPreview('linear')"><AppIcon name="link" /><span class="tool-caption">线性关联</span></button>
        <button class="tool-button" :disabled="saving || selectedNodeIds.length !== 1" :aria-label="selectedNode?.releasedAt ? '撤销放行' : '放行版本'" :title="selectedNode?.releasedAt ? '撤销选中版本的放行；不可破坏已放行后代闭包' : '放行选中版本及其全部祖先'" @click="startNodeAction('release')">
          <AppIcon :name="selectedNode?.releasedAt ? 'unrelease' : 'release'" /><span class="tool-caption">{{ selectedNode?.releasedAt ? '撤销放行' : '放行' }}</span>
        </button>
        <button class="tool-button tool-button-danger" :disabled="saving || selectedNodeIds.length === 0" aria-label="删除所选版本" title="预览删除所选版本及关系重连，确认后才执行" @click="startNodeAction('delete')"><AppIcon name="trash" /><span class="tool-caption">删除版本</span></button>
        <button class="tool-button" :disabled="saving || (selectedNodeIds.length !== 1 && !selectedBranch)" aria-label="创建分支" title="从选中版本或分支头创建分支" @click="selectedBranch ? openBranchAdd(selectedBranch.headId) : startNodeAction('branch')"><AppIcon name="branch" /><span class="tool-caption">创建分支</span></button>
      </div>

      <div v-if="selectedBranch" class="graph-branch-actions" :style="{ '--branch-color': selectedBranch.color }">
        <span class="branch-selected-indicator">{{ selectedBranch.name }}<small>· 头：{{ nodeById.get(selectedBranch.headId)?.version ?? '未知' }}</small></span>
        <button class="tool-button" :disabled="saving" aria-label="编辑分支" title="编辑选中分支的名称、说明与颜色" @click="openBranchEdit()"><AppIcon name="edit" /><span class="tool-caption">编辑分支</span></button>
        <button class="tool-button" :disabled="saving" aria-label="放行分支" title="放行选中分支的头版本及全部祖先" @click="releaseBranch"><AppIcon name="release" /><span class="tool-caption">放行分支</span></button>
        <button class="tool-button" :disabled="saving" aria-label="从此分支创建分支" title="从选中分支的头版本创建分支" @click="openBranchAdd(selectedBranch.headId)"><AppIcon name="branch" /><span class="tool-caption">创建分支</span></button>
        <button class="tool-button tool-button-danger" :disabled="saving" aria-label="删除分支" title="删除分支记录，保留版本及父子关系；需确认" @click="openBranchDelete"><AppIcon name="trash" /><span class="tool-caption">删除分支</span></button>
      </div>
      <span role="status" class="selection-count">已选 {{ selectedNodeIds.length }} / {{ graph.nodes.length }} 个版本 · Ctrl/Cmd 点击离散多选 · Shift 点击连续多选</span>
    </div>
    </div>
    <div v-if="graph" class="graph-layout" :class="{ 'is-editing': editorOpen }">
      <div ref="canvasViewport" class="graph-viewport" :style="viewportSize ? { width: `${viewportSize.width}px`, height: `${viewportSize.height}px` } : undefined">
      <div
        ref="graphScroller"
        class="graph-canvas-scroll"
        role="region"
        tabindex="0"
        aria-label="版本历史图。普通滚轮上下滚动，Shift 加滚轮左右滚动，Ctrl 加滚轮缩放。"
        @wheel="onWheel"
      >
        <div class="git-graph-canvas" :style="{ width: `${canvasWidth * scale}px`, height: `${displayHeight * scale}px` }">
          <div class="git-graph-zoom-content" :style="{ width: `${canvasWidth}px`, height: `${displayHeight}px`, transform: `scale(${scale})`, '--graph-header-height': `${GIT_GRAPH.headerHeight}px`, '--graph-row-height': `${GIT_GRAPH.rowHeight}px` }">
            <div class="git-graph-column-head" :style="{ gridTemplateColumns: graphColumns }">
              <span>分支轨道</span><span>版本 / 任务与改动信息 · 分支标签位于版本右侧</span><span v-if="!hideIsolated">未关联版本</span>
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
                :d="gitGraphEdgePath(edge)"
                class="git-graph-edge"
                :style="{ stroke: edge.color }"
              />
              <circle
                v-for="row in graphLayout.rows.filter(row => !row.isolated && row.kind !== 'task-header')"
                :key="row.key"
                :cx="GIT_GRAPH.laneStart + row.laneIndex * GIT_GRAPH.laneGap"
                :cy="GIT_GRAPH.headerHeight + row.rowIndex * GIT_GRAPH.rowHeight + GIT_GRAPH.rowHeight / 2"
                r="6"
                class="git-graph-commit"
                :style="{ stroke: selectedNodeIds.includes(row.node.id) ? '#0b1321' : nodeColor(row.node), fill: selectedNodeIds.includes(row.node.id) ? nodeColor(row.node) : undefined }"
              />
            </svg>
            <div class="git-graph-rows">
              <div
                v-for="row in graphLayout?.rows ?? []"
                :key="row.key"
                class="git-graph-row"
                :class="[
                  { selected: row.kind === 'version' && selectedNodeIds.includes(row.node.id), isolated: row.isolated, 'branch-drop-target': row.kind === 'version' && dropTargetId === row.node.id },
                  row.taskRun && row.groupPosition ? `task-run-${row.groupPosition}` : '',
                  `git-graph-row-${row.kind}`,
                ]"
                @dragover="row.kind === 'version' && onBranchDragOver($event, row.node.id)"
                @dragleave="row.kind === 'version' && dropTargetId === row.node.id && (dropTargetId = null)"
                @drop="row.kind === 'version' && dropBranch($event, row.node.id)"
                :style="{ gridTemplateColumns: graphColumns }"
              >
                <div class="git-graph-lanes" aria-hidden="true"></div>
                <div class="git-graph-main-cell" :class="{ 'has-version-slot': row.kind === 'version' && !row.isolated }">
                  <button
                    v-if="row.kind === 'version' && !row.isolated && (comparisonDocumentsByNode.get(row.node.id)?.length ?? 0) > 0"
                    type="button" class="git-document-action git-document-slot"
                    :aria-label="`打开版本 ${row.node.version} 的软件对比文档${comparisonDocumentsByNode.get(row.node.id)!.length > 1 ? `，${comparisonDocumentsByNode.get(row.node.id)!.length} 份` : ''}`"
                    :title="`打开软件对比文档（${comparisonDocumentsByNode.get(row.node.id)!.length} 份）`"
                    @pointerdown.stop @click="openNodeDocuments($event, row.node)"><AppIcon name="documents" /></button>
                  <span v-else-if="row.kind === 'version' && !row.isolated" class="git-document-slot-empty" aria-hidden="true"></span>
                  <button
                    v-if="row.kind === 'task-summary' && row.taskRun"
                    type="button"
                    class="git-row-commit git-task-summary"
                    :data-task-run-id="row.taskRun.id"
                    :aria-expanded="false"
                    :aria-label="`${row.taskRun.task.externalTaskId ? `任务编号 ${row.taskRun.task.externalTaskId}，` : ''}${row.taskRun.task.name}，${row.taskRun.nodeIds.length} 个连续版本：${taskRunVersions(row.taskRun).join('、')}，点击展开`"
                    :disabled="saving"
                    @click="toggleTaskRun(row.taskRun)"
                  >
                    <AppIcon class="git-release-icon" name="file" />
                    <span class="task-summary-heading">
                      <code v-if="row.taskRun.task.externalTaskId" class="task-reference-id">{{ row.taskRun.task.externalTaskId }}</code>
                      <span>{{ row.taskRun.task.name }}</span>
                    </span>
                    <span class="task-summary-details">
                      {{ row.taskRun.nodeIds.length }} 个连续版本
                      · 已放行 {{ taskRunReleasedCount(row.taskRun) }} 个
                      · {{ taskRunVersions(row.taskRun).join('、') }}
                      · 点击展开
                    </span>
                  </button>
                  <button
                    v-else-if="row.kind === 'task-header' && row.taskRun"
                    type="button"
                    class="git-row-commit git-task-expanded-toggle"
                    :data-task-run-id="row.taskRun.id"
                    :aria-expanded="true"
                    :aria-label="`${row.taskRun.task.name}，已展开 ${row.taskRun.nodeIds.length} 个连续版本，点击收起`"
                    :disabled="saving"
                    @click="toggleTaskRun(row.taskRun)"
                  >
                    <AppIcon class="git-release-icon" name="file" />
                    <span class="task-summary-heading">
                      <code v-if="row.taskRun.task.externalTaskId" class="task-reference-id">{{ row.taskRun.task.externalTaskId }}</code>
                      <span>{{ row.taskRun.task.name }}</span>
                    </span>
                    <span class="task-summary-details">
                      已展开 {{ row.taskRun.nodeIds.length }} 个连续版本 · 点击收起
                    </span>
                  </button>
                  <button
                    v-else-if="!row.isolated"
                    class="git-row-commit"
                    :class="{ 'is-released': row.node.releasedAt }"
                    :aria-label="`版本 ${row.node.version}${row.node.releasedAt ? '，已放行' : '，未放行'}${row.node.description ? `，${row.node.description}` : ''}`"
                    :aria-pressed="selectedNodeIds.includes(row.node.id)"
                    :aria-describedby="hintedNode?.id === row.node.id ? 'version-info-hint' : undefined"
                    @mouseenter="showVersionHint($event, row.node)" @mouseleave="scheduleHintClose"
                    @focus="showVersionHint($event, row.node)" @blur="scheduleHintClose"
                    @pointerdown="hideVersionHint"
                    @click="onNodeClick(row.node.id, $event)"
                    @dblclick.prevent="editNodeFromDoubleClick(row.node.id)"
                    @mousedown.shift.prevent
                    @contextmenu="openNodeMenu($event, row.node.id)"
                  >
                    <AppIcon class="git-release-icon" :name="row.node.releasedAt ? 'release' : 'unrelease'" />
                    <span class="git-commit-version">{{ row.node.version }}</span>
                    <span class="git-commit-description">{{ row.node.description || '（无改动说明）' }}</span>
                  </button>
                  <div v-if="row.kind !== 'task-header' && !row.isolated && row.branchHeads.length" class="git-node-accessories">
                  <span v-if="row.branchHeads.length" class="git-branch-labels">
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
                </div>
                <div v-if="!hideIsolated" class="git-graph-orphan-cell" :class="{ 'has-version-slot': row.kind === 'version' && row.isolated }">
                  <button
                    v-if="row.kind === 'version' && row.isolated && (comparisonDocumentsByNode.get(row.node.id)?.length ?? 0) > 0"
                    type="button" class="git-document-action git-orphan-document-action"
                    :aria-label="`打开未关联版本 ${row.node.version} 的软件对比文档`"
                    :title="`打开软件对比文档（${comparisonDocumentsByNode.get(row.node.id)!.length} 份）`"
                    @pointerdown.stop @click="openNodeDocuments($event, row.node)"><AppIcon name="documents" /></button>
                  <span v-else-if="row.kind === 'version' && row.isolated" class="git-document-slot-empty" aria-hidden="true"></span>
                  <button
                    v-if="row.kind === 'version' && row.isolated"
                    class="git-row-commit git-row-orphan"
                    :class="{ selected: selectedNodeIds.includes(row.node.id), 'is-released': row.node.releasedAt }"
                    :aria-label="`未关联版本 ${row.node.version}${row.node.releasedAt ? '，已放行' : '，未放行'}${row.node.description ? `，${row.node.description}` : ''}`"
                    :aria-pressed="selectedNodeIds.includes(row.node.id)"
                    :aria-describedby="hintedNode?.id === row.node.id ? 'version-info-hint' : undefined"
                    @mouseenter="showVersionHint($event, row.node)" @mouseleave="scheduleHintClose"
                    @focus="showVersionHint($event, row.node)" @blur="scheduleHintClose"
                    @pointerdown="hideVersionHint"
                    @click="onNodeClick(row.node.id, $event)"
                    @dblclick.prevent="editNodeFromDoubleClick(row.node.id)"
                    @mousedown.shift.prevent
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
              <p v-else-if="!graphLayout?.rows.length && graphMode === 'tasks'" class="git-graph-empty">当前筛选下没有分支版本；请调整分支范围或游离版本设置。</p>
              <p v-else-if="!graphLayout?.rows.length" class="git-graph-empty">当前筛选下没有可见版本。请关闭“隐藏未关联版本”或调整分支范围。</p>
            </div>
          </div>
        </div>
      </div>

      <div v-if="menu" ref="menuElement" class="graph-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu" tabindex="-1" :aria-label="menu.kind === 'node' ? '版本操作' : '分支操作'" @keydown="onMenuKeyDown">
        <template v-if="menu.kind === 'node' && selectedNodeIds.length > 1">
          <button role="menuitem" :disabled="saving || editorOpen || selectedNodeIds.length !== 2" @click="startIqanAction('compare', selectedNodeIds)"><AppIcon name="compare" />对比所选版本（已选 {{ selectedNodeIds.length }} 个）</button>
          <button role="menuitem" :disabled="saving" @click="startNodeAction('merge'); closeMenu(false)"><AppIcon name="merge" />合并所选版本</button>
          <button role="menuitem" :disabled="saving || !selectedRelations.length" @click="openRelationPreview('clear')"><AppIcon name="clear" />清除父子关联</button>
          <button role="menuitem" :disabled="saving || !canBuildLinearRelations" @click="openRelationPreview('linear')"><AppIcon name="link" />构建线性关联</button>
          <button role="menuitem" :disabled="saving" @click="openDeletion"><AppIcon name="trash" />删除所选版本</button>
        </template>
        <template v-else-if="menu.kind === 'node'">
          <button role="menuitem" :disabled="saving || editorOpen" @click="startIqanAction('open', [menu.id])"><AppIcon name="file" />在 IQANdesign 中打开</button>
          <button role="menuitem" disabled><AppIcon name="compare" />对比所选版本（需选中 2 个）</button>
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
      <IqanIntegrationDialog
        v-if="graph"
        ref="iqanIntegration"
        :graph="graph"
        :repository="repository"
        :project-id="projectId"
        @status="status = $event"
        @closed="onIqanDialogClosed"
      />
      <dialog ref="documentChoiceDialog" class="branch-move-dialog document-choice-dialog" aria-labelledby="document-choice-title"
        @cancel.prevent="documentChoice = undefined" @close="documentChoice = undefined"
        @keydown.escape.prevent.stop="documentChoice = undefined">
        <h3 id="document-choice-title">选择软件对比文档</h3>
        <p>版本 {{ documentChoice?.version }} 有多份文档。</p>
        <label for="version-document-choice">打开文档</label>
        <select id="version-document-choice" v-if="documentChoice" v-model="selectedDocumentPath">
          <option v-for="file in documentChoice.files" :key="file.relativePath" :value="file.relativePath">{{ file.relativePath }}</option>
        </select>
        <div class="actions">
          <button type="button" :disabled="saving || !selectedDocumentPath" @click="documentChoice && requestNodeDocument(documentChoice.nodeId, selectedDocumentPath)">在 Word 中打开</button>
          <button type="button" class="secondary" :disabled="saving" @click="documentChoice = undefined">取消</button>
        </div>
      </dialog>
      <button
        v-show="!isFullscreen" class="graph-resize-handle" aria-label="调整历史画布尺寸"
        title="拖拽调整宽高；方向键调整，Shift 加速，Home 恢复默认"
        @pointerdown="startViewportResize" @pointermove="moveViewportResize"
        @pointerup="endViewportResize" @pointercancel="endViewportResize" @lostpointercapture="endViewportResize"
        @keydown="onResizeKeydown" @dblclick="viewportSize = null"
      ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 19 19 7 M13 19l6-6 M19 19h0" /></svg></button>
      </div>

      <div v-show="!isFullscreen || fullscreenSidebarVisible" id="graph-inspector" ref="editorSidebar" class="graph-sidebar" :class="{ 'is-editing': editorOpen }" @focusout="onSidebarFocusOut">
        <div v-if="isFullscreen" class="fullscreen-window-heading">
          <span>{{ editorOpen ? '悬浮编辑窗口' : '分支与版本详情' }}</span>
          <button class="icon-button" aria-label="收起悬浮编辑窗口" title="收起窗口，保留未保存输入" @click="toggleFullscreenSidebar"><AppIcon name="clear" /></button>
        </div>
        <div v-if="editorOpen" class="graph-editor-heading">
          <span>图操作面板</span>
          <button class="icon-button" :disabled="saving" aria-label="关闭操作面板" title="关闭操作面板（Escape）" @click="closeEditor"><AppIcon name="clear" /></button>
        </div>
        <div v-if="editorOpen && graph && graph.nodes.length" class="graph-node-switcher" role="group" aria-label="切换版本">
          <label for="graph-node-switch-target">切换到版本</label>
          <select id="graph-node-switch-target" v-model="nodeSwitchTarget" :disabled="saving || !!pendingNodeSwitch">
            <option v-for="node in graph.nodes" :key="node.id" :value="node.id">{{ node.version }}</option>
          </select>
          <div class="graph-node-switcher-actions">
            <button type="button" class="secondary" :disabled="saving || !!pendingNodeSwitch" @click="navigateFromEditor('details')">查看详情</button>
            <button type="button" class="secondary" :disabled="saving || !!pendingNodeSwitch" @click="navigateFromEditor('edit')">编辑版本</button>
          </div>
          <p class="form-help">也可在图中单击版本查看详情、双击版本进入编辑。</p>
        </div>
        <div v-if="error" role="alert" class="error"><h3 ref="errorHeading" tabindex="-1">图操作未完成</h3><p>{{ error }}</p></div>
        <p role="status" class="status">{{ status }}</p>
      <template v-if="!editorOpen">
      <aside v-if="selectedNode" class="graph-detail" aria-label="版本详情">
        <p class="eyebrow">VERSION DETAIL</p>
        <h3>{{ selectedNode.version }}</h3>
        <section class="version-description-card" aria-label="改动说明">
          <div v-if="selectedNode.description.trim()" class="markdown-content" v-html="renderMarkdown(selectedNode.description)"></div>
          <p v-else class="markdown-empty">（无改动说明）</p>
        </section>
        <p class="workspace-details">状态：{{ selectedNode.releasedAt ? '已放行' : '未放行' }}</p>
        <p class="workspace-details">所属任务：<span v-if="selectedTask" class="task-reference"><code v-if="selectedTask.externalTaskId" class="task-reference-id">{{ selectedTask.externalTaskId }}</code><span class="task-reference-name">{{ selectedTask.name }}</span></span><span v-else>未关联任务</span></p>
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
          <button class="tool-button" :disabled="saving" aria-label="编辑分支" title="编辑分支名称、说明与颜色" @click="openBranchEdit()"><AppIcon name="edit" /><span class="tool-caption">编辑</span></button>
          <button class="tool-button" :disabled="saving" aria-label="放行分支" title="放行分支头及全部祖先" @click="releaseBranch"><AppIcon name="release" /><span class="tool-caption">放行分支</span></button>
          <button class="tool-button" :disabled="saving" aria-label="从此分支创建分支" title="从当前分支头创建分支" @click="openBranchAdd(selectedBranch.headId)"><AppIcon name="branch" /><span class="tool-caption">创建分支</span></button>
          <button class="tool-button tool-button-danger" :disabled="saving" aria-label="删除分支" title="删除分支记录，版本及父子关系保留；需确认" @click="openBranchDelete"><AppIcon name="trash" /><span class="tool-caption">删除分支</span></button>
        </div>
      </aside>

      <aside v-else class="graph-detail" aria-label="分支图例">
        <p class="eyebrow">BRANCHES</p>
        <ul class="graph-branch-list">
          <li v-for="branch in orderedBranchList" :key="branch.id">
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

    <div v-if="panel === 'relations' && relationPreview" class="graph-form" role="dialog" aria-modal="false" aria-label="批量父子关联确认">
      <h3 tabindex="-1">{{ relationPreview.action === 'clear' ? '清除父子关联' : '构建线性关联' }}</h3>
      <p>已选 {{ relationPreview.nodeIds.length }} 个版本，将{{ relationPreview.action === 'clear' ? '清除' : '新增' }} {{ relationPreview.edges.length }} 条关系。</p>
      <p class="form-help">{{ relationPreview.action === 'clear' ? '包括所选版本与未选版本之间的直接父子边，不自动重连。' : '按版本号从旧到新关联，左侧为父版本，右侧为子版本；与点击顺序、当前显示排序无关。' }}版本、任务、放行状态及分支指针保持不变；可撤销。</p>
      <ul class="selected-parent-list" aria-label="父子关联预览">
        <li v-for="edge in relationPreview.edges" :key="edge.id"><span>{{ nodeById.get(edge.parentId)?.version }} → {{ nodeById.get(edge.childId)?.version }}</span></li>
      </ul>
      <div class="actions">
        <button :class="relationPreview.action === 'clear' ? 'danger' : ''" :disabled="saving || graph.project.revision !== relationPreview.revision" @click="confirmRelations">确认{{ relationPreview.action === 'clear' ? '清除' : '构建' }}</button>
        <button class="secondary" :disabled="saving" @click="closeEditor">取消</button>
      </div>
      <p v-if="graph.project.revision !== relationPreview.revision" role="alert" class="error">版本图已更新，请取消并重新预览。</p>
    </div>

    <div v-if="branchDeleteTarget" class="graph-form" role="dialog" aria-modal="false" aria-label="删除分支确认">
      <h3 tabindex="-1">删除分支记录</h3>
      <p>将删除“{{ graph?.branches.find(branch => branch.id === branchDeleteTarget)?.name }}”分支记录，不会删除版本、关系或磁盘文件。</p>
      <div class="actions">
        <button class="danger" :disabled="saving" @click="confirmBranchDelete"><AppIcon name="trash" />确认删除分支</button>
        <button class="secondary" :disabled="saving" @click="branchDeleteTarget = null">取消</button>
      </div>
    </div>

    <div v-if="panel === 'branch-manager'" class="graph-form" role="dialog" aria-modal="false" aria-label="分支管理">
      <h3 tabindex="-1">分支管理与顺序</h3>
      <p class="form-help">顺序靠前的分支优先占用直线轨道，并决定共享版本节点及共同父边的显示颜色。调整仅改变显示优先级，不修改版本关系或分支头。</p>
      <ol class="branch-order-list" aria-label="全部分支，按优先级排序">
        <li v-for="(branch, index) in orderedBranchList" :key="branch.id">
          <span class="branch-order-index" aria-label="顺序">{{ index + 1 }}</span>
          <span class="graph-branch-swatch" :style="{ background: branch.color }" aria-hidden="true"></span>
          <span class="branch-order-info">
            <strong>{{ branch.name }}</strong>
            <small>头：{{ nodeById.get(branch.headId)?.version ?? '未知' }}</small>
          </span>
          <div class="branch-order-actions">
            <button type="button" class="secondary icon-button" :disabled="saving || index === 0" :aria-label="`上移分支 ${branch.name}`" :title="`上移 ${branch.name}`" @click="moveBranchOrder(branch.id, -1)">↑</button>
            <button type="button" class="secondary icon-button" :disabled="saving || index === orderedBranchList.length - 1" :aria-label="`下移分支 ${branch.name}`" :title="`下移 ${branch.name}`" @click="moveBranchOrder(branch.id, 1)">↓</button>
            <button type="button" class="secondary" :disabled="saving" :aria-label="`编辑分支 ${branch.name}`" @click="openBranchEdit(branch.id)">编辑</button>
          </div>
        </li>
      </ol>
      <p v-if="!orderedBranchList.length" class="form-help">尚无分支。选择版本后创建分支。</p>
      <div class="actions">
        <button type="button" class="secondary" :disabled="saving" @click="closeEditor">关闭</button>
      </div>
    </div>

    <div v-if="panel === 'tasks'" class="graph-form" role="dialog" aria-modal="false" aria-label="任务管理">
      <h3 tabindex="-1">任务管理</h3>
      <p class="form-help">任务可关联多个版本。外部 Task ID 为手工维护的 1–16 位数字编号，同项目唯一；与内部任务 ID 分开，不提供链接、登录或同步。</p>
      <label for="git-task-search">搜索任务</label>
      <input id="git-task-search" v-model="taskQuery" type="search" placeholder="名称或 Task ID" :disabled="saving" />
      <ul class="task-manager-list" aria-label="项目任务">
        <li v-for="task in filteredTasks" :key="task.id">
          <div>
            <div class="task-reference">
              <code v-if="task.externalTaskId" class="task-reference-id">{{ task.externalTaskId }}</code>
              <strong class="task-reference-name">{{ task.name }}</strong>
            </div>
            <p>{{ graph.nodes.filter(node => node.taskId === task.id).length }} 个版本</p>
            <p v-if="task.description">{{ task.description }}</p>
          </div>
          <div class="actions">
            <button type="button" class="secondary" :disabled="saving" :aria-label="`编辑任务 ${task.name}`" @click="editTask(task)">编辑</button>
            <button type="button" class="secondary" :disabled="saving" :aria-label="`删除任务 ${task.name}`" @click="openTaskDelete(task)">删除</button>
          </div>
        </li>
      </ul>
      <p v-if="!filteredTasks.length" class="form-help">{{ graph.tasks.length ? '没有匹配的任务。' : '尚无任务，请在下方创建。' }}</p>
      <div v-if="taskDeleteTarget" class="task-delete-confirm">
        <h3 tabindex="-1">删除任务确认</h3>
        <p>删除“{{ taskDeleteTarget.name }}”并解除 {{ graph.nodes.filter(node => node.taskId === taskDeleteTarget!.id).length }} 个版本的任务关联；不删除版本、不修改父边及分支指针。</p>
        <div class="actions">
          <button class="danger" :disabled="saving || graph.project.revision !== taskRevision" @click="confirmTaskDelete">确认删除任务</button>
          <button class="secondary" :disabled="saving" @click="taskDeleteId = null">取消删除</button>
        </div>
      </div>
      <form v-else @submit.prevent="submitTask">
        <h3>{{ taskForm.id ? '编辑任务' : '新建任务' }}</h3>
        <label for="git-task-name">任务名称 <span>必填</span></label>
        <input id="git-task-name" v-model="taskForm.name" required :disabled="saving" />
        <label for="git-task-external-id">外部 Task ID <span>可选，填写 1–16 位数字</span></label>
        <input id="git-task-external-id" v-model="taskForm.externalTaskId" :disabled="saving" inputmode="numeric" placeholder="1" />
        <label for="git-task-description">任务说明</label>
        <textarea id="git-task-description" v-model="taskForm.description" rows="3" :disabled="saving"></textarea>
        <div class="actions">
          <button type="submit" :disabled="saving || !taskForm.name.trim() || graph.project.revision !== taskRevision">保存任务</button>
          <button v-if="taskForm.id" type="button" class="secondary" :disabled="saving" @click="editTask()">新建其他任务</button>
          <button type="button" class="secondary" :disabled="saving" @click="closeEditor">关闭</button>
        </div>
      </form>
      <p v-if="graph.project.revision !== taskRevision" role="alert" class="error">版本图已更新，请重新选择任务编辑或重新打开任务管理，确认最新数据后再保存。</p>
    </div>

    <div v-if="panel === 'node-add' || panel === 'node-edit' || panel === 'merge'" class="graph-form" role="dialog" aria-modal="false" :aria-label="panel === 'merge' ? '合并版本' : panel === 'node-edit' ? '编辑版本' : '新增版本'">
      <h3 tabindex="-1">{{ panel === 'merge' ? '合并版本' : panel === 'node-edit' ? '编辑版本' : nodeForm.parentIds.length ? '新增子版本' : '新增未关联版本' }}</h3>
      <form @submit.prevent="submitNode">
        <label for="git-version">版本号 <span>必填，含日期文本，连续空白归一且区分大小写唯一</span></label>
        <input id="git-version" v-model="nodeForm.version" required :disabled="saving || (panel === 'node-edit' && !!selectedNode?.releasedAt)" placeholder="例如：1479-1 20260115" />
        <label for="git-description">改动说明</label>
        <MarkdownEditor v-model="nodeForm.description" textarea-id="git-description" :disabled="saving" />
        <label for="git-node-task">所属任务</label>
        <select id="git-node-task" v-model="nodeTaskId" :disabled="saving">
          <option value="">未关联任务</option>
          <option v-for="task in graph.tasks" :key="task.id" :value="task.id">{{ taskLabel(task) }}</option>
        </select>
        <p class="form-help">每个版本可不关联任务，或关联一个任务；任务通过工具栏“任务管理”维护。</p>
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
        <p class="form-help">通过下拉框搜索并添加父版本；移除全部父版本会将其设为根版本。</p>
        <div v-for="childId in Object.keys(deletionPlan.childParents)" :key="childId" class="deletion-child">
          <strong>{{ nodeById.get(childId)?.version }} 的新父版本</strong>
          <p v-if="nodeById.get(childId)?.releasedAt" class="deletion-blocked">该子版本已放行，不能重连；请先撤销其放行。</p>
          <div role="group" :aria-label="`为 ${nodeById.get(childId)?.version} 选择新父版本`">
            <ParentVersionPicker
              :options="deletionParentCandidates(childId)" :disabled="saving || !!nodeById.get(childId)?.releasedAt"
              @add="addDeletionParent(childId, $event)"
            />
            <ul v-if="deletionChildParentChoices[childId]?.length" class="selected-parent-list" aria-label="已选父版本">
              <li v-for="id in deletionChildParentChoices[childId]" :key="id">
                {{ nodeById.get(id)?.version ?? id }}
                <button
                  type="button" class="secondary icon-button" :disabled="saving || !!nodeById.get(childId)?.releasedAt"
                  :aria-label="`移除父版本 ${nodeById.get(id)?.version ?? id}`" @click="removeDeletionParent(childId, id)"
                ><AppIcon name="clear" /></button>
              </li>
            </ul>
            <p v-else class="form-help">未选择父版本：该子版本将成为根版本。</p>
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
    <div ref="versionHint" id="version-info-hint" class="version-info-hint" popover="manual" role="tooltip"
      @mouseenter="keepVersionHint" @mouseleave="scheduleHintClose">
      <template v-if="hintedNode">
        <div class="version-info-hint-heading">
          <AppIcon :name="hintedNode.releasedAt ? 'release' : 'unrelease'" />
          <strong>{{ hintedNode.version }}</strong>
          <span>{{ hintedNode.releasedAt ? '已放行' : '未放行' }}</span>
        </div>
        <div v-if="hintedNode.description.trim()" class="markdown-content version-hint-description" v-html="renderMarkdown(hintedNode.description)"></div>
        <p v-else class="markdown-empty">（无改动说明）</p>
      </template>
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
    <dialog
      ref="nodeSwitchDialog" class="branch-move-dialog" aria-labelledby="node-switch-heading"
      @cancel.prevent="cancelNodeSwitch"
    >
      <h3 id="node-switch-heading">切换版本视图</h3>
      <p>{{ editorDraftLabel }}。切换到版本“{{ pendingNodeSwitchTarget?.version }}”的{{ pendingNodeSwitch?.mode === 'details' ? '详情' : '编辑页' }}会放弃当前内容，{{ nodeSwitchCanSave ? '是否先保存？' : '是否放弃当前操作并切换？' }}</p>
      <div class="actions">
        <button
          v-if="nodeSwitchCanSave"
          type="button"
          :disabled="nodeSwitchSaveDisabled"
          @click="saveAndSwitchNode"
        >保存草稿并{{ pendingNodeSwitch?.mode === 'details' ? '查看详情' : '编辑' }}</button>
        <button type="button" class="secondary" :disabled="saving" @click="discardAndSwitchNode">{{ nodeSwitchCanSave ? '放弃草稿并' : '放弃当前操作并' }}{{ pendingNodeSwitch?.mode === 'details' ? '查看详情' : '编辑' }}</button>
        <button type="button" class="secondary" :disabled="saving" autofocus @click="cancelNodeSwitch">取消</button>
      </div>
    </dialog>
  </section>
</template>
