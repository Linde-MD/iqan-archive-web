<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useDroppable } from '@dnd-kit/vue';
import type { Task, TaskOption } from '../domain/model';
import TaskBoardCard from './TaskBoardCard.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  status: TaskOption | null;
  tasks: Task[];
  selectedTaskId: string;
  taskIndexById: ReadonlyMap<string, number>;
  typeNameById: ReadonlyMap<string, string>;
  priorityOptionById: ReadonlyMap<string, TaskOption>;
  assigneeNameById: ReadonlyMap<string, string>;
  disabled: boolean;
  saving: boolean;
  quickTask: { statusId: string | null; name: string; revision: number } | null;
  quickError: string;
  quickStale: boolean;
}>();
const emit = defineEmits<{
  openTask: [taskId: string];
  addTask: [statusOptionId: string | null];
  submitQuick: [];
  cancelQuick: [];
  refreshQuick: [];
  moveTask: [taskId: string, beforeTaskId: string | null];
}>();
const lane = ref<HTMLElement | null>(null);
const quickName = ref<HTMLTextAreaElement | null>(null);
const addButton = ref<HTMLButtonElement | null>(null);
watch(() => props.quickTask, async (draft, previous) => {
  await nextTick();
  if (draft) quickName.value?.focus();
  else if (previous && !props.disabled) addButton.value?.focus({ preventScroll: true });
});
const laneId = computed(() => props.status ? `lane:${props.status.id}` : 'lane:unassigned');
const { isDropTarget } = useDroppable({
  id: laneId,
  element: lane,
  data: computed(() => ({ statusOptionId: props.status?.id ?? null })),
});
let pendingMovePositions: Map<string, number> | undefined;
let pendingMoveTimeout: number | undefined;

watch(() => props.tasks.map(task => task.id), (next, previous) => {
  if (!pendingMovePositions || next.every((taskId, index) => taskId === previous[index])) return;
  const previousPositions = pendingMovePositions;
  pendingMovePositions = undefined;
  if (pendingMoveTimeout !== undefined) window.clearTimeout(pendingMoveTimeout);
  pendingMoveTimeout = undefined;
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 240;
  for (const card of lane.value?.querySelectorAll<HTMLElement>('[data-task-card-id]') ?? []) {
    const taskId = card.dataset.taskCardId;
    const previousTop = taskId ? previousPositions.get(taskId) : undefined;
    if (previousTop === undefined) continue;
    const offset = previousTop - card.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    card.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
      { duration, easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)' },
    );
  }
}, { flush: 'post' });

function move(index: number, offset: -1 | 1) {
  const task = props.tasks[index];
  if (!task) return;
  const beforeTaskId = offset < 0
    ? props.tasks[index - 1]?.id ?? task.id
    : props.tasks[index + 2]?.id ?? null;
  if (beforeTaskId === task.id) return;
  pendingMovePositions = new Map(
    [...(lane.value?.querySelectorAll<HTMLElement>('[data-task-card-id]') ?? [])]
      .flatMap(card => card.dataset.taskCardId
        ? [[card.dataset.taskCardId, card.getBoundingClientRect().top] as const]
        : []),
  );
  if (pendingMoveTimeout !== undefined) window.clearTimeout(pendingMoveTimeout);
  pendingMoveTimeout = window.setTimeout(() => {
    pendingMovePositions = undefined;
    pendingMoveTimeout = undefined;
  }, 5_000);
  emit('moveTask', task.id, beforeTaskId);
}

onUnmounted(() => {
  if (pendingMoveTimeout !== undefined) window.clearTimeout(pendingMoveTimeout);
});
</script>

<template>
  <section
    ref="lane" class="task-lane" :class="{ 'is-drop-target': isDropTarget }"
    :data-status-option-id="status?.id ?? ''"
    :aria-label="`${status?.name ?? '未分组'}，${tasks.length} 个任务`"
  >
    <header class="task-lane-heading">
      <h3>{{ status?.name ?? '未分组' }}</h3>
      <span class="task-lane-count">{{ tasks.length }}</span>
    </header>
    <div class="task-lane-list">
      <TaskBoardCard
        v-for="(task, index) in tasks" :key="task.id" :task="task" :index="taskIndexById.get(task.id) ?? index"
        group="task-board" :status-name="status?.name ?? '未分组'"
        :type-name="task.typeOptionId ? typeNameById.get(task.typeOptionId) ?? null : null"
        :priority-name="task.priorityOptionId ? priorityOptionById.get(task.priorityOptionId)?.name ?? null : null"
        :priority-indicator-count="task.priorityOptionId ? priorityOptionById.get(task.priorityOptionId)?.indicatorCount ?? null : null"
        :priority-indicator-color="task.priorityOptionId ? priorityOptionById.get(task.priorityOptionId)?.indicatorColor ?? null : null"
        :assignee-name="task.assigneeId ? assigneeNameById.get(task.assigneeId) ?? null : null"
        :selected="selectedTaskId === task.id"
        :disabled="disabled" :can-move-up="index > 0" :can-move-down="index < tasks.length - 1"
        @open="emit('openTask', task.id)"
        @move-up="move(index, -1)" @move-down="move(index, 1)"
      />
      <div v-if="!tasks.length" key="empty" class="task-lane-empty">
        <span>{{ isDropTarget ? '放开以移动任务' : '此泳道暂无任务' }}</span>
      </div>
    </div>
    <div class="task-lane-footer">
      <form v-if="quickTask" class="task-quick-form" @submit.prevent="emit('submitQuick')">
        <label class="task-quick-name"><span class="visually-hidden">任务名称</span>
          <textarea ref="quickName" v-model="quickTask.name" rows="2" placeholder="输入任务名称" :disabled="saving" :aria-describedby="quickError || quickStale ? 'quick-task-error' : undefined" @keydown.esc.stop.prevent="emit('cancelQuick')" />
        </label>
        <p v-if="quickError || quickStale" id="quick-task-error" class="task-quick-error" role="alert">{{ quickError || '项目已在其他标签页更新，请先重新读取项目。' }}</p>
        <div class="task-quick-actions">
          <button v-if="quickStale" type="button" class="quick-primary" :disabled="saving" @click="emit('refreshQuick')"><span>重新读取</span></button>
          <button v-else type="submit" class="quick-primary" :disabled="saving"><span>{{ saving ? '保存中…' : '确定' }}</span></button>
          <button type="button" class="quick-cancel" :disabled="saving" @click="emit('cancelQuick')"><span>取消</span></button>
        </div>
      </form>
      <button v-else ref="addButton" type="button" class="task-lane-add" :disabled="disabled" :aria-label="`在${status?.name ?? '未分组'}泳道添加新任务`" @click="emit('addTask', status?.id ?? null)"><AppIcon name="plus" />添加新任务</button>
    </div>
  </section>
</template>

<style scoped>
.task-lane {
  display: flex; flex: 0 0 280px; flex-direction: column; min-width: 260px; max-width: 320px;
  min-height: 0; height: 100%; border: 1px solid #35445c; border-radius: 8px; background: #101a2a;
}
.task-lane.is-drop-target { border-color: #82bfff; box-shadow: inset 0 0 0 2px #60a5fa55; }
.task-lane-heading { display: flex; flex: 0 0 48px; align-items: center; gap: 8px; min-height: 48px; padding: 8px 10px; border-bottom: 1px solid #35445c; border-radius: 8px 8px 0 0; background: #17243a; }
.task-lane-heading h3 { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.task-lane-count { display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; border: 1px solid #40516a; border-radius: 50%; color: #c1d0e4; font-size: 10px; font-variant-numeric: tabular-nums; }
.task-lane-list { display: grid; align-content: start; gap: 8px; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-gutter: stable; padding: 8px; }
.task-lane-footer { flex: 0 0 auto; max-height: calc(100% - 48px); overflow-y: auto; padding: 8px; border-top: 1px solid #35445c; background: #101a2a; border-radius: 0 0 8px 8px; }
.task-lane-empty { display: grid; place-items: center; min-height: 64px; color: #afbdd2; font-size: 12px; text-align: center; }
.task-lane-add { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #c1d0e4; font-size: 13px; font-weight: 500; text-align: left; }
.task-lane-add:hover:not(:disabled) { background: #1d2b42; border-color: #40516a; color: #eef4ff; }
.task-lane-add:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
.task-lane-add:disabled { opacity: .5; cursor: not-allowed; }
.task-lane-add .app-icon { width: 16px; height: 16px; }
.task-quick-form { display: grid; gap: 6px; padding: 8px; border: 1px solid #52647e; border-radius: 6px; background: #18253a; }
.task-quick-form label { margin: 0; color: #d3dfed; font-size: 12px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.task-quick-form textarea { width: 100%; min-width: 0; margin: 0; padding: 8px; border: 1px solid #52647e; border-radius: 4px; background: #0e1828; color: #eef4ff; font: inherit; }
.task-quick-form textarea { min-height: 64px; resize: vertical; }
.task-quick-form textarea:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 1px; }
.task-quick-error { margin: 0; font-size: 12px; line-height: 1.5; color: #ffd1d5; }
.task-quick-actions { display: flex; align-items: center; }
.task-quick-actions button { width: auto; min-width: 44px; min-height: 44px; padding: 0; border: 0; background: transparent; font-size: 12px; }
.task-quick-actions button span { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 0 12px; border-radius: 4px; }
.task-quick-actions .quick-primary span { background: #1d4ed8; color: #fff; }
.task-quick-actions .quick-primary:hover:not(:disabled) span { background: #2563eb; }
.task-quick-actions .quick-cancel span { color: #c1d0e4; }
.task-quick-actions .quick-cancel:hover:not(:disabled) span { background: #253650; color: #eef4ff; }
.task-quick-actions button:disabled span { background: #263248; color: #a7b3c5; }
.task-quick-actions button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
</style>