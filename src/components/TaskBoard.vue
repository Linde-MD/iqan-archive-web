<script setup lang="ts">
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/vue';
import { isSortableOperation } from '@dnd-kit/vue/sortable';
import { liveQuery } from 'dexie';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, toRaw, watch } from 'vue';
import { moveTaskInBoard, tasksInLane } from '../domain/task-board';
import { createPriorityOption, type Project, type ProjectGraph, type Task, type TaskComment, type TaskOption } from '../domain/model';
import type { ArchiveRepository } from '../storage/database';
import { renderMarkdown } from '../utils/markdown';
import AppIcon from './AppIcon.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import TaskBoardLane from './TaskBoardLane.vue';

type OptionKey = 'statusOptions' | 'typeOptions' | 'priorityOptions' | 'assigneeOptions';
type OptionKind = 'status' | 'type' | 'priority' | 'assignee';

const props = defineProps<{
  repository: ArchiveRepository;
  projectId: string;
  projectName: string;
  focusTaskId: string | null;
}>();
const emit = defineEmits<{
  busy: [value: boolean];
  graph: [nodeId: string];
}>();

const graph = shallowRef<ProjectGraph>();
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const statusMessage = ref('');
const query = ref('');
const selectedTaskId = ref('');
const taskDraft = ref<Task | null>(null);
const taskDraftRevision = ref(-1);
const taskDraftBaseline = ref('');
const commentEditorOpen = ref(false);
const editingCommentId = ref<string | null>(null);
const commentText = ref('');
const commentTextBaseline = ref('');
const optionsDialog = ref<HTMLDialogElement>();
const optionKind = ref<OptionKind>('status');
const optionName = ref('');
const optionNameDrafts = ref<Record<OptionKind, string>>({ status: '', type: '', priority: '', assignee: '' });
const optionDraft = ref<TaskOption[]>([]);
const optionDraftRevision = ref(-1);
const dragSaving = ref(false);
let subscription: { unsubscribe(): void } | undefined;
let lastDragOverTarget: DragEndEvent['operation']['target'] | null = null;

const taskDraftDirty = computed(() => !!taskDraft.value && JSON.stringify(taskDraft.value) !== taskDraftBaseline.value);
const commentDraftDirty = computed(() => commentEditorOpen.value && commentText.value !== commentTextBaseline.value);
const hasUnsavedTaskChanges = computed(() => taskDraftDirty.value || commentDraftDirty.value);
const taskDraftStale = computed(() => !graph.value || taskDraftRevision.value !== graph.value.project.revision);
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
const priorityOptionById = computed(() => new Map((graph.value?.project.priorityOptions ?? []).map(option => [option.id, option])));
const assigneeNameById = computed(() => new Map((graph.value?.project.assigneeOptions ?? []).map(option => [option.id, option.name])));
const taskMatches = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return (graph.value?.tasks ?? []).filter(task => {
    if (!search) return true;
    const assignee = task.assigneeId ? assigneeNameById.value.get(task.assigneeId) ?? '' : '';
    return `${task.name} ${task.externalTaskId ?? ''} ${assignee}`.toLocaleLowerCase().includes(search);
  });
});
const lanes = computed(() => {
  const current = graph.value;
  if (!current) return [];
  const visibleTaskIds = new Set(taskMatches.value.map(task => task.id));
  return [
    ...current.project.statusOptions.map(status => ({
      status,
      tasks: tasksInLane(current, status.id).filter(task => visibleTaskIds.has(task.id)),
    })),
    { status: null, tasks: tasksInLane(current, null).filter(task => visibleTaskIds.has(task.id)) },
  ];
});
const taskIndexById = computed(() => new Map(lanes.value.flatMap(lane => lane.tasks)
  .map((task, index) => [task.id, index] as const)));
const optionDraftChanged = computed(() => {
  const current = graph.value?.project[optionKey.value] ?? [];
  return JSON.stringify(optionDraft.value) !== JSON.stringify(current);
});

function setTaskDraft(task: Task) {
  taskDraft.value = structuredClone(task);
  taskDraftRevision.value = graph.value?.project.revision ?? -1;
  taskDraftBaseline.value = JSON.stringify(taskDraft.value);
  selectedTaskId.value = task.id;
  commentEditorOpen.value = false;
  editingCommentId.value = null;
  commentText.value = '';
  commentTextBaseline.value = '';
}

function switchTask(taskId: string) {
  if (hasUnsavedTaskChanges.value && selectedTaskId.value !== taskId
    && !window.confirm('当前任务修改尚未保存。放弃修改并切换任务吗？')) return;
  const task = graph.value?.tasks.find(candidate => candidate.id === taskId);
  if (task) {
    setTaskDraft(task);
    void nextTick(() => document.getElementById('task-detail-page-title')?.focus({ preventScroll: true }));
  }
}

function createTask(statusOptionId?: string | null) {
  if (hasUnsavedTaskChanges.value && !window.confirm('当前任务修改尚未保存。放弃修改并新建任务吗？')) return;
  const current = graph.value;
  if (!current) return;
  const defaultStatus = current.project.statusOptions[0]?.id ?? null;
  const targetStatus = statusOptionId === undefined ? defaultStatus : statusOptionId;
  const task: Task = {
    id: '', projectId: current.project.id, name: '', description: '', externalTaskId: null,
    statusOptionId: targetStatus, typeOptionId: null, priorityOptionId: null, assigneeId: null,
    startDate: null, dueDate: null, sortOrder: tasksInLane(current, targetStatus).length, comments: [],
  };
  taskDraft.value = task;
  taskDraftRevision.value = current.project.revision;
  taskDraftBaseline.value = JSON.stringify(task);
  selectedTaskId.value = '';
  commentEditorOpen.value = false;
  editingCommentId.value = null;
  commentText.value = '';
  commentTextBaseline.value = '';
  void nextTick(() => document.getElementById('task-board-name')?.focus());
}

function reportError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '本地任务操作失败，请重试。';
  statusMessage.value = '';
}

async function saveTask(candidate: Task, successMessage: string) {
  const current = graph.value;
  if (!current || taskDraftRevision.value !== current.project.revision) {
    error.value = '项目已在其他标签页更新。请重新读取任务后再保存。';
    statusMessage.value = '';
    return false;
  }
  saving.value = true;
  try {
    const taskId = candidate.id || crypto.randomUUID();
    const persistedTask = current.tasks.find(task => task.id === taskId);
    const persisted = await props.repository.saveTask(props.projectId, taskDraftRevision.value, {
      ...structuredClone(toRaw(candidate)),
      id: taskId,
      projectId: current.project.id,
      name: candidate.name.trim(),
      externalTaskId: candidate.externalTaskId?.trim() || null,
      sortOrder: persistedTask?.statusOptionId === candidate.statusOptionId
        ? persistedTask.sortOrder
        : tasksInLane(current, candidate.statusOptionId).length,
    });
    const saved = persisted.tasks.find(task => task.id === taskId);
    graph.value = persisted;
    if (saved) setTaskDraft(saved);
    error.value = '';
    statusMessage.value = successMessage;
    return true;
  } catch (cause) {
    reportError(cause);
    return false;
  } finally {
    saving.value = false;
  }
}

async function submitTask() {
  if (!taskDraft.value) return;
  if (commentDraftDirty.value) {
    error.value = '请先保存或取消未完成的评论，再保存任务。';
    return;
  }
  await saveTask(taskDraft.value, '任务已保存。');
}

async function deleteCurrentTask() {
  const current = graph.value;
  const task = taskDraft.value;
  if (!current || !task?.id || !window.confirm(`删除“${task.name}”及其评论，并解除所有版本关联吗？版本图关系不会改变。`)) return;
  saving.value = true;
  try {
    graph.value = await props.repository.deleteTask(props.projectId, current.project.revision, task.id);
    taskDraft.value = null;
    taskDraftRevision.value = -1;
    taskDraftBaseline.value = '';
    selectedTaskId.value = '';
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

function openOptions() {
  const current = graph.value;
  if (!current) return;
  optionKind.value = 'status';
  optionDraft.value = structuredClone(current.project.statusOptions);
  optionDraftRevision.value = current.project.revision;
  optionNameDrafts.value = { status: '', type: '', priority: '', assignee: '' };
  optionName.value = '';
  optionsDialog.value?.showModal();
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
  if (hasUnsavedTaskChanges.value && !window.confirm('放弃未保存的任务修改吗？')) return;
  const taskId = selectedTaskId.value;
  taskDraft.value = null;
  taskDraftRevision.value = -1;
  taskDraftBaseline.value = '';
  void nextTick(() => {
    const card = [...document.querySelectorAll<HTMLElement>('[data-task-card-id]')]
      .find(element => element.dataset.taskCardId === taskId);
    card?.querySelector<HTMLButtonElement>('.task-card-title')?.focus({ preventScroll: true });
  });
}

function beginEditComment(comment: TaskComment) {
  editingCommentId.value = comment.id;
  commentText.value = comment.text;
  commentTextBaseline.value = comment.text;
  commentEditorOpen.value = true;
}

async function saveComment() {
  const current = taskDraft.value;
  if (!current || !commentText.value.trim()) return;
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
  const current = taskDraft.value;
  if (!current || !window.confirm('删除这条评论吗？')) return;
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
  await nextTick();
  const card = [...document.querySelectorAll<HTMLElement>('[data-task-card-id]')]
    .find(element => element.dataset.taskCardId === targetId);
  card?.scrollIntoView({ block: 'center', inline: 'nearest' });
  card?.querySelector<HTMLButtonElement>('.task-card-title')?.focus({ preventScroll: true });
}

watch([graph, () => props.focusTaskId], () => { void focusRequestedTask(); }, { flush: 'post' });
watch(saving, value => emit('busy', value), { immediate: true });

onMounted(() => {
  subscription = liveQuery(() => props.repository.get(props.projectId)).subscribe({
    next: value => {
      graph.value = value;
      loading.value = false;
      if (selectedTaskId.value && !value.tasks.some(task => task.id === selectedTaskId.value)) {
        selectedTaskId.value = '';
        taskDraft.value = null;
      }
    },
    error: cause => {
      loading.value = false;
      reportError(cause);
    },
  });
});

onUnmounted(() => {
  subscription?.unsubscribe();
  emit('busy', false);
});
</script>

<template>
  <section class="panel task-board" :aria-labelledby="taskDraft ? 'task-detail-page-title' : 'task-board-title'" :aria-busy="loading || saving">
    <header v-if="!taskDraft" class="task-board-header">
      <div>
        <p class="eyebrow">PROJECT TASKS</p>
        <h2 id="task-board-title">{{ projectName }} · 任务看板</h2>
      </div>
      <div class="task-board-header-actions">
        <button type="button" class="secondary" :disabled="loading || saving || hasUnsavedTaskChanges" @click="openOptions"><AppIcon name="edit" />管理选项</button>
        <button type="button" :disabled="loading || saving" @click="createTask()"><AppIcon name="plus" />新建任务</button>
      </div>
    </header>
    <header v-else class="task-board-detail-header">
      <button type="button" class="secondary" :disabled="saving" @click="closeTaskDetails"><AppIcon name="chevron-left" />返回任务看板</button>
      <div>
        <p class="eyebrow">TASK DETAIL</p>
        <h2 id="task-detail-page-title" tabindex="-1">{{ taskDraft.name || (taskDraft.id ? '任务详情' : '新建任务') }}</h2>
      </div>
    </header>
    <div v-if="!taskDraft" class="task-board-toolbar">
      <label class="task-board-search-label" for="task-board-search">搜索任务</label>
      <input id="task-board-search" v-model="query" type="search" placeholder="任务名、Task ID 或负责人" :disabled="loading" />
      <span class="task-board-count">{{ taskMatches.length }} / {{ graph?.tasks.length ?? 0 }} 项</span>
    </div>
    <p v-if="!taskDraft && loading" class="task-board-state" role="status">正在读取任务…</p>
    <p v-else-if="!taskDraft && !graph?.tasks.length" class="task-board-state">还没有任务。新建任务后可按 Status 管理。</p>
    <p v-else-if="!taskDraft && !taskMatches.length" class="task-board-state">没有匹配的任务。</p>
    <div v-if="error" class="task-board-message is-error" role="alert">{{ error }}</div>
    <div v-else-if="statusMessage" class="task-board-message" role="status">{{ statusMessage }}</div>

    <div v-if="graph && !taskDraft" class="task-board-layout">
      <div class="task-board-scroll">
        <DragDropProvider @drag-start="onDragStart" @drag-over="onDragOver" @drag-end="onDragEnd">
          <div class="task-board-lanes">
            <TaskBoardLane
              v-for="lane in lanes" :key="lane.status?.id ?? 'unassigned'"
              :status="lane.status" :tasks="lane.tasks" :selected-task-id="selectedTaskId" :task-index-by-id="taskIndexById" :type-name-by-id="typeNameById"
              :priority-option-by-id="priorityOptionById" :assignee-name-by-id="assigneeNameById"
              :disabled="saving || taskDraftDirty"
              @open-task="switchTask" @add-task="createTask" @move-task="(taskId, beforeId) => persistMove(taskId, lane.status?.id ?? null, beforeId)"
            />
          </div>
        </DragDropProvider>
      </div>
    </div>

    <section v-if="graph && taskDraft" class="task-detail-view" :class="{ 'is-stale': taskDraftStale }" aria-labelledby="task-detail-page-title">
        <p v-if="taskDraftStale" class="task-board-message is-error" role="alert">任务已在其他标签页更新，请取消后重新打开。</p>
        <form class="task-detail-form" @submit.prevent="submitTask">
          <label for="task-board-name">任务名 <span>必填</span></label>
          <input id="task-board-name" v-model="taskDraft.name" required :disabled="saving || taskDraftStale" />
          <label for="task-board-external-id">Task ID <span>可选，1–16 位数字</span></label>
          <input id="task-board-external-id" v-model="taskDraft.externalTaskId" inputmode="numeric" placeholder="未设置" :disabled="saving || taskDraftStale" />
          <label for="task-board-status">Status</label>
          <select id="task-board-status" v-model="taskDraft.statusOptionId" :disabled="saving || taskDraftStale">
            <option :value="null">未分组</option>
            <option v-for="option in graph.project.statusOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
          <label for="task-board-type">Type</label>
          <select id="task-board-type" v-model="taskDraft.typeOptionId" :disabled="saving || taskDraftStale">
            <option :value="null">未设置</option>
            <option v-for="option in graph.project.typeOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
          <label for="task-board-priority">优先级</label>
          <select id="task-board-priority" v-model="taskDraft.priorityOptionId" :disabled="saving || taskDraftStale">
            <option :value="null">未设置</option>
            <option v-for="option in graph.project.priorityOptions" :key="option.id" :value="option.id" :style="{ color: option.indicatorColor }">{{ '!'.repeat(option.indicatorCount ?? 1) }} {{ option.name }}</option>
          </select>
                <label for="task-board-assignee">负责人</label>
          <select id="task-board-assignee" v-model="taskDraft.assigneeId" :disabled="saving || taskDraftStale">
            <option :value="null">未分配</option>
            <option v-for="option in graph.project.assigneeOptions" :key="option.id" :value="option.id">{{ option.name }}</option>
          </select>
          <div class="task-date-grid">
            <div>
              <label for="task-board-start">开始日期</label>
              <input id="task-board-start" v-model="startDateInput" type="date" :max="dueDateInput || undefined" :disabled="saving || taskDraftStale" />
            </div>
            <div>
              <label for="task-board-due">截止日期</label>
              <input id="task-board-due" v-model="dueDateInput" type="date" :min="startDateInput || undefined" :disabled="saving || taskDraftStale" />
            </div>
          </div>
          <label for="task-board-description">说明</label>
          <textarea id="task-board-description" v-model="taskDraft.description" rows="3" :disabled="saving || taskDraftStale"></textarea>
          <p v-if="commentDraftDirty" class="form-help">请先保存或取消未完成的评论，再保存任务字段。</p>
          <div class="task-detail-actions">
            <button type="submit" :disabled="saving || taskDraftStale || commentDraftDirty || !taskDraft.name.trim()"><AppIcon name="check" />保存任务</button>
            <button v-if="taskDraft.id" type="button" class="danger" :disabled="saving || taskDraftStale" @click="deleteCurrentTask"><AppIcon name="trash" />删除任务</button>
          </div>
        </form>

        <section v-if="taskDraft.id" class="task-related-versions" aria-labelledby="task-related-title">
          <header><h4 id="task-related-title">关联版本</h4><span>{{ graph.nodes.filter(node => node.taskId === taskDraft!.id).length }}</span></header>
          <ul v-if="graph.nodes.some(node => node.taskId === taskDraft!.id)">
            <li v-for="node in graph.nodes.filter(item => item.taskId === taskDraft!.id)" :key="node.id">
              <button type="button" class="task-version-link" @click="emit('graph', node.id)">
                <code>{{ node.version }}</code><span>{{ node.description || '（无改动说明）' }}</span><AppIcon name="arrow" />
              </button>
            </li>
          </ul>
          <p v-else class="form-help">此任务尚未关联版本。</p>
        </section>

        <section v-if="taskDraft.id" class="task-comments" aria-labelledby="task-comments-title">
          <header>
            <h4 id="task-comments-title">评论</h4>
            <button type="button" class="secondary" :disabled="saving || taskDraftStale || taskDraftDirty" @click="beginNewComment"><AppIcon name="plus" />添加评论</button>
          </header>
          <ul v-if="taskDraft.comments.length" class="task-comment-list">
            <li v-for="comment in taskDraft.comments" :key="comment.id" class="task-comment">
              <div class="task-comment-meta"><time :datetime="comment.createdAt">{{ formatTime(comment.createdAt) }}</time><span v-if="comment.updatedAt !== comment.createdAt">已编辑 {{ formatTime(comment.updatedAt) }}</span></div>
              <div class="markdown-content task-comment-content" v-html="renderMarkdown(comment.text)"></div>
              <div class="task-comment-actions">
                <button type="button" class="secondary" :disabled="saving || taskDraftStale || taskDraftDirty" @click="beginEditComment(comment)"><AppIcon name="edit" />编辑</button>
                <button type="button" class="secondary" :disabled="saving || taskDraftStale || taskDraftDirty" @click="deleteComment(comment)"><AppIcon name="trash" />删除</button>
              </div>
            </li>
          </ul>
          <p v-else class="form-help">尚无评论。</p>
          <form v-if="commentEditorOpen" class="task-comment-editor" @submit.prevent="saveComment">
            <h5>{{ editingCommentId ? '编辑评论' : '新建评论' }}</h5>
            <MarkdownEditor v-model="commentText" textarea-id="task-comment-markdown" :disabled="saving || taskDraftStale" />
            <div class="task-detail-actions">
              <button type="submit" :disabled="saving || taskDraftStale || taskDraftDirty || !commentText.trim()"><AppIcon name="check" />保存评论</button>
              <button type="button" class="secondary" :disabled="saving" @click="cancelComment">取消</button>
            </div>
          </form>
        </section>
    </section>
  </section>

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
.task-board-header, .task-board-header-actions, .task-board-toolbar, .task-board-detail-header, .task-options-heading, .task-options-footer { display: flex; align-items: center; gap: 10px; }
.task-board-header { justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
.task-board-header h2 { overflow-wrap: anywhere; }
.task-board-header-actions { flex-wrap: wrap; }
.task-board-header-actions button { min-height: 44px; }
.task-board-detail-header { align-items: flex-start; gap: 16px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid #35445c; }
.task-board-detail-header > button { flex: 0 0 auto; }
.task-board-detail-header > div { min-width: 0; }
.task-board-detail-header h2 { overflow-wrap: anywhere; }
.task-board-toolbar { min-width: 0; margin-bottom: 12px; }
.task-board-search-label { flex: 0 0 auto; margin: 0; }
.task-board-toolbar input { flex: 1; min-width: 120px; margin: 0; }
.task-board-count { color: #afbdd2; font-size: 11px; white-space: nowrap; }
.task-board-message, .task-board-state { margin: 8px 0; color: #cbd9ed; font-size: 12px; line-height: 1.6; }
.task-board-message { padding: 9px 11px; border: 1px solid #35445c; border-radius: 6px; background: #101a2a; }
.task-board-message.is-error { border-color: #9c4a55; background: #2a1820; color: #ffd1d5; }
.task-board-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
.task-board-scroll { display: block; min-width: 0; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-gutter: stable; }
.task-board-lanes { display: flex; align-items: stretch; gap: 10px; width: max-content; min-width: 100%; padding: 2px 2px 10px; }
.task-detail-view { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); grid-template-rows: auto auto; gap: 0 24px; min-width: 0; padding-top: 14px; border-top: 1px solid #35445c; }
.task-detail-view > .task-board-message { grid-column: 1 / -1; }
.task-detail-form { min-width: 0; }
.task-detail-view > .task-detail-form { grid-column: 1; grid-row: 1 / span 2; }
.task-detail-view > .task-related-versions { grid-column: 2; grid-row: 1; }
.task-detail-view > .task-comments { grid-column: 2; grid-row: 2; }
.task-detail-form input, .task-detail-form select, .task-detail-form textarea { margin-bottom: 10px; }
.task-detail-form textarea { width: 100%; min-height: 84px; resize: vertical; }
.task-date-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.task-date-grid input { padding: 9px 7px; font-size: 12px; }
.task-detail-actions { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; margin: 10px 0; }
.task-detail-actions button { min-height: 44px; }
.task-related-versions, .task-comments { margin-top: 14px; padding-top: 12px; border-top: 1px solid #35445c; }
.task-related-versions > header, .task-comments > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.task-related-versions h4, .task-comments h4 { margin: 0; color: #eef4ff; font-size: 13px; }
.task-related-versions > header > span { color: #afbdd2; font-size: 11px; }
.task-related-versions ul, .task-comment-list { display: grid; gap: 6px; list-style: none; margin: 0; padding: 0; }
.task-related-versions li, .task-comment { min-width: 0; padding: 8px; border: 1px solid #35445c; border-radius: 6px; background: #101a2a; }
.task-version-link { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) 18px; justify-content: start; width: 100%; min-width: 0; min-height: 40px; padding: 4px; border: 0; background: transparent; text-align: left; }
.task-version-link:hover { background: #17243a; }
.task-version-link code { overflow: hidden; color: #b7d8ff; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.task-version-link span { overflow: hidden; color: #c0cde0; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.task-version-link .app-icon { width: 16px; height: 16px; }
.task-comments > header button { min-height: 44px; padding: 6px 9px; font-size: 11px; }
.task-comment-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; color: #afbdd2; font-size: 10px; font-variant-numeric: tabular-nums; }
.task-comment-content { margin: 8px 0; font-size: 12px; overflow-wrap: anywhere; }
.task-comment-content :deep(img) { display: none; }
.task-comment-actions { display: flex; justify-content: flex-end; gap: 6px; }
.task-comment-actions button { min-height: 44px; padding: 5px 8px; font-size: 11px; }
.task-comment-editor { margin-top: 10px; padding-top: 10px; border-top: 1px solid #35445c; }
.task-comment-editor h5 { margin: 0 0 8px; font-size: 12px; }
.task-comment-editor :deep(.markdown-editor-toolbar) { gap: 5px; }
.task-comment-editor :deep(.markdown-editor-toolbar button) { min-width: 0; min-height: 44px; padding: 6px 10px; }
.task-comment-editor :deep(.markdown-editor textarea) { min-height: 120px; margin: 0; }
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
@media (max-width: 1100px) {
  .task-detail-view { grid-template-columns: minmax(0, 1fr); }
  .task-detail-view > .task-board-message,
  .task-detail-view > .task-detail-form,
  .task-detail-view > .task-related-versions,
  .task-detail-view > .task-comments { grid-column: 1; grid-row: auto; }
}
@media (max-width: 560px) {
  .task-board { padding: 12px; }
  .task-board-header { align-items: flex-start; }
  .task-board-detail-header { flex-direction: column; }
  .task-board-header-actions { width: 100%; }
  .task-board-header-actions button { flex: 1; }
  .task-board-toolbar { flex-wrap: wrap; }
  .task-board-search-label { width: 100%; }
  .task-board-count { margin-left: auto; }
}
</style>