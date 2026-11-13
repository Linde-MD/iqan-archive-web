<script setup lang="ts">
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/vue';
import { isSortableOperation } from '@dnd-kit/vue/sortable';
import { liveQuery } from 'dexie';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, toRaw, watch } from 'vue';
import { useRouter } from 'vue-router';
import { matchesTaskIdSearch, moveTaskInBoard, parseTaskIdSearch, projectTaskList, suggestNextTaskId, tasksInLane, validateNewTaskId, type TaskSearchMode } from '../domain/task-board';
import { mergeSavedTaskDraft } from '../domain/task-draft';
import { createPriorityOption, DomainError, legacyTaskTypeNames, type Project, type ProjectGraph, type Task, type TaskComment, type TaskOption } from '../domain/model';
import type { ArchiveRepository } from '../storage/database';
import { renderMarkdown } from '../utils/markdown';
import AppIcon from './AppIcon.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import TaskBoardLane from './TaskBoardLane.vue';
import TaskList from './TaskList.vue';

type OptionKey = 'statusOptions' | 'typeOptions' | 'priorityOptions' | 'assigneeOptions';
type OptionKind = 'status' | 'type' | 'priority' | 'assignee';

const props = defineProps<{
  repository: ArchiveRepository;
  projectId: string;
  projectName: string;
  focusTaskId: string | null;
  detailTaskId: string;
  optionsOpen: boolean;
}>();
const emit = defineEmits<{
  busy: [value: boolean];
  graph: [nodeId: string];
  navigateChild: [child: string[], action?: 'push' | 'replace' | 'back'];
}>();

const graph = shallowRef<ProjectGraph>();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const statusMessage = ref('');
const query = ref('');
const searchMode = ref<TaskSearchMode>('keyword');
const taskView = ref<'board' | 'list'>('board');
const nestedTasks = ref(true);
const expandedTaskIds = ref(new Set<string>());
const collapsedSearchTaskIds = ref(new Set<string>());
const selectedTaskId = ref('');
const taskDraft = ref<Task | null>(null);
const taskDraftRevision = ref(-1);
const taskDraftBaseline = ref('');
const taskIdError = ref('');
const taskIdOverflow = ref(false);
const commentEditorOpen = ref(false);
const editingCommentId = ref<string | null>(null);
const commentText = ref('');
const commentTextBaseline = ref('');
const detailSidebar = ref<'comments' | 'versions'>('comments');
const detailSection = ref<'information' | 'children'>('information');
const taskDetailDialog = ref<HTMLDialogElement>();
const taskDetailMainScroll = ref<HTMLDivElement>();
const taskDetailView = ref<HTMLElement>();
const optionsDialog = ref<HTMLDialogElement>();
const optionKind = ref<OptionKind>('status');
const optionName = ref('');
const optionNameDrafts = ref<Record<OptionKind, string>>({ status: '', type: '', priority: '', assignee: '' });
const optionDraft = ref<TaskOption[]>([]);
const optionDraftRevision = ref(-1);
const dragSaving = ref(false);
const quickTask = ref<{ statusId: string | null; name: string; revision: number } | null>(null);
const quickError = ref('');
const quickConflict = ref(false);
const quickStale = computed(() => !!quickTask.value && (quickConflict.value || graph.value?.project.revision !== quickTask.value.revision));
let removeQuickRouteGuard: (() => void) | undefined;
let subscription: { unsubscribe(): void } | undefined;
let lastDragOverTarget: DragEndEvent['operation']['target'] | null = null;
let descriptionSaveTimer: ReturnType<typeof setTimeout> | undefined;
let autoSaveQueued = false;

const taskDraftDirty = computed(() => !!taskDraft.value && JSON.stringify(taskDraft.value) !== taskDraftBaseline.value);
const commentDraftDirty = computed(() => commentEditorOpen.value && commentText.value !== commentTextBaseline.value);
const hasUnsavedTaskChanges = computed(() => taskDraftDirty.value || commentDraftDirty.value);
const taskDraftStale = computed(() => !graph.value || taskDraftRevision.value !== graph.value.project.revision);
const taskFieldsDisabled = computed(() => (taskDraftStale.value && !saving.value) || (saving.value && !taskDraft.value?.id));
const optionDraftStale = computed(() => !graph.value || optionDraftRevision.value !== graph.value.project.revision);
const optionKey = computed<OptionKey>(() => `${optionKind.value}Options` as OptionKey);
const currentOptionLabel = computed(() => ({
  status: 'Status', type: 'Type', priority: '优先级', assignee: '负责人',
}[optionKind.value]));
const startDateInput = computed({
  get: () => taskDraft.value?.startDate ?? '',
  set: (value: string) => { if (taskDraft.value) taskDraft.value.startDate = value || null; },
});
const dueDateInput = computed({
  get: () => taskDraft.value?.dueDate ?? '',
  set: (value: string) => { if (taskDraft.value) taskDraft.value.dueDate = value || null; },
});

const typeNameById = computed(() => new Map((graph.value?.project.typeOptions ?? []).map(option => [option.id, option.name])));
const legacyTypeNames = computed(() => legacyTaskTypeNames(graph.value?.project.typeOptions ?? []));
const priorityOptionById = computed(() => new Map((graph.value?.project.priorityOptions ?? []).map(option => [option.id, option])));
const assigneeNameById = computed(() => new Map((graph.value?.project.assigneeOptions ?? []).map(option => [option.id, option.name])));
const taskIdSearch = computed(() => parseTaskIdSearch(query.value));
const taskIdSearchError = computed(() => searchMode.value === 'id' && taskIdSearch.value.kind === 'invalid'
  ? taskIdSearch.value.message : '');
const taskMatches = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return (graph.value?.tasks ?? []).filter(task => {
    if (!search) return true;
    if (searchMode.value === 'id') return matchesTaskIdSearch(task.externalTaskId, taskIdSearch.value);
    if (searchMode.value === 'assignee') {
      const assignee = task.assigneeId ? assigneeNameById.value.get(task.assigneeId) ?? '' : '';
      return assignee.toLocaleLowerCase().includes(search);
    }
    return `${task.name} ${task.description}`.toLocaleLowerCase().includes(search);
  });
});
const listRows = computed(() => projectTaskList(
  graph.value?.tasks ?? [], new Set(taskMatches.value.map(task => task.id)), nestedTasks.value,
  expandedTaskIds.value, !!query.value.trim(), collapsedSearchTaskIds.value,
));
const lanes = computed(() => {
  const current = graph.value;
  if (!current) return [];
  const visibleTaskIds = new Set(taskMatches.value.map(task => task.id));
  const result = [
    ...current.project.statusOptions.map(status => ({
      status,
      tasks: tasksInLane(current, status.id).filter(task => visibleTaskIds.has(task.id)),
    })),
    { status: null, tasks: tasksInLane(current, null).filter(task => visibleTaskIds.has(task.id)) },
  ];
  if (quickTask.value?.statusId && !current.project.statusOptions.some(option => option.id === quickTask.value?.statusId)) {
    result.push({ status: { id: quickTask.value.statusId, name: '已删除的泳道' }, tasks: [] });
  }
  return result;
});
const taskIndexById = computed(() => new Map(lanes.value.flatMap(lane => lane.tasks)
  .map((task, index) => [task.id, index] as const)));
const parentTaskCandidates = computed(() => {
  const tasks = graph.value?.tasks ?? [];
  const draftId = taskDraft.value?.id;
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const siblings = children.get(task.parentTaskId) ?? [];
    siblings.push(task.id);
    children.set(task.parentTaskId, siblings);
  }
  const excluded = new Set<string>();
  const pending = draftId ? [draftId] : [];
  while (pending.length) {
    const id = pending.pop()!;
    if (excluded.has(id)) continue;
    excluded.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return tasks.filter(task => !excluded.has(task.id));
});
const childTasks = computed(() => (graph.value?.tasks ?? [])
  .filter(task => taskDraft.value?.id && task.parentTaskId === taskDraft.value.id));
const optionDraftChanged = computed(() => {
  const current = graph.value?.project[optionKey.value] ?? [];
  return JSON.stringify(optionDraft.value) !== JSON.stringify(current);
});

watch(searchMode, () => { query.value = ''; });
watch([query, searchMode], () => { collapsedSearchTaskIds.value = new Set(); });

function toggleListTask(id: string) {
  const row = listRows.value.find(item => item.task.id === id);
  if (!row) return;
  if (query.value.trim()) {
    const collapsed = new Set(collapsedSearchTaskIds.value);
    if (row.expanded) collapsed.add(id);
    else collapsed.delete(id);
    collapsedSearchTaskIds.value = collapsed;
  } else {
    const expanded = new Set(expandedTaskIds.value);
    if (row.expanded) expanded.delete(id);
    else expanded.add(id);
    expandedTaskIds.value = expanded;
  }
}

function setTaskDraft(task: Task) {
  clearTimeout(descriptionSaveTimer);
  autoSaveQueued = false;
  taskDraft.value = structuredClone(task);
  taskIdError.value = '';
  taskIdOverflow.value = false;
  taskDraftRevision.value = graph.value?.project.revision ?? -1;
  taskDraftBaseline.value = JSON.stringify(taskDraft.value);
  selectedTaskId.value = task.id;
  commentEditorOpen.value = false;
  editingCommentId.value = null;
  commentText.value = '';
  commentTextBaseline.value = '';
  detailSidebar.value = 'comments';
  detailSection.value = 'information';
}

function switchTask(taskId: string) {
  if (saving.value) return;
  if (hasUnsavedTaskChanges.value && selectedTaskId.value !== taskId
    && !window.confirm('当前任务修改尚未保存。放弃修改并切换任务吗？')) return;
  const task = graph.value?.tasks.find(candidate => candidate.id === taskId);
  if (task) {
    setTaskDraft(task);
    emit('navigateChild', ['detail', taskId]);
    void nextTick(() => document.getElementById('task-detail-page-title')?.focus({ preventScroll: true }));
  }
}

function createTask(statusOptionId?: string | null, updateRoute = true) {
  if (saving.value) return;
  if (hasUnsavedTaskChanges.value && !window.confirm('当前任务修改尚未保存。放弃修改并新建任务吗？')) return;
  const current = graph.value;
  if (!current) return;
  clearTimeout(descriptionSaveTimer);
  autoSaveQueued = false;
  const defaultStatus = current.project.statusOptions[0]?.id ?? null;
  const targetStatus = statusOptionId === undefined ? defaultStatus : statusOptionId;
  const suggestedId = suggestNextTaskId(current.tasks);
  const task: Task = {
    id: '', projectId: current.project.id, parentTaskId: null, name: '', description: '', externalTaskId: suggestedId,
    statusOptionId: targetStatus, typeOptionId: null, priorityOptionId: null, assigneeId: null,
    startDate: null, dueDate: null, sortOrder: tasksInLane(current, targetStatus).length, comments: [],
  };
  taskDraft.value = task;
  taskIdError.value = '';
  taskIdOverflow.value = suggestedId === null;
  error.value = '';
  statusMessage.value = '';
  taskDraftRevision.value = current.project.revision;
  taskDraftBaseline.value = JSON.stringify(task);
  selectedTaskId.value = '';
  commentEditorOpen.value = false;
  editingCommentId.value = null;
  commentText.value = '';
  commentTextBaseline.value = '';
  detailSidebar.value = 'comments';
  detailSection.value = 'information';
  if (updateRoute) emit('navigateChild', ['new']);
  void nextTick(() => document.getElementById('task-board-name')?.focus());
}

function startQuickTask(statusId: string | null) {
  if (!graph.value || saving.value || quickTask.value || hasUnsavedTaskChanges.value) return;
  quickTask.value = {
    statusId, name: '', revision: graph.value.project.revision,
  };
  quickError.value = '';
  quickConflict.value = false;
  error.value = '';
  statusMessage.value = '';
}

function cancelQuickTask() {
  if (saving.value) return;
  quickTask.value = null;
  quickError.value = '';
  quickConflict.value = false;
}

async function refreshQuickTask() {
  if (!quickTask.value || saving.value) return;
  saving.value = true;
  try {
    const refreshed = await props.repository.get(props.projectId);
    graph.value = refreshed;
    if (quickTask.value.statusId !== null && !refreshed.project.statusOptions.some(option => option.id === quickTask.value?.statusId)) {
      quickError.value = '该泳道已被删除，请复制任务名称后取消并选择其他泳道。';
      return;
    }
    quickTask.value.revision = refreshed.project.revision;
    quickConflict.value = false;
    quickError.value = '';
    statusMessage.value = '已重新读取项目，请再次确认创建任务。';
  } catch (cause) {
    quickError.value = cause instanceof Error ? cause.message : '重新读取项目失败，请重试。';
  } finally {
    saving.value = false;
  }
}

async function submitQuickTask() {
  const draft = quickTask.value;
  const current = graph.value;
  if (!draft || !current || saving.value) return;
  if (current.project.revision !== draft.revision) {
    quickError.value = '项目已在其他标签页更新，请先重新读取项目。';
    return;
  }
  try {
    if (!draft.name.trim()) throw new Error('请填写任务名称。');
    const externalTaskId = suggestNextTaskId(current.tasks);
    if (externalTaskId === null) throw new Error('Task ID 已达到自动编号上限。请复制任务名称，取消后通过“新建任务”手工填写未使用的编号。');
    const laneTasks = tasksInLane(current, draft.statusId);
    const sortOrder = (laneTasks[laneTasks.length - 1]?.sortOrder ?? -1) + 1;
    const task: Task = {
      id: crypto.randomUUID(), projectId: current.project.id, parentTaskId: null,
      name: draft.name.trim(), description: '', externalTaskId,
      statusOptionId: draft.statusId, typeOptionId: null, priorityOptionId: null, assigneeId: null,
      startDate: null, dueDate: null, sortOrder, comments: [],
    };
    saving.value = true;
    quickError.value = '';
    const persisted = await props.repository.saveTask(props.projectId, draft.revision, task);
    graph.value = persisted;
    quickTask.value = null;
    statusMessage.value = `任务“${task.name}”已创建。${taskMatches.value.some(candidate => candidate.id === task.id) ? '' : '当前筛选隐藏了新任务，请清除筛选查看。'}`;
  } catch (cause) {
    if (cause instanceof DomainError && cause.code === 'STALE_REVISION') quickConflict.value = true;
    quickError.value = cause instanceof Error ? cause.message : '创建任务失败，请重试。';
  } finally {
    saving.value = false;
  }
}

function reportError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '本地任务操作失败，请重试。';
  statusMessage.value = '';
}

async function saveTask(candidate: Task, successMessage: string) {
  if (saving.value) return false;
  const current = graph.value;
  if (!current || taskDraftRevision.value !== current.project.revision) {
    error.value = '项目已在其他标签页更新。请重新读取任务后再保存。';
    statusMessage.value = '';
    return false;
  }
  if (!candidate.id) {
    try {
      validateNewTaskId(current.tasks, candidate.externalTaskId);
      taskIdError.value = '';
    } catch (cause) {
      taskIdError.value = cause instanceof Error ? cause.message : 'Task ID 验证失败，请重试。';
      await nextTick();
      document.getElementById('task-board-external-id')?.focus();
      return false;
    }
  }
  saving.value = true;
  error.value = '';
  let succeeded = false;
  try {
    const submitted = structuredClone(toRaw(candidate));
    const taskId = candidate.id || crypto.randomUUID();
    const persistedTask = current.tasks.find(task => task.id === taskId);
    const persisted = await props.repository.saveTask(props.projectId, taskDraftRevision.value, {
      ...submitted,
      id: taskId,
      projectId: current.project.id,
      name: candidate.name.trim(),
      externalTaskId: candidate.externalTaskId?.trim() || null,
      sortOrder: persistedTask?.statusOptionId === candidate.statusOptionId
        ? persistedTask.sortOrder
        : tasksInLane(current, candidate.statusOptionId).length,
    });
    const saved = persisted.tasks.find(task => task.id === taskId);
    if (!saved) throw new Error('保存后未找到任务，请重新读取项目。');
    if (!graph.value || graph.value.project.revision <= persisted.project.revision) graph.value = persisted;
    if (!submitted.id) {
      setTaskDraft(saved);
    } else if (taskDraft.value?.id === taskId) {
      mergeSavedTaskDraft(taskDraft.value, submitted, saved);
      taskDraftRevision.value = persisted.project.revision;
      taskDraftBaseline.value = JSON.stringify(saved);
    }
    error.value = '';
    statusMessage.value = successMessage;
    succeeded = true;
    return true;
  } catch (cause) {
    reportError(cause);
    return false;
  } finally {
    saving.value = false;
    if (succeeded && autoSaveQueued) {
      autoSaveQueued = false;
      void nextTick(() => requestAutoSave());
    }
  }
}

async function requestAutoSave() {
  if (!taskDraft.value?.id) return;
  if (saving.value) {
    autoSaveQueued = true;
    return;
  }
  if (!taskDraftDirty.value) return;
  autoSaveQueued = false;
  await saveTask(taskDraft.value, '任务已自动保存。');
}

function scheduleDescriptionSave() {
  clearTimeout(descriptionSaveTimer);
  descriptionSaveTimer = setTimeout(() => { void requestAutoSave(); }, 800);
}

async function submitTask() {
  if (!taskDraft.value) return;
  if (commentDraftDirty.value) {
    error.value = '请先保存或取消未完成的评论，再保存任务。';
    return;
  }
  const isNew = !taskDraft.value.id;
  if (await saveTask(taskDraft.value, '任务已保存。') && isNew && taskDraft.value?.id) {
    emit('navigateChild', ['detail', taskDraft.value.id], 'replace');
    await nextTick();
    taskDetailMainScroll.value?.scrollTo({ top: 0 });
    taskDetailView.value?.scrollTo({ top: 0 });
    document.getElementById('task-detail-page-title')?.focus({ preventScroll: true });
  }
}

async function deleteCurrentTask() {
  const current = graph.value;
  const task = taskDraft.value;
  if (!current || !task?.id || !window.confirm(`删除“${task.name}”及其评论，并解除所有版本关联吗？${childTasks.value.length} 个直接子任务将解除父任务关联，不会被删除。版本图关系不会改变。`)) return;
  saving.value = true;
  try {
    graph.value = await props.repository.deleteTask(props.projectId, current.project.revision, task.id);
    taskDraft.value = null;
    taskDraftRevision.value = -1;
    taskDraftBaseline.value = '';
    selectedTaskId.value = '';
    emit('navigateChild', [], 'replace');
    statusMessage.value = '任务已删除；关联版本已解除任务关联。';
    error.value = '';
  } catch (cause) {
    reportError(cause);
  } finally {
    saving.value = false;
  }
}

async function persistMove(taskId: string, statusOptionId: string | null, beforeTaskId: string | null) {
  const current = graph.value;
  if (!current || saving.value || hasUnsavedTaskChanges.value) return;
  saving.value = true;
  try {
    graph.value = await props.repository.moveTask(
      props.projectId, current.project.revision, taskId, statusOptionId, beforeTaskId,
    );
    const savedDraft = taskDraft.value?.id
      ? graph.value.tasks.find(task => task.id === taskDraft.value?.id)
      : undefined;
    if (savedDraft) setTaskDraft(savedDraft);
    error.value = '';
    statusMessage.value = '任务状态和顺序已保存。';
  } catch (cause) {
    reportError(cause);
  } finally {
    saving.value = false;
  }
}

function onDragStart(_event: DragStartEvent) {
  lastDragOverTarget = null;
}

function onDragOver(event: DragOverEvent) {
  const sourceId = event.operation.source ? String(event.operation.source.id) : '';
  const target = event.operation.target;
  if (target && String(target.id) !== sourceId) lastDragOverTarget = target;
}

function statusAtDropPoint(event?: Event): string | null | undefined {
  if (!(event instanceof MouseEvent)) return undefined;
  const lane = [...document.querySelectorAll<HTMLElement>('.task-lane')].find(element => {
    const bounds = element.getBoundingClientRect();
    return event.clientX >= bounds.left && event.clientX <= bounds.right
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  });
  return lane ? lane.dataset.statusOptionId || null : undefined;
}

async function onDragEnd(event: DragEndEvent) {
  const source = event.operation.source;
  let target = event.operation.target;
  if (event.canceled || !source) {
    lastDragOverTarget = null;
    return;
  }
  const sourceTaskId = String(source.id);
  if (target && String(target.id) === sourceTaskId && lastDragOverTarget) target = lastDragOverTarget;
  lastDragOverTarget = null;
  if (!target) return;
  const sourceTask = graph.value?.tasks.find(task => task.id === sourceTaskId);
  if (!sourceTask) return;
  const pointerStatusOptionId = statusAtDropPoint(event.nativeEvent);
  let targetStatusOptionId: string | null;
  let beforeTaskId: string | null = null;
  if (isSortableOperation(event.operation)) {
    const targetTaskId = String(target.id);
    const targetTask = graph.value?.tasks.find(task => task.id === targetTaskId);
    if (!targetTask) return;
    const targetData = target.data as { statusOptionId?: unknown } | undefined;
    if (pointerStatusOptionId !== undefined) targetStatusOptionId = pointerStatusOptionId;
    else if (targetData && 'statusOptionId' in targetData)
      targetStatusOptionId = typeof targetData.statusOptionId === 'string' ? targetData.statusOptionId : null;
    else targetStatusOptionId = targetTask.statusOptionId;
    if (targetStatusOptionId !== sourceTask.statusOptionId) {
      beforeTaskId = targetTaskId === sourceTaskId ? null : targetTaskId;
    } else {
      const targetLaneIndex = lanes.value.findIndex(lane => lane.status?.id === targetStatusOptionId);
      const sourceLaneIndex = lanes.value.findIndex(lane => lane.status?.id === sourceTask.statusOptionId);
      let targetLaneStart = lanes.value.slice(0, targetLaneIndex)
        .reduce((count, lane) => count + lane.tasks.length, 0);
      if (sourceLaneIndex >= 0 && sourceLaneIndex < targetLaneIndex) targetLaneStart--;
      const destination = tasksInLane(graph.value!, targetStatusOptionId).filter(task => task.id !== sourceTaskId);
      const sourceIndex = (source as typeof source & { index?: number }).index;
      const insertionIndex = sourceIndex === undefined
        ? destination.findIndex(task => task.id === targetTaskId)
        : Math.max(0, Math.min(destination.length, sourceIndex - targetLaneStart));
      beforeTaskId = destination[insertionIndex]?.id ?? null;
    }
  } else {
    const data = target.data as { statusOptionId?: unknown } | undefined;
    if (pointerStatusOptionId !== undefined) targetStatusOptionId = pointerStatusOptionId;
    else if (data && 'statusOptionId' in data)
      targetStatusOptionId = typeof data.statusOptionId === 'string' ? data.statusOptionId : null;
    else return;
  }
  if (beforeTaskId === sourceTaskId) return;
  await persistMove(sourceTaskId, targetStatusOptionId, beforeTaskId);
}

function openOptions(updateRoute = true) {
  const current = graph.value;
  if (!current) return;
  optionKind.value = 'status';
  optionDraft.value = structuredClone(current.project.statusOptions);
  optionDraftRevision.value = current.project.revision;
  optionNameDrafts.value = { status: '', type: '', priority: '', assignee: '' };
  optionName.value = '';
  if (!optionsDialog.value?.open) optionsDialog.value?.showModal();
  if (updateRoute) emit('navigateChild', ['options']);
}

function selectOptionKind(kind: OptionKind) {
  if (optionDraftChanged.value
    && !window.confirm('当前选项修改尚未保存。放弃修改并切换类别吗？')) return;
  const current = graph.value;
  if (!current) return;
  optionNameDrafts.value[optionKind.value] = optionName.value;
  optionKind.value = kind;
  optionDraft.value = structuredClone(current.project[`${kind}Options` as OptionKey]);
  optionDraftRevision.value = current.project.revision;
  optionName.value = optionNameDrafts.value[kind];
}

function closeOptions() {
  const pendingName = optionName.value.trim() || Object.values(optionNameDrafts.value).some(name => name.trim());
  if ((optionDraftChanged.value || pendingName)
    && !window.confirm('放弃尚未保存的选项修改吗？')) return;
  optionsDialog.value?.close();
  emit('navigateChild', [], 'back');
}

function addOption() {
  const name = optionName.value.trim();
  if (!name) return;
  if (optionDraft.value.some(option => option.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    error.value = `${currentOptionLabel.value}名称不能重复。`;
    return;
  }
  optionDraft.value.push(optionKind.value === 'priority'
    ? createPriorityOption(name, optionDraft.value.length)
    : { id: crypto.randomUUID(), name });
  optionName.value = '';
  optionNameDrafts.value[optionKind.value] = '';
  error.value = '';
}

function taskReferenceCount(optionId: string): number {
  const field = ({
    status: 'statusOptionId', type: 'typeOptionId', priority: 'priorityOptionId', assignee: 'assigneeId',
  } as const)[optionKind.value];
  return graph.value?.tasks.filter(task => task[field] === optionId).length ?? 0;
}

function removeOption(optionId: string) {
  const option = optionDraft.value.find(candidate => candidate.id === optionId);
  if (!option) return;
  const count = taskReferenceCount(optionId);
  if (count && !window.confirm(`“${option.name}”正被 ${count} 个任务使用。删除后会清空这些任务的 ${currentOptionLabel.value}，继续吗？`)) return;
  optionDraft.value = optionDraft.value.filter(candidate => candidate.id !== optionId);
}

async function saveOptions() {
  const current = graph.value;
  if (!current || optionDraftRevision.value !== current.project.revision) {
    error.value = '项目已在其他标签页更新。请重新打开选项管理后再保存。';
    return;
  }
  saving.value = true;
  try {
    const options: Pick<Project, 'statusOptions' | 'typeOptions' | 'priorityOptions' | 'assigneeOptions'> = {
      statusOptions: structuredClone(current.project.statusOptions),
      typeOptions: structuredClone(current.project.typeOptions),
      priorityOptions: structuredClone(current.project.priorityOptions),
      assigneeOptions: structuredClone(current.project.assigneeOptions),
    };
    options[`${optionKind.value}Options` as OptionKey] = optionDraft.value.map(option => ({
      ...option, name: option.name.trim(),
    }));
    graph.value = await props.repository.saveTaskOptions(props.projectId, current.project.revision, options);
    const savedDraft = taskDraft.value?.id
      ? graph.value.tasks.find(task => task.id === taskDraft.value?.id)
      : undefined;
    if (savedDraft) setTaskDraft(savedDraft);
    optionDraftRevision.value = graph.value.project.revision;
    optionDraft.value = structuredClone(graph.value.project[`${optionKind.value}Options` as OptionKey]);
    statusMessage.value = `${currentOptionLabel.value}选项已保存。`;
    error.value = '';
  } catch (cause) {
    reportError(cause);
  } finally {
    saving.value = false;
  }
}

function beginNewComment() {
  if (!taskDraft.value) return;
  editingCommentId.value = null;
  commentText.value = '';
  commentTextBaseline.value = '';
  commentEditorOpen.value = true;
}

function closeTaskDetails() {
  if (saving.value) return;
  if (hasUnsavedTaskChanges.value && !window.confirm('放弃未保存的任务修改吗？')) return;
  clearTimeout(descriptionSaveTimer);
  autoSaveQueued = false;
  const taskId = selectedTaskId.value;
  taskDraft.value = null;
  taskDraftRevision.value = -1;
  taskDraftBaseline.value = '';
  emit('navigateChild', [], 'back');
  void nextTick(() => {
    if (taskView.value === 'list') {
      const row = [...document.querySelectorAll<HTMLElement>('[data-task-list-id]')]
        .find(element => element.dataset.taskListId === taskId);
      const title = row?.querySelector<HTMLButtonElement>('.task-list-title');
      if (title) {
        title.focus({ preventScroll: true });
        return;
      }
      document.getElementById('task-list-view')?.focus({ preventScroll: true });
      return;
    }
    const card = [...document.querySelectorAll<HTMLElement>('[data-task-card-id]')]
      .find(element => element.dataset.taskCardId === taskId);
    card?.querySelector<HTMLButtonElement>('.task-card-title')?.focus({ preventScroll: true });
  });
}

function openRelatedVersion(nodeId: string) {
  if (saving.value) return;
  if (hasUnsavedTaskChanges.value && !window.confirm('当前任务或评论修改尚未保存。放弃修改并打开版本图吗？')) return;
  emit('graph', nodeId);
}

watch([graph, () => props.detailTaskId], async ([current, detailId], [, previousDetailId]) => {
  if (!current) return;
  if (saving.value && taskDraft.value && detailId !== (taskDraft.value.id || 'new')) {
    emit('navigateChild', taskDraft.value.id ? ['detail', taskDraft.value.id] : ['new'], 'replace');
    return;
  }
  if (detailId === 'new') {
    if (!taskDraft.value || (previousDetailId !== 'new' && taskDraft.value.id)) createTask(undefined, false);
    return;
  }
  if (detailId) {
    const task = current.tasks.find(candidate => candidate.id === detailId);
    if (!task) {
      if (taskDraft.value?.id === detailId) {
        error.value = '任务已在其他标签页删除，当前草稿仍保留，请复制所需内容后关闭。';
        return;
      }
      emit('navigateChild', [], 'replace');
      reportError(new Error('此任务不存在或已删除。'));
      return;
    }
    if (taskDraft.value?.id !== task.id) {
      if (hasUnsavedTaskChanges.value
        && !window.confirm('当前任务修改尚未保存。放弃修改并打开此任务吗？')) {
        emit('navigateChild', taskDraft.value?.id ? ['detail', taskDraft.value.id] : ['new'], 'replace');
        return;
      }
      setTaskDraft(task);
    }
    return;
  }
  if (taskDraft.value) {
    if (hasUnsavedTaskChanges.value && !window.confirm('当前任务修改尚未保存。放弃修改并返回任务看板吗？')) {
      emit('navigateChild', taskDraft.value.id ? ['detail', taskDraft.value.id] : ['new'], 'replace');
      return;
    }
    taskDraft.value = null;
    taskDraftRevision.value = -1;
    taskDraftBaseline.value = '';
  }
});

watch(taskDraft, async draft => {
  await nextTick();
  const dialog = taskDetailDialog.value;
  if (!dialog) return;
  if (draft) {
    if (!dialog.open) dialog.showModal();
    document.getElementById('task-detail-page-title')?.focus({ preventScroll: true });
  } else if (dialog.open) {
    dialog.close();
  }
}, { flush: 'post' });

watch([() => props.optionsOpen, graph], async ([open, current]) => {
  if (open) {
    if (!current) return;
    if (!optionsDialog.value?.open) {
      await nextTick();
      if (!optionsDialog.value?.open) openOptions(false);
    }
    return;
  }
  if (!optionsDialog.value?.open) return;
  const pendingName = optionName.value.trim() || Object.values(optionNameDrafts.value).some(name => name.trim());
  if ((optionDraftChanged.value || pendingName)
    && !window.confirm('放弃尚未保存的选项修改吗？')) {
    emit('navigateChild', ['options'], 'replace');
    return;
  }
  optionsDialog.value.close();
}, { immediate: true });

function beginEditComment(comment: TaskComment) {
  editingCommentId.value = comment.id;
  commentText.value = comment.text;
  commentTextBaseline.value = comment.text;
  commentEditorOpen.value = true;
}

async function saveComment() {
  if (!taskDraft.value || !commentText.value.trim()) return;
  const current = structuredClone(toRaw(taskDraft.value));
  const now = new Date().toISOString();
  const comments = [...current.comments];
  if (editingCommentId.value) {
    const index = comments.findIndex(comment => comment.id === editingCommentId.value);
    if (index < 0) return;
    comments[index] = { ...comments[index]!, text: commentText.value.trim(), updatedAt: now };
  } else {
    comments.push({ id: crypto.randomUUID(), text: commentText.value.trim(), createdAt: now, updatedAt: now });
  }
  if (await saveTask({ ...current, comments }, '评论已保存。')) {
    commentEditorOpen.value = false;
    editingCommentId.value = null;
    commentText.value = '';
    commentTextBaseline.value = '';
  }
}

function cancelComment() {
  if (commentDraftDirty.value && !window.confirm('放弃未保存的评论修改吗？')) return;
  commentEditorOpen.value = false;
  editingCommentId.value = null;
  commentText.value = '';
  commentTextBaseline.value = '';
}

async function deleteComment(comment: TaskComment) {
  if (!taskDraft.value || !window.confirm('删除这条评论吗？')) return;
  const current = structuredClone(toRaw(taskDraft.value));
  await saveTask({ ...current, comments: current.comments.filter(item => item.id !== comment.id) }, '评论已删除。');
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

async function focusRequestedTask() {
  const targetId = props.focusTaskId;
  if (!targetId || !graph.value?.tasks.some(task => task.id === targetId)) return;
  if (hasUnsavedTaskChanges.value && !window.confirm('当前任务修改尚未保存。放弃修改并返回任务看板吗？')) return;
  taskDraft.value = null;
  taskDraftRevision.value = -1;
  taskDraftBaseline.value = '';
  selectedTaskId.value = targetId;
  taskView.value = 'board';
  if (!taskMatches.value.some(task => task.id === targetId)) query.value = '';
  await nextTick();
  const card = [...document.querySelectorAll<HTMLElement>('[data-task-card-id]')]
    .find(element => element.dataset.taskCardId === targetId);
  card?.scrollIntoView({ block: 'center', inline: 'nearest' });
  card?.querySelector<HTMLButtonElement>('.task-card-title')?.focus({ preventScroll: true });
}

watch([graph, () => props.focusTaskId], () => { void focusRequestedTask(); }, { flush: 'post' });
watch([saving, quickTask], ([isSaving, draft]) => emit('busy', isSaving || !!draft), { immediate: true });

onMounted(() => {
  removeQuickRouteGuard = router.beforeEach(() => {
    if (saving.value) return false;
    if (!quickTask.value) return true;
    if (quickTask.value.name.trim() && !window.confirm('泳道中的新任务尚未保存，放弃后离开吗？')) return false;
    cancelQuickTask();
    return true;
  });
  subscription = liveQuery(() => props.repository.get(props.projectId)).subscribe({
    next: value => {
      graph.value = value;
      loading.value = false;
      if (selectedTaskId.value && !value.tasks.some(task => task.id === selectedTaskId.value)) {
        if (taskDraft.value?.id !== selectedTaskId.value) selectedTaskId.value = '';
      }
    },
    error: cause => {
      loading.value = false;
      reportError(cause);
    },
  });
});

onUnmounted(() => {
  clearTimeout(descriptionSaveTimer);
  subscription?.unsubscribe();
  removeQuickRouteGuard?.();
  emit('busy', false);
});
</script>

<template>
  <section class="panel task-board" aria-labelledby="task-board-title" :aria-busy="loading || saving">
    <header class="task-board-header">
      <div>
        <p class="eyebrow">PROJECT TASKS</p>
        <h2 id="task-board-title">{{ projectName }} · 任务管理</h2>
      </div>
      <div class="task-board-header-actions">
        <button type="button" class="secondary" :disabled="loading || saving || hasUnsavedTaskChanges || !!quickTask" @click="openOptions()"><AppIcon name="edit" />管理选项</button>
        <button type="button" :disabled="loading || saving || !!quickTask" @click="createTask()"><AppIcon name="plus" />新建任务</button>
      </div>
    </header>
    <div class="task-view-controls">
      <div class="task-view-switch" role="group" aria-label="任务视图">
        <button type="button" :aria-pressed="taskView === 'board'" @click="taskView = 'board'">看板</button>
        <button id="task-list-view" type="button" :disabled="!!quickTask" :aria-pressed="taskView === 'list'" @click="taskView = 'list'">工作项列表</button>
      </div>
      <label v-if="taskView === 'list'" class="task-nesting-toggle"><input v-model="nestedTasks" type="checkbox" />显示父子嵌套</label>
    </div>
    <div class="task-board-toolbar">
      <label class="task-board-search-label" for="task-board-search-mode">筛选条件</label>
      <select id="task-board-search-mode" v-model="searchMode" class="task-board-search-mode" :disabled="loading || !!quickTask" aria-label="任务搜索条件">
        <option value="id">ID</option>
        <option value="keyword">关键字</option>
        <option value="assignee">负责人</option>
      </select>
      <input id="task-board-search" v-model="query" type="search" :aria-label="searchMode === 'id' ? 'Task ID 精确值或范围' : searchMode === 'assignee' ? '负责人名称' : '任务关键字'"
        :placeholder="searchMode === 'id' ? '精确 ID 或范围，例如 100-199' : searchMode === 'assignee' ? '负责人名称' : '任务名或说明关键词'" :disabled="loading || !!quickTask" />
      <span class="task-board-count">{{ taskMatches.length }} / {{ graph?.tasks.length ?? 0 }} 项</span>
    </div>
    <p v-if="taskIdSearchError" class="task-board-message is-error" role="alert">{{ taskIdSearchError }}</p>
    <p v-if="loading" class="task-board-state" role="status">正在读取任务…</p>
    <p v-else-if="!graph?.tasks.length" class="task-board-state">还没有任务。新建任务后可按 Status 管理。</p>
    <p v-else-if="!taskMatches.length" class="task-board-state">没有匹配的任务。</p>
    <div v-if="error && !taskDraft" class="task-board-message is-error" role="alert">{{ error }}</div>
    <div v-else-if="statusMessage && !taskDraft" class="task-board-message" role="status">{{ statusMessage }}</div>

    <TaskList v-if="graph && taskView === 'list' && taskMatches.length" :graph="graph" :rows="listRows" :nested="nestedTasks" :selected-task-id="selectedTaskId" :disabled="saving" @open="switchTask" @toggle="toggleListTask" />
    <div v-if="graph && taskView === 'board'" class="task-board-layout">
      <div class="task-board-scroll">
        <DragDropProvider @drag-start="onDragStart" @drag-over="onDragOver" @drag-end="onDragEnd">
          <div class="task-board-lanes">
            <TaskBoardLane
              v-for="lane in lanes" :key="lane.status?.id ?? 'unassigned'"
              :status="lane.status" :tasks="lane.tasks" :selected-task-id="selectedTaskId" :task-index-by-id="taskIndexById" :type-name-by-id="typeNameById"
              :priority-option-by-id="priorityOptionById" :assignee-name-by-id="assigneeNameById"
              :disabled="saving || taskDraftDirty || !!quickTask" :saving="saving"
              :quick-task="quickTask && quickTask.statusId === (lane.status?.id ?? null) ? quickTask : null"
              :quick-error="quickError" :quick-stale="quickStale"
              @open-task="switchTask" @add-task="startQuickTask" @submit-quick="submitQuickTask" @cancel-quick="cancelQuickTask" @refresh-quick="refreshQuickTask"
              @move-task="(taskId, beforeId) => persistMove(taskId, lane.status?.id ?? null, beforeId)"
            />
          </div>
        </DragDropProvider>
      </div>
    </div>

  </section>

  <Teleport to="body">
    <dialog v-if="graph && taskDraft" ref="taskDetailDialog" class="task-detail-dialog" aria-labelledby="task-detail-page-title" @cancel.prevent="closeTaskDetails" @click.self="closeTaskDetails">
      <div class="task-detail-modal">
        <header class="task-detail-modal-header">
          <div class="task-detail-heading">
            <h2 id="task-detail-page-title" class="visually-hidden" tabindex="-1">{{ taskDraft.id ? '任务详情' : '新建任务' }}</h2>
            <div class="task-heading-fields">
              <span class="task-heading-icon"><AppIcon name="tasks" /></span>
              <label class="visually-hidden" for="task-board-external-id">Task ID（{{ taskDraft.id ? '可选' : '必填' }}，1–16 位数字）</label>
              <input id="task-board-external-id" v-model="taskDraft.externalTaskId" form="task-detail-form" inputmode="numeric" placeholder="编号" title="点击编辑 Task ID" :aria-required="!taskDraft.id" :aria-invalid="!!taskIdError" :aria-describedby="taskIdError ? 'task-id-error' : taskIdOverflow ? 'task-id-overflow' : undefined" :disabled="saving && !taskDraft.id" :readonly="taskDraftStale && !saving" @input="taskIdError = ''" @blur="requestAutoSave" />
              <span class="task-heading-divider" aria-hidden="true"></span>
              <label for="task-board-parent">父任务</label>
              <select id="task-board-parent" v-model="taskDraft.parentTaskId" form="task-detail-form" :disabled="taskFieldsDisabled" @change="requestAutoSave">
                <option :value="null">无父任务</option>
                <option v-for="candidate in parentTaskCandidates" :key="candidate.id" :value="candidate.id">{{ candidate.externalTaskId ? `${candidate.externalTaskId} · ` : '' }}{{ candidate.name }}</option>
              </select>
            </div>
          </div>
          <div class="task-header-actions">
            <span v-if="saving || taskDraftDirty || statusMessage" class="task-save-status" role="status">{{ saving ? '保存中…' : taskDraftDirty ? '未保存' : statusMessage }}</span>
            <button v-if="taskDraft.id" type="button" class="secondary icon-button" aria-label="删除任务" title="删除任务" :disabled="saving || taskDraftStale" @click="deleteCurrentTask"><AppIcon name="trash" /></button>
            <button type="button" class="secondary icon-button" aria-label="关闭任务详情" title="关闭任务详情" :disabled="saving" @click="closeTaskDetails"><AppIcon name="clear" /></button>
          </div>
        </header>
        <section ref="taskDetailView" class="task-detail-view" :class="{ 'is-stale': taskDraftStale }" aria-labelledby="task-detail-page-title">
          <div ref="taskDetailMainScroll" class="task-detail-main-scroll">
            <p v-if="taskDraftStale && !saving" class="task-board-message is-error" role="alert">任务已在其他标签页更新，请取消后重新打开。</p>
            <p v-if="taskIdOverflow && !taskDraft.id" id="task-id-overflow" class="task-board-message" role="status">已有 Task ID 达到 16 位上限，无法自动编号，请手工填写未使用的编号。</p>
            <p v-if="taskIdError" id="task-id-error" class="task-board-message is-error" role="alert">{{ taskIdError }}</p>
            <p v-if="error" class="task-board-message is-error" role="alert">{{ error }}</p>
            <form id="task-detail-form" class="task-detail-form" @submit.prevent="submitTask" @change="requestAutoSave">
              <label class="visually-hidden" for="task-board-name">任务名（必填）</label>
              <input id="task-board-name" v-model="taskDraft.name" required placeholder="任务名称" title="点击编辑任务名" :disabled="saving && !taskDraft.id" :readonly="taskDraftStale && !saving" @blur="requestAutoSave" />
              <div class="task-fields-row task-summary-fields">
                <div class="task-summary-field"><span class="task-field-icon is-status"><AppIcon name="status" /></span><div><label for="task-board-status">状态</label><select id="task-board-status" v-model="taskDraft.statusOptionId" :disabled="taskFieldsDisabled">
                  <option :value="null">未分组</option><option v-for="option in graph.project.statusOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
                </select></div></div>
                <div class="task-summary-field"><span class="task-field-icon"><AppIcon name="user" /></span><div><label for="task-board-assignee">负责人</label><select id="task-board-assignee" v-model="taskDraft.assigneeId" :disabled="taskFieldsDisabled">
                  <option :value="null">未分配</option><option v-for="option in graph.project.assigneeOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
                </select></div></div>
                <div class="task-summary-field"><span class="task-field-icon"><AppIcon name="calendar" /></span><div><label for="task-board-start">开始日期</label><div class="task-date-input"><span aria-hidden="true">{{ startDateInput || '年-月-日' }}</span><input id="task-board-start" v-model="startDateInput" type="date" lang="zh-CN" :max="dueDateInput || undefined" :disabled="taskFieldsDisabled" /></div></div></div>
                <div class="task-summary-field"><span class="task-field-icon"><AppIcon name="calendar" /></span><div><label for="task-board-due">截止日期</label><div class="task-date-input"><span aria-hidden="true">{{ dueDateInput || '年-月-日' }}</span><input id="task-board-due" v-model="dueDateInput" type="date" lang="zh-CN" :min="startDateInput || undefined" :disabled="taskFieldsDisabled" /></div></div></div>
              </div>
              <div class="task-content-tabs" role="group" aria-label="任务内容">
                <button type="button" :aria-pressed="detailSection === 'information'" @click="detailSection = 'information'"><AppIcon name="tasks" />任务信息</button>
                <button type="button" :aria-pressed="detailSection === 'children'" @click="detailSection = 'children'"><AppIcon name="branch" />子任务 <span>{{ childTasks.length }}</span></button>
              </div>
              <div v-show="detailSection === 'information'" class="task-info-panel">
              <div class="task-fields-row task-fields-secondary">
                <div><label for="task-board-priority">优先级</label><div class="task-priority-control">
                  <span class="task-priority-value" aria-hidden="true"><span v-if="taskDraft.priorityOptionId" class="task-priority-indicator" :style="{ color: priorityOptionById.get(taskDraft.priorityOptionId)?.indicatorColor }">{{ '!'.repeat(priorityOptionById.get(taskDraft.priorityOptionId)?.indicatorCount ?? 1) }}</span>{{ taskDraft.priorityOptionId ? priorityOptionById.get(taskDraft.priorityOptionId)?.name : '未设置' }}</span>
                  <span class="task-priority-chevron" aria-hidden="true"></span>
                  <select id="task-board-priority" v-model="taskDraft.priorityOptionId" :disabled="taskFieldsDisabled">
                  <option :value="null">未设置</option>
                  <option v-for="option in graph.project.priorityOptions" :key="option.id" :value="option.id">{{ '!'.repeat(option.indicatorCount ?? 1) }} {{ option.name }}</option>
                </select></div></div>
                <div><label for="task-board-type">类型</label><select id="task-board-type" v-model="taskDraft.typeOptionId" :disabled="taskFieldsDisabled">
                  <option :value="null">未设置</option>
                  <option v-for="option in graph.project.typeOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
                </select><p v-if="legacyTypeNames.length" class="task-legacy-type-notice" role="status">仍有旧类型名称：{{ legacyTypeNames.join('、') }}。请在“管理选项”中检查并修改。</p></div>
              </div>
              <div class="task-description-field"><label for="task-board-description">说明</label>
                <textarea id="task-board-description" v-model="taskDraft.description" rows="6" placeholder="添加任务说明…" :disabled="saving && !taskDraft.id" :readonly="taskDraftStale && !saving" @input="scheduleDescriptionSave"></textarea>
              </div>
              </div>
              <div v-show="detailSection === 'children'" class="task-child-list">
                <ul v-if="childTasks.length"><li v-for="child in childTasks" :key="child.id">
                  <button type="button" :disabled="saving" @click="switchTask(child.id)"><AppIcon name="status" /><code v-if="child.externalTaskId">{{ child.externalTaskId }}</code><span>{{ child.name }}</span><AppIcon name="chevron-right" /></button>
                </li></ul>
                <p v-else class="task-child-empty">{{ taskDraft.id ? '暂无子任务' : '创建任务后可关联子任务' }}</p>
              </div>
              <div v-if="!taskDraft.id || (error && !taskDraftStale)" class="task-detail-actions">
                <button type="submit" :disabled="saving || taskDraftStale || commentDraftDirty || !taskDraft.name.trim()"><AppIcon name="check" />{{ taskDraft.id ? '重试保存' : '创建任务' }}</button>
              </div>
            </form>
          </div>
          <aside v-if="taskDraft.id" class="task-detail-sidebar">
            <div class="task-sidebar-tabs" role="group" aria-label="任务侧栏">
              <button type="button" class="secondary" :aria-pressed="detailSidebar === 'comments'" @click="detailSidebar = 'comments'">评论（{{ taskDraft.comments.length }}）</button>
              <button type="button" class="secondary" :aria-pressed="detailSidebar === 'versions'" @click="detailSidebar = 'versions'">关联软件版本（{{ graph.nodes.filter(node => node.taskId === taskDraft!.id).length }}）</button>
            </div>
            <section v-show="detailSidebar === 'versions'" class="task-related-versions" aria-labelledby="task-related-title">
              <header><h4 id="task-related-title">关联版本</h4><span>{{ graph.nodes.filter(node => node.taskId === taskDraft!.id).length }}</span></header>
              <ul v-if="graph.nodes.some(node => node.taskId === taskDraft!.id)">
                <li v-for="node in graph.nodes.filter(item => item.taskId === taskDraft!.id)" :key="node.id">
                  <button type="button" class="task-version-link" :disabled="saving" @click="openRelatedVersion(node.id)">
                    <code>{{ node.version }}</code><span>{{ node.description || '（无改动说明）' }}</span><AppIcon name="arrow" />
                  </button>
                </li>
              </ul>
              <p v-else class="form-help">此任务尚未关联版本。</p>
            </section>
          <section v-show="detailSidebar === 'comments'" class="task-comments" aria-labelledby="task-comments-title">
            <h4 id="task-comments-title" class="visually-hidden">评论</h4>
            <ul v-if="taskDraft.comments.length" class="task-comment-list">
              <li v-for="comment in taskDraft.comments" :key="comment.id" class="task-comment">
                <div class="task-comment-meta"><time :datetime="comment.createdAt">{{ formatTime(comment.createdAt) }}</time><span v-if="comment.updatedAt !== comment.createdAt">已编辑 {{ formatTime(comment.updatedAt) }}</span></div>
                <div class="markdown-content task-comment-content" v-html="renderMarkdown(comment.text)"></div>
                <div class="task-comment-actions">
                  <button type="button" class="secondary" :disabled="saving || taskDraftStale || taskDraftDirty" :aria-label="`编辑评论 ${formatTime(comment.createdAt)}`" @click="beginEditComment(comment)"><AppIcon name="edit" /></button>
                  <button type="button" class="secondary" :disabled="saving || taskDraftStale || taskDraftDirty" :aria-label="`删除评论 ${formatTime(comment.createdAt)}`" @click="deleteComment(comment)"><AppIcon name="trash" /></button>
                </div>
              </li>
            </ul>
            <p v-else class="task-comments-empty">暂无评论</p>
            <form v-if="commentEditorOpen" class="task-comment-editor" @submit.prevent="saveComment">
              <h5>{{ editingCommentId ? '编辑评论' : '新建评论' }}</h5>
              <MarkdownEditor v-model="commentText" textarea-id="task-comment-markdown" :disabled="saving" :readonly="taskDraftStale" />
              <div class="task-comment-editor-actions">
                <button type="submit" :disabled="saving || taskDraftStale || taskDraftDirty || !commentText.trim()"><AppIcon name="check" />保存评论</button>
                <button type="button" class="secondary" :disabled="saving" @click="cancelComment">取消</button>
              </div>
            </form>
            <button v-else type="button" class="task-comment-composer" :disabled="saving || taskDraftStale || taskDraftDirty" @click="beginNewComment">添加评论…</button>
          </section>
          </aside>
          <aside v-else class="task-comments-empty-note">保存任务后，可以在详情中继续添加评论和查看关联版本。</aside>
        </section>
      </div>
    </dialog>
  </Teleport>

  <dialog ref="optionsDialog" class="task-options-dialog" aria-labelledby="task-options-title" @cancel.prevent="closeOptions">
    <form method="dialog" @submit.prevent>
      <header class="task-options-heading"><div><p class="eyebrow">PROJECT SETTINGS</p><h2 id="task-options-title">任务选项</h2></div><button type="button" class="secondary icon-button" aria-label="关闭任务选项" @click="closeOptions"><AppIcon name="clear" /></button></header>
      <div class="task-option-tabs" role="group" aria-label="选项类别">
        <button v-for="kind in (['status', 'type', 'priority', 'assignee'] as const)" :key="kind" type="button" class="secondary" :aria-pressed="optionKind === kind" @click="selectOptionKind(kind)">{{ { status: 'Status', type: 'Type', priority: '优先级', assignee: '负责人' }[kind] }}</button>
      </div>
      <div class="task-option-add">
        <label for="task-option-name">新增{{ currentOptionLabel }}</label>
        <div><input id="task-option-name" v-model="optionName" :disabled="saving || optionDraftStale" @keydown.enter.prevent="addOption" /><button type="button" :disabled="saving || optionDraftStale || !optionName.trim()" @click="addOption"><AppIcon name="plus" />添加</button></div>
      </div>
      <ul class="task-option-list">
        <li v-for="option in optionDraft" :key="option.id" :class="{ 'is-priority': optionKind === 'priority' }">
          <input v-model="option.name" :aria-label="`${currentOptionLabel}名称`" :disabled="saving || optionDraftStale" />
          <div v-if="optionKind === 'priority'" class="priority-option-controls">
            <select v-model.number="option.indicatorCount" :aria-label="`${option.name}的感叹号数量`" :disabled="saving || optionDraftStale">
              <option :value="1">! × 1</option>
              <option :value="2">! × 2</option>
              <option :value="3">! × 3</option>
            </select>
            <input v-model="option.indicatorColor" type="color" :aria-label="`${option.name}的感叹号颜色`" :disabled="saving || optionDraftStale" />
          </div>
          <span v-if="taskReferenceCount(option.id)" class="task-option-use-count">{{ taskReferenceCount(option.id) }} 个任务</span>
          <button type="button" class="secondary icon-button" :disabled="saving || optionDraftStale" :aria-label="`删除${currentOptionLabel} ${option.name}`" @click="removeOption(option.id)"><AppIcon name="trash" /></button>
        </li>
        <li v-if="!optionDraft.length" class="task-option-empty">暂无{{ currentOptionLabel }}选项。</li>
      </ul>
      <p v-if="optionDraftStale" class="task-board-message is-error" role="alert">项目已更新。请关闭并重新打开选项管理。</p>
      <footer class="task-options-footer">
        <button type="button" :disabled="saving || optionDraftStale || !optionDraftChanged" @click="saveOptions"><AppIcon name="check" />保存选项</button>
        <button type="button" class="secondary" :disabled="saving" @click="closeOptions">取消</button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.task-board { min-width: 0; border-top: 2px solid #3b82f6; padding: 18px; }
.task-board-header, .task-board-header-actions, .task-board-toolbar, .task-options-heading, .task-options-footer { display: flex; align-items: center; gap: 10px; }
.task-board-header { justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
.task-board-header h2 { overflow-wrap: anywhere; }
.task-board-header-actions { flex-wrap: wrap; }
.task-board-header-actions button { min-height: 44px; }
.task-view-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
.task-view-switch { display: flex; gap: 4px; padding: 3px; border: 1px solid #35445c; border-radius: 7px; background: #101a2a; }
.task-view-switch button { min-height: 44px; padding: 8px 14px; border: 1px solid transparent; background: transparent; color: #afbdd2; }
.task-view-switch button:hover { background: #253650; color: #eef4ff; }
.task-view-switch button[aria-pressed="true"] { border-color: #52647e; background: #1d2b42; color: #eef4ff; }
.task-nesting-toggle { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; margin: 0; color: #eef4ff; cursor: pointer; }
.task-nesting-toggle input { width: 18px; height: 18px; margin: 0; accent-color: #60a5fa; }
.task-board-toolbar { min-width: 0; margin-bottom: 12px; }
.task-board-search-label { flex: 0 0 auto; margin: 0; }
.task-board-search-mode { flex: 0 0 132px; min-width: 0; margin: 0; }
.task-board-toolbar input { flex: 1; min-width: 120px; margin: 0; }
.task-board-count { color: #afbdd2; font-size: 11px; white-space: nowrap; }
.task-board-message, .task-board-state { margin: 8px 0; color: #cbd9ed; font-size: 12px; line-height: 1.6; }
.task-board-message { padding: 9px 11px; border: 1px solid #35445c; border-radius: 6px; background: #101a2a; }
.task-board-message.is-error { border-color: #9c4a55; background: #2a1820; color: #ffd1d5; }
.task-board-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.task-board-scroll { display: block; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior: contain; scrollbar-gutter: stable; }
.task-board-lanes { display: flex; align-items: stretch; gap: 10px; width: max-content; min-width: 100%; height: clamp(320px, calc(100dvh - 260px), 680px); padding: 2px 2px 10px; }
.task-detail-dialog { width: min(1480px, calc(100vw - 48px)); height: min(920px, calc(100dvh - 48px)); max-width: none; max-height: none; margin: auto; padding: 0; overflow: hidden; border: 1px solid #52647e; border-radius: 8px; background: #101a2a; color: #eef4ff; box-shadow: 0 24px 80px #020617aa; }
.task-detail-dialog::backdrop { background: #020617a8; backdrop-filter: blur(2px); }
.task-detail-modal { display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: 100%; min-width: 0; }
.task-detail-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 60px; padding: 6px 24px; border-bottom: 1px solid #27364d; background: #121c2d; }
.task-header-actions { display: flex; align-items: center; flex-shrink: 0; }
.task-header-actions .icon-button { flex: 0 0 44px; color: #afbdd2; }
.task-header-actions .icon-button:hover { background: #203047; color: #eef4ff; }
.task-save-status { padding: 0 8px; color: #afbdd2; font-size: 12px; white-space: nowrap; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.task-detail-heading { flex: 1; min-width: 0; }
.task-heading-fields { display: flex; align-items: center; gap: 8px; min-width: 0; }
.task-heading-icon { display: grid; flex: 0 0 28px; width: 28px; height: 28px; place-items: center; border-radius: 6px; background: #203c3b; color: #8fe6c9; }
.task-heading-icon .app-icon { width: 16px; height: 16px; }
.task-heading-fields label { flex-shrink: 0; margin: 0; color: #afbdd2; font-size: 12px; }
.task-heading-fields input, .task-heading-fields select { width: auto; min-width: 0; min-height: 44px; margin: 0; padding: 8px; border: 1px solid transparent; background-color: transparent; color: #dce8f9; }
.task-heading-fields input:hover, .task-heading-fields select:hover { border-color: #52647e; background-color: #1d2b42; }
.task-heading-fields #task-board-external-id { flex: 0 1 100px; width: 100px; font-family: monospace; font-weight: 700; color: #d6ebff; }
.task-heading-fields #task-board-parent { flex: 0 1 260px; max-width: 260px; }
.task-heading-divider { flex: 0 0 1px; height: 20px; background: #35445c; }
.task-detail-view { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 34%); min-width: 0; min-height: 0; overflow: hidden; }
.task-detail-main-scroll { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 24px clamp(20px, 3vw, 42px) 40px; }
.task-detail-form { display: grid; align-content: start; gap: 24px; min-width: 0; }
.task-detail-form #task-board-name { min-height: 48px; margin: 0; padding: 7px 10px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: #eef4ff; font-size: 22px; font-weight: 700; }
.task-detail-form #task-board-name:hover { border-color: #52647e; background: #1d2b42; }
.task-fields-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
.task-fields-secondary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.task-fields-row > div { min-width: 0; }
.task-detail-form label { margin-bottom: 4px; color: #afbdd2; font-size: 12px; }
.task-detail-form input, .task-detail-form select, .task-detail-form textarea { width: 100%; min-width: 0; margin: 0; color: #eef4ff; }
.task-summary-field { display: flex; align-items: center; gap: 10px; min-width: 0; }
.task-summary-field > div { flex: 1; min-width: 0; }
.task-field-icon { display: grid; flex: 0 0 36px; width: 36px; height: 36px; place-items: center; border: 1px solid #52647e; border-radius: 50%; color: #b7c8de; }
.task-field-icon.is-status { border-color: #6ee7b7; color: #6ee7b7; }
.task-field-icon .app-icon { width: 19px; height: 19px; }
.task-summary-field select, .task-summary-field input { min-height: 44px; padding: 6px; border-color: transparent; background-color: transparent; font-size: 12px; }
.task-summary-field select:hover, .task-summary-field input:hover { border-color: #52647e; background-color: #1d2b42; }
.task-date-input { position: relative; display: flex; align-items: center; min-height: 44px; padding: 6px; border: 1px solid transparent; border-radius: 6px; color: #eef4ff; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-date-input:hover { border-color: #52647e; background: #1d2b42; }
.task-date-input:focus-within { outline: 3px solid #7dd3fc; outline-offset: 3px; }
.task-date-input input { position: absolute; inset: 0; height: 100%; opacity: 0; cursor: pointer; }
.task-date-input:focus-within span { visibility: hidden; }
.task-date-input:focus-within input { opacity: 1; background: #1d2b42; }
.task-date-input input:disabled { cursor: not-allowed; }
.task-date-input:has(input:disabled) { color: #8290a6; }
.task-fields-secondary select option { background: #121c2d; }
.task-content-tabs { display: flex; gap: 22px; border-bottom: 1px solid #35445c; }
.task-content-tabs button, .task-sidebar-tabs button { display: inline-flex; align-items: center; gap: 7px; width: auto; min-height: 48px; margin: 0 0 -1px; padding: 8px 2px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: #afbdd2; font-size: 13px; font-weight: 500; }
.task-content-tabs button:hover, .task-sidebar-tabs button:hover { background: transparent; color: #eef4ff; }
.task-content-tabs button[aria-pressed="true"], .task-sidebar-tabs button[aria-pressed="true"] { border-bottom-color: #60a5fa; color: #a7d2ff; }
.task-content-tabs .app-icon { width: 17px; height: 17px; }
.task-content-tabs span { color: #afbdd2; }
.task-info-panel { display: grid; gap: 28px; }
.task-fields-secondary select { min-height: 44px; padding: 7px; border-color: transparent; background-color: transparent; }
.task-fields-secondary select:hover { border-color: #52647e; background-color: #1d2b42; }
.task-legacy-type-notice { margin: 4px 0 0; color: #fcd34d; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.task-detail-form textarea { min-height: 180px; padding: 12px; resize: vertical; border: 1px solid #35445c; border-radius: 6px; background: #0e1828; font: inherit; line-height: 1.65; }
.task-priority-control { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 7px; border: 1px solid transparent; border-radius: 6px; }
.task-priority-control:hover { border-color: #52647e; background: #1d2b42; }
.task-priority-control:focus-within { outline: 3px solid #7dd3fc; outline-offset: 3px; }
.task-priority-value { min-width: 0; overflow-wrap: anywhere; color: #eef4ff; }
.task-priority-indicator { margin-right: 5px; font-weight: 700; }
.task-priority-chevron { flex: 0 0 7px; height: 7px; margin: -4px 5px 0 0; border-right: 1px solid #eef4ff; border-bottom: 1px solid #eef4ff; transform: rotate(45deg); }
.task-priority-control select { position: absolute; inset: 0; height: 100%; opacity: 0; cursor: pointer; }
.task-priority-control:has(select:disabled) { opacity: .6; }
.task-priority-control select:disabled { cursor: not-allowed; }
.task-detail-form > .form-help { margin: 0; }
.task-child-list { min-width: 0; }
.task-child-list ul { display: grid; list-style: none; margin: 0; padding: 0; }
.task-child-list li { min-width: 0; border-bottom: 1px solid #27364d; }
.task-child-list button { display: flex; justify-content: flex-start; gap: 12px; width: 100%; min-height: 52px; padding: 6px 10px; border: 0; background: transparent; color: #eef4ff; text-align: left; }
.task-child-list button:hover { background: #1d2b42; }
.task-child-list button span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.task-child-list button code { color: #b7d8ff; }
.task-child-list .app-icon { width: 18px; height: 18px; color: #afbdd2; }
.task-child-empty { margin: 16px 0; color: #afbdd2; }
.task-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 4px; }
.task-detail-actions button { width: auto; min-height: 44px; }
.task-detail-sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid #35445c; background: #111b2c; }
.task-sidebar-tabs { display: flex; gap: 20px; flex-wrap: wrap; padding: 0 18px; border-bottom: 1px solid #35445c; }
.task-related-versions { min-height: 0; overflow: auto; padding: 16px; }
.task-related-versions > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.task-related-versions h4, .task-comments h4 { margin: 0; color: #eef4ff; font-size: 13px; }
.task-related-versions > header > span { color: #afbdd2; font-size: 11px; }
.task-related-versions ul, .task-comment-list { display: grid; gap: 6px; list-style: none; margin: 0; padding: 0; }
.task-related-versions li, .task-comment { min-width: 0; padding: 8px; border: 1px solid #35445c; border-radius: 6px; background: #101a2a; }
.task-version-link { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) 18px; justify-content: start; width: 100%; min-width: 0; min-height: 40px; padding: 4px; border: 0; background: transparent; text-align: left; }
.task-version-link:hover { background: #17243a; }
.task-version-link code { overflow: hidden; color: #b7d8ff; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.task-version-link span { overflow: hidden; color: #c0cde0; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.task-version-link .app-icon { width: 16px; height: 16px; }
.task-comments { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.task-comment-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; align-content: start; padding: 12px; }
.task-comments-empty { display: grid; flex: 1 1 auto; place-items: center; min-height: 120px; margin: 0; color: #8fa0b8; font-size: 12px; }
.task-comments-empty-note { display: grid; place-items: center; padding: 24px; border-left: 1px solid #35445c; color: #9eafc5; font-size: 12px; text-align: center; }
.task-comment-composer { flex: 0 0 auto; min-height: 52px; margin: 10px 12px 12px; padding: 10px 12px; border: 1px solid #35445c; border-radius: 6px; background: #0c1523; color: #9eafc5; text-align: left; }
.task-comment-composer:hover { border-color: #6684aa; color: #e6effc; }
.task-comment-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; color: #afbdd2; font-size: 10px; font-variant-numeric: tabular-nums; }
.task-comment-content { margin: 8px 0; font-size: 12px; overflow-wrap: anywhere; }
.task-comment-content :deep(img) { display: none; }
.task-comment-actions { display: flex; justify-content: flex-end; gap: 6px; }
.task-comment-actions button { min-height: 44px; padding: 5px 8px; font-size: 11px; }
.task-comment-editor { flex: 0 0 auto; margin: 10px 12px 12px; padding: 10px; border: 1px solid #35445c; border-radius: 6px; background: #0c1523; }
.task-comment-editor h5 { margin: 0 0 8px; font-size: 12px; }
.task-comment-editor :deep(.markdown-editor-toolbar) { gap: 5px; }
.task-comment-editor :deep(.markdown-editor-toolbar button) { min-width: 0; min-height: 44px; padding: 6px 10px; }
.task-comment-editor :deep(.markdown-editor textarea) { min-height: 120px; margin: 0; }
.task-comment-editor-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.task-comment-editor-actions button { width: auto; min-height: 44px; }
.task-options-dialog { width: min(560px, calc(100vw - 24px)); max-height: min(760px, calc(100dvh - 24px)); overflow: auto; padding: 18px; border: 1px solid #52647e; border-radius: 8px; background: #121c2d; color: #eef4ff; }
.task-options-dialog::backdrop { background: #020617aa; }
.task-options-dialog form { display: grid; gap: 12px; }
.task-options-heading { justify-content: space-between; }
.task-options-heading h2 { font-size: 17px; }
.task-option-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.task-option-tabs button { min-height: 44px; padding: 7px 10px; font-size: 11px; }
.task-option-tabs button[aria-pressed="true"] { border-color: #77baff; background: #203652; box-shadow: inset 0 0 0 1px #77baff; }
.task-option-add label { margin-bottom: 5px; }
.task-option-add > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.task-option-add input { margin: 0; }
.task-option-add button { min-height: 44px; }
.task-option-list { display: grid; gap: 6px; max-height: 320px; overflow: auto; list-style: none; margin: 0; padding: 0; }
.task-option-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto 44px; align-items: center; gap: 6px; }
.task-option-list li.is-priority { grid-template-columns: minmax(0, 1fr) 112px auto 44px; }
.task-option-list input { min-width: 0; margin: 0; }
.priority-option-controls { display: flex; align-items: center; gap: 4px; }
.priority-option-controls select { width: 68px; min-width: 68px; min-height: 40px; margin: 0; padding: 6px; font-size: 11px; }
.priority-option-controls input[type="color"] { width: 40px; min-width: 40px; height: 40px; min-height: 40px; margin: 0; padding: 4px; }
.task-option-list .icon-button { min-width: 44px; width: 44px; height: 44px; }
.task-option-use-count, .task-option-empty { color: #afbdd2; font-size: 11px; }
.task-option-empty { display: block !important; padding: 12px; text-align: center; }
.task-options-footer { justify-content: flex-end; padding-top: 8px; border-top: 1px solid #35445c; }
.task-options-footer button { min-height: 44px; }
@media (max-width: 760px) {
  .task-detail-dialog { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
  .task-detail-modal-header { min-height: 60px; padding: 6px 12px; }
  .task-detail-view { display: flex; flex-direction: column; overflow-y: auto; }
  .task-detail-main-scroll { flex: 0 0 auto; overflow: visible; padding: 16px; }
  .task-detail-sidebar { flex: 0 0 auto; min-height: 360px; border-top: 1px solid #35445c; border-left: 0; }
  .task-comments { min-height: 300px; }
  .task-comment-list { flex: 1 1 auto; }
  .task-comments-empty { flex: 1 0 120px; }
  .task-comments-empty-note { min-height: 240px; border-top: 1px solid #35445c; border-left: 0; }
}
@media (max-width: 560px) {
  .task-board { padding: 12px; }
  .task-board-header { align-items: flex-start; }
  .task-board-header-actions { width: 100%; }
  .task-board-header-actions button { flex: 1; }
  .task-board-toolbar { flex-wrap: wrap; }
  .task-board-search-label { flex: 0 0 auto; }
  .task-board-search-mode { flex: 1 1 110px; }
  .task-board-toolbar input { flex: 1 1 100%; order: 2; }
  .task-board-count { margin-left: auto; }
  .task-fields-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-fields-secondary { grid-template-columns: minmax(0, 1fr); }
  .task-detail-actions { margin-top: 14px; }
  .task-heading-fields { gap: 4px; }
  .task-heading-fields #task-board-external-id { flex-basis: 60px; width: 60px; }
  .task-heading-fields #task-board-parent { flex: 1 1 90px; }
  .task-heading-fields label:not(.visually-hidden) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .task-save-status { max-width: 62px; overflow-wrap: anywhere; font-size: 11px; white-space: normal; }
}
</style>