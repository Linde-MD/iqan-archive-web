<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSortable } from '@dnd-kit/vue/sortable';
import type { Task } from '../domain/model';

const props = defineProps<{
  task: Task;
  index: number;
  group: string;
  statusName: string;
  typeName: string | null;
  priorityName: string | null;
  assigneeName: string | null;
  selected: boolean;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
const emit = defineEmits<{
  open: [];
  moveUp: [];
  moveDown: [];
}>();
const card = ref<HTMLElement | null>(null);
const handle = ref<HTMLButtonElement | null>(null);
const { isDragging, isDropTarget } = useSortable({
  id: props.task.id,
  index: computed(() => props.index),
  group: computed(() => props.group),
  element: card,
  handle,
  disabled: computed(() => props.disabled),
  data: computed(() => ({ taskId: props.task.id, statusOptionId: props.task.statusOptionId })),
});
</script>

<template>
  <article ref="card" :data-task-card-id="task.id" class="task-card" :class="{ 'is-dragging': isDragging, 'is-drop-target': isDropTarget, 'is-selected': selected }">
    <div class="task-card-topline">
      <button
        ref="handle" type="button" class="task-card-drag" :disabled="disabled"
        :aria-label="`拖动任务 ${task.name}`" title="拖动排序"
      >拖动</button>
      <span class="task-card-status">{{ statusName }}</span>
      <div class="task-card-order-actions">
        <button type="button" class="secondary icon-button" :disabled="disabled || !canMoveUp" :aria-label="`上移任务 ${task.name}`" @click="emit('moveUp')">↑</button>
        <button type="button" class="secondary icon-button" :disabled="disabled || !canMoveDown" :aria-label="`下移任务 ${task.name}`" @click="emit('moveDown')">↓</button>
      </div>
    </div>
    <button type="button" class="task-card-title" :aria-current="selected ? 'true' : undefined" @click="emit('open')">
      <code v-if="task.externalTaskId" class="task-reference-id">{{ task.externalTaskId }}</code>
      <span>{{ task.name }}</span>
    </button>
    <div class="task-card-meta">
      <span v-if="typeName">{{ typeName }}</span>
      <span v-if="priorityName" class="task-priority-label">{{ priorityName }}</span>
      <span v-if="assigneeName">{{ assigneeName }}</span>
      <span v-if="task.startDate || task.dueDate" class="task-date-label">
        {{ task.startDate || '未定' }} – {{ task.dueDate || '未定' }}
      </span>
    </div>
  </article>
</template>

<style scoped>
.task-card {
  min-width: 0; padding: 10px; border: 1px solid #35445c; border-radius: 6px;
  background: #121d2e; box-shadow: 0 2px 6px #02061740;
}
.task-card:hover { border-color: #526a89; background: #17243a; }
.task-card.is-dragging { opacity: .48; }
.task-card.is-drop-target { border-color: #8bc3ff; box-shadow: 0 0 0 2px #60a5fa66; }
.task-card.is-selected { border-color: #8bc3ff; background: #1a2e47; box-shadow: inset 3px 0 #7dc0ff; }
.task-card-topline { display: flex; align-items: center; gap: 6px; min-width: 0; }
.task-card-drag { min-width: 44px; min-height: 44px; padding: 3px 7px; border: 1px solid #40516a; background: #17263a; color: #cbd9ed; font-size: 10px; }
.task-card-drag:hover:not(:disabled) { background: #203149; }
.task-card-status { min-width: 0; overflow: hidden; color: #afbdd2; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.task-card-order-actions { display: flex; gap: 2px; margin-left: auto; }
.task-card-order-actions .icon-button { min-width: 44px; width: 44px; height: 44px; min-height: 44px; font-size: 12px; }
.task-card-title { display: flex; justify-content: flex-start; width: 100%; min-width: 0; min-height: 44px; margin-top: 4px; padding: 5px 0; border: 0; background: transparent; color: #eef4ff; text-align: left; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.task-card-title:hover { background: transparent; color: #a9d0ff; }
.task-card-title > span { min-width: 0; }
.task-card-title .task-reference-id { flex: 0 0 auto; margin: 0 6px 0 0; }
.task-card-meta { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }
.task-card-meta > span { max-width: 100%; padding: 2px 6px; border: 1px solid #35445c; border-radius: 4px; color: #c1d0e4; font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
.task-card-meta > .task-priority-label { border-color: #806b42; color: #f0d293; }
.task-card-meta > .task-date-label { width: 100%; border-color: transparent; padding-left: 0; color: #afbdd2; font-variant-numeric: tabular-nums; }
</style>