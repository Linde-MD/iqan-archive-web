<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDroppable } from '@dnd-kit/vue';
import type { Task, TaskOption } from '../domain/model';
import TaskBoardCard from './TaskBoardCard.vue';

const props = defineProps<{
  status: TaskOption | null;
  tasks: Task[];
  selectedTaskId: string;
  taskIndexById: ReadonlyMap<string, number>;
  typeNameById: ReadonlyMap<string, string>;
  priorityOptionById: ReadonlyMap<string, TaskOption>;
  assigneeNameById: ReadonlyMap<string, string>;
  disabled: boolean;
}>();
const emit = defineEmits<{
  openTask: [taskId: string];
  addTask: [statusOptionId: string | null];
  moveTask: [taskId: string, beforeTaskId: string | null];
}>();
const lane = ref<HTMLElement | null>(null);
const laneId = computed(() => props.status ? `lane:${props.status.id}` : 'lane:unassigned');
const { isDropTarget } = useDroppable({
  id: laneId,
  element: lane,
  data: computed(() => ({ statusOptionId: props.status?.id ?? null })),
});

function move(index: number, offset: -1 | 1) {
  const task = props.tasks[index];
  if (!task) return;
  const beforeTaskId = offset < 0
    ? props.tasks[index - 1]?.id ?? task.id
    : props.tasks[index + 2]?.id ?? null;
  if (beforeTaskId !== task.id) emit('moveTask', task.id, beforeTaskId);
}
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
      <div v-if="!tasks.length" class="task-lane-empty">
        <span>{{ isDropTarget ? '放开以移动任务' : '此泳道暂无任务' }}</span>
        <button type="button" class="secondary" :disabled="disabled" @click="emit('addTask', status?.id ?? null)">在此新建任务</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-lane {
  display: flex; flex: 0 0 280px; flex-direction: column; min-width: 260px; max-width: 320px;
  min-height: 340px; border: 1px solid #35445c; border-radius: 8px; background: #101a2a;
}
.task-lane.is-drop-target { border-color: #82bfff; box-shadow: inset 0 0 0 2px #60a5fa55; }
.task-lane-heading { position: sticky; z-index: 1; top: 0; display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 8px 10px; border-bottom: 1px solid #35445c; border-radius: 8px 8px 0 0; background: #17243a; }
.task-lane-heading h3 { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.task-lane-count { display: grid; flex: 0 0 24px; place-items: center; width: 24px; height: 24px; border: 1px solid #40516a; border-radius: 50%; color: #c1d0e4; font-size: 10px; font-variant-numeric: tabular-nums; }
.task-lane-list { display: grid; align-content: start; gap: 8px; flex: 1; min-height: 0; padding: 8px; }
.task-lane-empty { display: grid; place-items: center; align-content: center; gap: 8px; min-height: 120px; color: #afbdd2; font-size: 12px; text-align: center; }
.task-lane-empty button { min-height: 44px; }
</style>