<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { Task } from '../domain/model';
import { sortTasksByExternalId } from '../domain/task-view';

const props = defineProps<{
  tasks: readonly Task[];
  disabled: boolean;
}>();
const selectedId = defineModel<string>({ default: '' });
const id = useId();
const input = ref<HTMLInputElement>();
const list = ref<HTMLUListElement>();
const query = ref('');
const open = ref(false);
const activeIndex = ref(-1);

const sortedTasks = computed(() => sortTasksByExternalId(props.tasks));
const options = computed(() => [
  { id: '', label: '未关联任务' },
  ...sortedTasks.value.map(task => ({
    id: task.id,
    label: `${task.externalTaskId ? `${task.externalTaskId} · ` : ''}${task.name}`,
  })),
]);
const filteredOptions = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return search ? options.value.filter(option => option.label.toLocaleLowerCase().includes(search)) : options.value;
});
const selectedLabel = computed(() => options.value.find(option => option.id === selectedId.value)?.label ?? '未关联任务');
const activeOptionId = computed(() => open.value && filteredOptions.value[activeIndex.value]
  ? `${id}-option-${activeIndex.value}` : undefined);

watch(filteredOptions, () => { activeIndex.value = -1; });
watch(() => props.disabled, disabled => { if (disabled) close(); });

function openPicker() {
  if (props.disabled) return;
  query.value = '';
  activeIndex.value = -1;
  open.value = true;
}

function close() {
  open.value = false;
  query.value = '';
  activeIndex.value = -1;
}

function onInput(event: Event) {
  query.value = (event.currentTarget as HTMLInputElement).value;
  open.value = true;
}

function selectOption(option: (typeof options.value)[number]) {
  selectedId.value = option.id;
  close();
  input.value?.focus({ preventScroll: true });
}

async function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open.value) openPicker();
    const count = filteredOptions.value.length;
    activeIndex.value = count
      ? (activeIndex.value < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1)
        : (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
      : -1;
    await nextTick();
    const option = list.value?.children[activeIndex.value];
    if (option instanceof HTMLElement && list.value) {
      if (option.offsetTop < list.value.scrollTop) list.value.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > list.value.scrollTop + list.value.clientHeight) {
        list.value.scrollTop = option.offsetTop + option.offsetHeight - list.value.clientHeight;
      }
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (!open.value) openPicker();
    else {
      const option = filteredOptions.value[activeIndex.value < 0 ? 0 : activeIndex.value];
      if (option) selectOption(option);
    }
  } else if (event.key === 'Tab') {
    close();
  }
}

function onFocusOut(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !(event.currentTarget instanceof HTMLElement)
    || !event.currentTarget.contains(event.relatedTarget)) close();
}
</script>

<template>
  <div class="task-picker" @focusout="onFocusOut">
    <label :for="`${id}-input`">所属任务</label>
    <input
      :id="`${id}-input`" ref="input" type="search" role="combobox" autocomplete="off"
      aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="open"
      :aria-controls="`${id}-list`" :aria-activedescendant="activeOptionId"
      :value="open ? query : selectedLabel" :disabled="disabled" placeholder="搜索任务 ID 或名称…"
      @focus="openPicker" @input="onInput" @keydown="onKeydown"
    />
    <ul v-if="open" :id="`${id}-list`" ref="list" class="task-picker-options" role="listbox" aria-label="所属任务候选">
      <li
        v-for="(option, index) in filteredOptions" :id="`${id}-option-${index}`" :key="option.id || 'unassigned'"
        role="option" :aria-selected="selectedId === option.id" :class="{ active: activeIndex === index }"
        @mousedown.prevent @click="selectOption(option)"
      >{{ option.label }}</li>
      <li v-if="!filteredOptions.length" role="presentation" class="task-picker-empty">
        没有匹配的任务
      </li>
    </ul>
  </div>
</template>

<style scoped>
.task-picker { min-width: 0; }
.task-picker-options {
  position: relative; max-height: 220px; overflow: auto; overscroll-behavior: contain;
  list-style: none; margin: 6px 0 0; padding: 4px; border: 1px solid var(--border-strong);
  border-radius: 8px; background: var(--surface);
}
.task-picker-options li {
  min-height: 44px; padding: 10px 8px; border-radius: 4px; overflow-wrap: anywhere; cursor: pointer;
}
.task-picker-options li.active, .task-picker-options li:hover, .task-picker-options li[aria-selected="true"] {
  background: var(--surface-raised); outline: 1px solid var(--accent); outline-offset: -1px;
}
.task-picker-options .task-picker-empty { color: var(--muted); cursor: default; outline: none; background: transparent; }
</style>