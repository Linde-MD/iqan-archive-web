<script setup lang="ts">
import { ref } from 'vue';
import { renderMarkdown } from '../utils/markdown';

defineProps<{
  modelValue: string;
  textareaId: string;
  disabled?: boolean;
  readonly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const mode = ref<'edit' | 'preview'>('edit');
</script>

<template>
  <div class="markdown-editor">
    <div class="markdown-editor-toolbar" role="group" aria-label="改动说明编辑方式">
      <button type="button" class="secondary" :aria-pressed="mode === 'edit'" :disabled="disabled" @click="mode = 'edit'">编辑</button>
      <button type="button" class="secondary" :aria-pressed="mode === 'preview'" :disabled="disabled" @click="mode = 'preview'">预览</button>
    </div>
    <textarea
      v-if="mode === 'edit'"
      :id="textareaId"
      :value="modelValue"
      :disabled="disabled"
      :readonly="readonly"
      rows="8"
      placeholder="支持换行与 Markdown 格式"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    ></textarea>
    <div v-else class="markdown-content markdown-editor-preview" role="region" aria-label="改动说明预览">
      <div v-if="modelValue.trim()" v-html="renderMarkdown(modelValue)"></div>
      <p v-else class="markdown-empty">填写改动说明后可预览。</p>
    </div>
    <p class="form-help markdown-editor-help">支持标题、粗体、列表、引用、代码、表格和换行；原始 HTML 与图片不会执行或加载。</p>
  </div>
</template>
