<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useSortable } from '@dnd-kit/vue/sortable';
import type { TaskAssignee, TaskOption } from '../domain/model';
import type { TaskSummary } from '../domain/project-views';
import { placeContextMenu } from '../utils/viewport';
import AppIcon from './AppIcon.vue';
import TaskAssigneeAvatar from './TaskAssigneeAvatar.vue';

const props = defineProps<{
  task: TaskSummary;
  index: number;
  group: string;
  priorityName: string | null;
  priorityIndicatorCount: number | null;
  priorityIndicatorColor: string | null;
  assignee: TaskAssignee | null;
  assignees: TaskAssignee[];
  assigneesUnavailable: boolean;
  statusOptions: TaskOption[];
  typeOptions: TaskOption[];
  selected: boolean;
  disabled: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
}>();
const emit = defineEmits<{
  open: [];
  moveUp: [];
  moveDown: [];
  moveStatus: [statusId: string | null];
  changeType: [typeId: string | null];
  changeAssignee: [assigneeId: string | null];
  delete: [];
}>();
const card = ref<HTMLElement | null>(null);
const menu = ref<HTMLDivElement>();
const menuOpen = ref(false);
const { isDragging, isDropTarget } = useSortable({
  id: props.task.id,
  index: computed(() => props.index),
  group: computed(() => props.group),
  element: card,
  handle: card,
  disabled: computed(() => props.disabled),
  data: computed(() => ({ taskId: props.task.id, statusOptionId: props.task.statusOptionId })),
});

function openFromCard(event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest('button, select, [popover]')) return;
  emit('open');
}

function closeMenu() {
  menu.value?.hidePopover();
}

function onMenuScroll(event: Event) {
  if (event.target instanceof Node && menu.value?.contains(event.target)) return;
  closeMenu();
}

function onMenuToggle(event: Event) {
  const open = event instanceof ToggleEvent && event.newState === 'open';
  menuOpen.value = open;
  if (open) {
    window.addEventListener('scroll', onMenuScroll, true);
    window.addEventListener('resize', closeMenu);
  } else {
    window.removeEventListener('scroll', onMenuScroll, true);
    window.removeEventListener('resize', closeMenu);
  }
}

async function openMenu(event: MouseEvent) {
  const anchor = event.currentTarget;
  const popup = menu.value;
  if (!(anchor instanceof HTMLElement) || !popup) return;
  if (popup.matches(':popover-open')) {
    closeMenu();
    return;
  }
  popup.showPopover();
  const rect = anchor.getBoundingClientRect();
  const bounds = popup.getBoundingClientRect();
  const position = placeContextMenu({ x: rect.left, y: rect.bottom }, bounds, { width: window.innerWidth, height: window.innerHeight }, 8, 4);
  popup.style.left = `${position.x}px`;
  popup.style.top = `${position.y}px`;
  await nextTick();
  popup.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
}

function changeField(event: Event, field: 'status' | 'type' | 'assignee') {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  const value = select.value || null;
  const current = field === 'status' ? props.task.statusOptionId : field === 'type' ? props.task.typeOptionId : props.task.assigneeId;
  select.value = current ?? '';
  if (value === current) return;
  if (field === 'status') emit('moveStatus', value);
  else if (field === 'type') emit('changeType', value);
  else emit('changeAssignee', value);
  if (field !== 'assignee') closeMenu();
}

onUnmounted(() => {
  window.removeEventListener('scroll', onMenuScroll, true);
  window.removeEventListener('resize', closeMenu);
});
</script>

<template>
  <article
    ref="card" :data-task-card-id="task.id" class="task-card"
    :class="{ 'is-dragging': isDragging, 'is-drop-target': isDropTarget, 'is-selected': selected, 'has-priority': !!priorityName }"
    :style="priorityName ? { '--priority-edge-color': priorityIndicatorColor ?? '#eabf35', '--priority-edge-width': `${(priorityIndicatorCount ?? 1) + 1}px` } : undefined"
    @click="openFromCard"
  >
    <div class="task-card-topline">
      <code v-if="task.externalTaskId" class="task-reference-id">{{ task.externalTaskId }}</code>
      <span v-if="priorityName" class="task-priority-accessible-text">优先级：{{ priorityName }}</span>
      <button type="button" class="task-card-title" :title="task.name" :aria-current="selected ? 'true' : undefined" @pointerdown.stop @click="emit('open')">
        <span>{{ task.name }}</span>
      </button>
      <div class="task-card-actions">
        <button type="button" class="task-card-more" :disabled="disabled" :aria-label="`${task.name}的快捷操作`"
          :aria-expanded="menuOpen" :aria-controls="`task-card-menu-${task.id}`" @pointerdown.stop @click.stop="openMenu">
          <span aria-hidden="true">⋯</span>
        </button>
        <div class="task-card-assignee" :class="{ 'is-unavailable': !!task.assigneeId && (!assignee || assignee.disabled) }">
          <TaskAssigneeAvatar v-if="assignee" :assignee="assignee" />
          <span v-else class="task-card-avatar-empty" aria-hidden="true">{{ task.assigneeId ? '?' : '+' }}</span>
          <select :value="task.assigneeId ?? ''" :disabled="disabled || assigneesUnavailable"
            :aria-label="`${task.name}的负责人：${assignee ? `${assignee.displayName}${assignee.disabled ? '（已停用）' : ''}` : task.assigneeId ? '账号不可用' : '未分配'}，选择或清除`"
            :title="assignee ? `${assignee.displayName}${assignee.disabled ? '（已停用）' : ''}（@${assignee.username}）` : task.assigneeId ? '负责人账号不可用' : '添加负责人'"
            @pointerdown.stop @click.stop @change="changeField($event, 'assignee')">
            <option value="">未分配</option>
            <option v-if="task.assigneeId && (!assignee || assignee.disabled)" :value="task.assigneeId" disabled>{{ assignee ? `${assignee.displayName}（已停用）` : '账号不可用' }}</option>
            <option v-for="member in assignees" :key="member.id" :value="member.id">{{ member.displayName }}（@{{ member.username }}）</option>
          </select>
        </div>
      </div>
    </div>
    <div class="task-card-dates" :aria-hidden="!task.startDate && !task.dueDate ? 'true' : undefined">
      <span v-if="task.startDate" class="task-date-chip" :aria-label="`开始日期 ${task.startDate}`"><AppIcon name="calendar" /><time :datetime="task.startDate">{{ task.startDate }}</time></span>
      <span v-if="task.dueDate" class="task-date-chip" :aria-label="`截止日期 ${task.dueDate}`"><AppIcon name="check" /><time :datetime="task.dueDate">{{ task.dueDate }}</time></span>
    </div>
    <div :id="`task-card-menu-${task.id}`" ref="menu" class="task-card-menu" popover="auto" role="group" :aria-label="`${task.name}的快捷操作`" @toggle="onMenuToggle" @pointerdown.stop @click.stop>
      <label class="task-card-menu-field">
        <AppIcon name="status" /><span>移动到状态</span>
        <select :value="task.statusOptionId ?? ''" :disabled="disabled" @change="changeField($event, 'status')">
          <option value="">未分组</option>
          <option v-for="status in statusOptions" :key="status.id" :value="status.id">{{ status.name }}</option>
        </select>
      </label>
      <label class="task-card-menu-field">
        <AppIcon name="tasks" /><span>任务类型</span>
        <select :value="task.typeOptionId ?? ''" :disabled="disabled" @change="changeField($event, 'type')">
          <option value="">未设置</option>
          <option v-for="type in typeOptions" :key="type.id" :value="type.id">{{ type.name }}</option>
        </select>
      </label>
      <div class="task-card-menu-divider" aria-hidden="true"></div>
      <button type="button" :disabled="disabled || !canMoveUp" @click="closeMenu(); emit('moveUp')"><AppIcon class="task-card-arrow-up" name="arrow" />上移任务</button>
      <button type="button" :disabled="disabled || !canMoveDown" @click="closeMenu(); emit('moveDown')"><AppIcon class="task-card-arrow-down" name="arrow" />下移任务</button>
      <div class="task-card-menu-divider" aria-hidden="true"></div>
      <button type="button" class="task-card-delete" :disabled="disabled" @click="closeMenu(); emit('delete')"><AppIcon name="trash" />删除任务</button>
    </div>
  </article>
</template>

<style scoped>
.task-card {
  position: relative; min-width: 0; padding: 7px 8px; border: 1px solid #3c4d66; border-radius: 9px;
  background: #18263b; box-shadow: 0 2px 6px #02061740; cursor: pointer;
}
.task-card.has-priority::before { position: absolute; top: 0; bottom: 0; left: 0; width: var(--priority-edge-width); border-radius: 9px 0 0 9px; background: var(--priority-edge-color); content: ""; pointer-events: none; }
.task-priority-accessible-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
.task-card:hover { border-color: #526a89; background: #1d2b42; }
.task-card.is-dragging { opacity: .48; }
.task-card.is-drop-target { border-color: #8bc3ff; box-shadow: 0 0 0 2px #60a5fa66; }
.task-card.is-selected { border-color: #8bc3ff; background: #1a2e47; box-shadow: inset 3px 0 #7dc0ff; }
.task-card-topline { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; min-height: 44px; }
.task-card-topline .task-reference-id {
  flex: 0 0 auto; margin: 0 5px 0 2px; padding: 0 3px; border-color: #3b506a;
  background: #1d3048; color: #c7d7e9; font-size: 11px; font-weight: 600;
}
.task-card-actions { display: flex; align-items: center; gap: 0; margin-left: auto; }
.task-card-more { display: grid; place-items: center; width: 44px; min-width: 44px; min-height: 44px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #c1d0e4; font-size: 24px; line-height: 1; opacity: 0; }
.task-card:hover .task-card-more, .task-card:focus-within .task-card-more, .task-card-more[aria-expanded="true"] { opacity: 1; }
.task-card-more:hover { background: #2b3c56; color: #eef4ff; }
.task-card-assignee { position: relative; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 6px; }
.task-card-assignee:focus-within, .task-card-more:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
.task-card-assignee select { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.task-card-assignee select:disabled { cursor: not-allowed; }
.task-card-avatar-empty { display: grid; place-items: center; width: 26px; height: 26px; border: 1px dashed #91a5bd; border-radius: 50%; color: #c1d0e4; font-size: 17px; line-height: 1; }
.task-card-assignee.is-unavailable .task-card-avatar-empty, .task-card-assignee.is-unavailable :deep(.task-assignee-avatar) { outline: 2px solid #fca5a5; outline-offset: 2px; }
.task-card-title { display: flex; justify-content: flex-start; flex: 1 1 64px; min-width: 64px; min-height: 44px; padding: 3px 2px; border: 0; background: transparent; color: #eef4ff; text-align: left; font-size: 13px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.task-card-title span { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.task-card-title:hover { background: transparent; color: #b7d8ff; }
.task-card-dates { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 2px; }
.task-date-chip { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: 5px; background: #253650; color: #d3dfed; font-size: 11px; line-height: 17px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-date-chip .app-icon { width: 12px; height: 12px; }
.task-card-menu { position: fixed; inset: auto; margin: 0; width: min(280px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto; padding: 6px; border: 1px solid #52647e; border-radius: 10px; background: #18253a; color: #eef4ff; box-shadow: 0 12px 32px #02061799; }
.task-card-menu-field { display: flex; align-items: center; justify-content: flex-start; gap: 8px; min-width: 0; min-height: 44px; padding: 0 6px; margin: 0; border-radius: 6px; color: #eef4ff; font-size: 13px; font-weight: 500; }
.task-card-menu-field:hover, .task-card-menu-field:focus-within { background: #253650; }
.task-card-menu-field span { flex: 0 0 auto; color: inherit; font-size: inherit; font-weight: inherit; }
.task-card-menu-field select { flex: 1 1 0; width: 0; min-width: 0; min-height: 44px; margin: 0; padding: 4px 2px 4px 6px; border: 0; background: transparent; color: #d3dfed; font-size: 12px; }
.task-card-menu button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; min-height: 44px; padding: 8px 6px; border: 0; border-radius: 6px; background: transparent; color: #eef4ff; font-weight: 500; text-align: left; }
.task-card-menu button:hover:not(:disabled) { background: #253650; }
.task-card-menu button:disabled { background: transparent; color: #8290a6; }
.task-card-menu button:focus-visible, .task-card-menu select:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
.task-card-menu .app-icon { flex: 0 0 16px; width: 16px; height: 16px; color: #afbdd2; }
.task-card-menu .task-card-arrow-up { transform: rotate(-90deg); }
.task-card-menu .task-card-arrow-down { transform: rotate(90deg); }
.task-card-menu-divider { height: 1px; margin: 4px 6px; background: #35445c; }
.task-card-menu .task-card-delete, .task-card-menu .task-card-delete .app-icon { color: #fca5a5; }
.task-card-menu .task-card-delete:disabled, .task-card-menu .task-card-delete:disabled .app-icon { color: #8290a6; }
@media (hover: none), (pointer: coarse) { .task-card-more { opacity: 1; } }
</style>
