<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectGraph } from '../domain/model';
import type { TaskListRow } from '../domain/task-board';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  graph: ProjectGraph;
  rows: TaskListRow[];
  nested: boolean;
  selectedTaskId: string;
  disabled: boolean;
}>();
const emit = defineEmits<{ open: [id: string]; toggle: [id: string] }>();
const tasksById = computed(() => new Map(props.graph.tasks.map(task => [task.id, task])));
const statuses = computed(() => new Map(props.graph.project.statusOptions.map(option => [option.id, option.name])));
const types = computed(() => new Map(props.graph.project.typeOptions.map(option => [option.id, option.name])));
const assignees = computed(() => new Map(props.graph.project.assigneeOptions.map(option => [option.id, option.name])));
const priorities = computed(() => new Map(props.graph.project.priorityOptions.map(option => [option.id, option])));
const idColumnWidth = computed(() => {
  const digits = props.graph.tasks.reduce((max, task) => Math.max(max, task.externalTaskId?.length ?? 0), 6);
  return `calc(${digits}ch + 38px)`;
});
</script>

<template>
  <div class="task-list-scroll" tabindex="0" role="region" aria-label="工作项列表，可左右滚动">
    <table class="task-list" :style="{ '--task-id-column-width': idColumnWidth }">
      <caption class="visually-hidden">工作项列表，按编号从大到小排序</caption>
      <colgroup>
        <col class="column-id" /><col class="column-title" /><col class="column-status" />
        <col class="column-assignee" /><col class="column-parent" /><col class="column-type" />
        <col class="column-priority" /><col class="column-date" /><col class="column-date" />
      </colgroup>
      <thead><tr><th scope="col">编号</th><th scope="col">标题</th><th scope="col">状态</th><th scope="col">负责人</th><th scope="col">父任务</th><th scope="col">类型</th><th scope="col">优先级</th><th scope="col">开始日期</th><th scope="col">截止日期</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.task.id" :class="{ 'is-selected': selectedTaskId === row.task.id, 'is-context': !row.matches }" :data-task-list-id="row.task.id">
          <td><code v-if="row.task.externalTaskId" class="task-reference-id">{{ row.task.externalTaskId }}</code><span v-else class="muted">—</span></td>
          <td>
            <div class="task-list-name" :style="{ paddingLeft: `${Math.min(row.depth, 12) * 20}px` }">
              <button v-if="nested && row.hasChildren" type="button" class="task-list-expand" :aria-label="`${row.expanded ? '折叠' : '展开'} ${row.task.name} 的子任务`" :aria-expanded="row.expanded" @click="emit('toggle', row.task.id)">
                <AppIcon name="chevron-right" :class="{ 'is-expanded': row.expanded }" />
              </button>
              <span v-else-if="nested" class="task-list-expand-spacer" aria-hidden="true"></span>
              <button type="button" class="task-list-title" :disabled="disabled" :aria-current="selectedTaskId === row.task.id ? 'true' : undefined" @click="emit('open', row.task.id)">
                <span v-if="nested" class="visually-hidden">第 {{ row.depth + 1 }} 级，</span>{{ row.task.name }}
              </button>
              <span v-if="!row.matches" class="task-list-context">上级</span>
            </div>
          </td>
          <td><span class="task-list-status">{{ row.task.statusOptionId ? statuses.get(row.task.statusOptionId) : '未分组' }}</span></td>
          <td>{{ row.task.assigneeId ? assignees.get(row.task.assigneeId) : '—' }}</td>
          <td><template v-if="row.task.parentTaskId && tasksById.has(row.task.parentTaskId)"><code v-if="tasksById.get(row.task.parentTaskId)?.externalTaskId" class="task-reference-id">{{ tasksById.get(row.task.parentTaskId)?.externalTaskId }}</code> {{ tasksById.get(row.task.parentTaskId)?.name }}</template><span v-else class="muted">—</span></td>
          <td>{{ row.task.typeOptionId ? types.get(row.task.typeOptionId) : '—' }}</td>
          <td><template v-if="row.task.priorityOptionId && priorities.has(row.task.priorityOptionId)"><span class="task-list-priority" :style="{ color: priorities.get(row.task.priorityOptionId)?.indicatorColor }" aria-hidden="true">{{ '!'.repeat(priorities.get(row.task.priorityOptionId)?.indicatorCount ?? 1) }}</span><span class="visually-hidden">{{ '!'.repeat(priorities.get(row.task.priorityOptionId)?.indicatorCount ?? 1) }} </span>{{ priorities.get(row.task.priorityOptionId)?.name }}</template><span v-else class="muted">—</span></td>
          <td>{{ row.task.startDate ?? '—' }}</td><td>{{ row.task.dueDate ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.task-list-scroll { min-width: 0; max-height: clamp(320px, calc(100dvh - 260px), 680px); overflow: auto; border: 1px solid #35445c; border-radius: 6px; background: #101a2a; }
.task-list { width: 100%; min-width: calc(1490px + var(--task-id-column-width)); table-layout: fixed; border-collapse: collapse; text-align: left; font-size: 13px; }
.column-id { width: var(--task-id-column-width); }
.column-title { width: 340px; }
.column-status { width: 130px; }
.column-assignee { width: 130px; }
.column-parent { width: 230px; }
.column-type { width: 200px; }
.column-priority { width: 130px; }
.column-date { width: 165px; }
.task-list th { position: sticky; top: 0; z-index: 1; padding: 12px; background: #18253a; color: #c1d0e4; font-weight: 600; white-space: nowrap; }
.task-list td { position: relative; padding: 5px 12px; border-top: 1px solid #35445c; vertical-align: middle; overflow-wrap: anywhere; }
.task-list .task-reference-id { display: inline-block; white-space: nowrap; }
.task-list td:nth-child(8), .task-list td:nth-child(9) { white-space: nowrap; }
.task-list tr:hover td { background: #17243a; }
.task-list tr.is-selected td { background: #1a2e47; }
.task-list-name { display: flex; align-items: center; min-width: 0; }
.task-list-expand, .task-list-title { min-height: 44px; border: 0; background: transparent; color: #eef4ff; }
.task-list-expand { flex: 0 0 44px; width: 44px; padding: 0; color: #afbdd2; }
.task-list-expand:hover, .task-list-title:hover { background: #253650; color: #b7d8ff; }
.task-list-expand .app-icon { width: 17px; height: 17px; }
.task-list-expand .is-expanded { transform: rotate(90deg); }
.task-list-expand-spacer { flex: 0 0 44px; }
.task-list-title { justify-content: flex-start; min-width: 0; padding: 6px; text-align: left; overflow-wrap: anywhere; }
.task-list-title:disabled { background: transparent; color: #8290a6; }
.task-list-context { padding: 2px 6px; color: #afbdd2; font-size: 11px; white-space: nowrap; }
.task-list-status { display: inline-block; padding: 4px 8px; border: 1px solid #52647e; border-radius: 4px; background: #1d2b42; }
.task-list-priority { margin-right: 5px; font-weight: 700; }
.muted { color: #afbdd2; }
</style>
