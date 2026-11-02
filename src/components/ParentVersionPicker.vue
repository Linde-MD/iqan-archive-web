<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { VersionNode } from '../domain/model';

const props = defineProps<{
  options: readonly VersionNode[];
  disabled: boolean;
}>();
const emit = defineEmits<{ add: [id: string] }>();
const id = useId();
const input = ref<HTMLInputElement>();
const list = ref<HTMLUListElement>();
const query = ref('');
const selectedId = ref('');
const open = ref(false);
const activeIndex = ref(-1);
const filteredOptions = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return props.options.filter(node => `${node.version} ${node.description}`.toLocaleLowerCase().includes(search));
});
const recommendedIds = computed(() => new Set(props.options.slice(0, 5).map(node => node.id)));
const activeOptionId = computed(() => open.value && filteredOptions.value[activeIndex.value]
  ? `${id}-option-${activeIndex.value}` : undefined);

watch(filteredOptions, () => { activeIndex.value = -1; });
watch(() => props.options, options => {
  if (selectedId.value && !options.some(node => node.id === selectedId.value)) {
    selectedId.value = '';
    query.value = '';
  }
});
watch(() => props.disabled, disabled => { if (disabled) open.value = false; });

function onInput() {
  selectedId.value = '';
  open.value = true;
}

function toggle() {
  open.value = !open.value;
  input.value?.focus({ preventScroll: true });
}

function select(node: VersionNode) {
  selectedId.value = node.id;
  query.value = node.version;
  open.value = false;
  input.value?.focus({ preventScroll: true });
}

async function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    event.stopPropagation();
    open.value = false;
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    open.value = true;
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
    const node = filteredOptions.value[activeIndex.value];
    if (open.value && node) select(node);
  } else if (event.key === 'Tab') {
    open.value = false;
  }
}

function add() {
  if (props.disabled || !selectedId.value) return;
  emit('add', selectedId.value);
  selectedId.value = '';
  query.value = '';
  open.value = false;
  input.value?.focus({ preventScroll: true });
}

function onFocusOut(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !(event.currentTarget instanceof HTMLElement)
    || !event.currentTarget.contains(event.relatedTarget)) open.value = false;
}
</script>

<template>
  <div class="parent-picker" @focusout="onFocusOut">
    <label :for="`${id}-input`">添加父版本</label>
    <div class="parent-picker-row">
      <div class="parent-picker-field">
        <input
          :id="`${id}-input`" ref="input" v-model="query" role="combobox" autocomplete="off"
          aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="open"
          :aria-controls="`${id}-list`" :aria-activedescendant="activeOptionId"
          :disabled="disabled" placeholder="搜索或选择父版本…" @input="onInput" @keydown="onKeydown"
        />
        <button
          type="button" class="parent-picker-toggle" :disabled="disabled" aria-label="展开父版本候选"
          :aria-expanded="open" :aria-controls="`${id}-list`" title="选择父版本" @click="toggle"
        ><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
      </div>
      <button type="button" class="secondary parent-picker-add" :disabled="disabled || !selectedId" @click="add">添加</button>
    </div>
    <ul v-if="open" :id="`${id}-list`" ref="list" class="parent-picker-options" role="listbox" aria-label="可选父版本">
      <li
        v-for="(node, index) in filteredOptions" :id="`${id}-option-${index}`" :key="node.id"
        role="option" :aria-selected="selectedId === node.id" :class="{ active: activeIndex === index }"
        @mousedown.prevent @click="select(node)"
      >
        <span>{{ node.version }}<small v-if="recommendedIds.has(node.id)">邻近推荐</small></span>
        <span v-if="node.description" class="parent-picker-description">{{ node.description }}</span>
      </li>
      <li v-if="!filteredOptions.length" role="presentation" class="parent-picker-empty">
        {{ query.trim() ? '没有匹配的父版本' : '暂无可选父版本' }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.parent-picker { margin-bottom: 14px; min-width: 0; }
.parent-picker-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.parent-picker-field { position: relative; min-width: 0; }
.parent-picker-field input { padding-right: 44px; margin: 0; }
.parent-picker-toggle { position: absolute; top: 0; right: 0; width: 44px; height: 44px; min-height: 44px; padding: 12px; border: 0; background: transparent; color: var(--ink); }
.parent-picker-toggle:hover:not(:disabled) { background: var(--surface-raised); }
.parent-picker-toggle svg { display: block; width: 20px; height: 20px; }
.parent-picker-add { width: auto; min-height: 44px; padding: 8px 12px; }
.parent-picker-options { position: relative; max-height: 220px; overflow: auto; overscroll-behavior: contain; list-style: none; margin: 6px 0 0; padding: 4px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); }
.parent-picker-options li { min-height: 44px; padding: 10px 8px; border-radius: 4px; overflow-wrap: anywhere; cursor: pointer; }
.parent-picker-options li.active, .parent-picker-options li:hover, .parent-picker-options li[aria-selected="true"] { background: var(--surface-raised); outline: 1px solid var(--accent); outline-offset: -1px; }
.parent-picker-options li > span:first-child { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.parent-picker-options small, .parent-picker-description, .parent-picker-empty { color: var(--muted); font-size: 12px; }
.parent-picker-description { display: block; margin-top: 4px; }
.parent-picker-options .parent-picker-empty { cursor: default; outline: none; background: transparent; }
</style>
