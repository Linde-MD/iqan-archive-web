<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { checkPermission, projectDirectoryName, resolveProjectDirectory, scanDirectory, type DirectoryHandle, type DirectoryRole } from '../files/directories';
import type { FileCandidate } from '../domain/filenames';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ projectName: string; rootHandle?: DirectoryHandle | undefined; role: DirectoryRole; disabled: boolean; autoScan?: boolean }>();
const emit = defineEmits<{
  results: [files: FileCandidate[]];
  invalidate: [];
  busy: [value: boolean];
  error: [cause: unknown];
}>();
const label = props.role === 'engineering' ? '工程' : '软件对比文档';
const handle = shallowRef<DirectoryHandle>();
const permission = ref('未找到');
const busy = ref(false);
const count = ref(0);
const message = ref('');
const supported = window.isSecureContext && typeof window.showDirectoryPicker === 'function';
const expectedName = computed(() => {
  try { return projectDirectoryName(props.projectName, props.role); }
  catch { return '项目名不能用于 Windows 目录名'; }
});
let controller: AbortController | undefined;
let disposed = false;

async function operation(action: () => Promise<void>) {
  busy.value = true; emit('busy', true); message.value = '';
  try { await action(); }
  catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') message.value = '扫描已取消，未提交。';
    else emit('error', cause);
  } finally { busy.value = false; emit('busy', false); }
}

async function restore() {
  await operation(async () => {
    handle.value = undefined;
    if (disposed || !props.rootHandle) { permission.value = '未设置根目录'; return; }
    if (!await checkPermission(props.rootHandle)) { permission.value = '需要重新授权根目录'; return; }
    try {
      const child = await resolveProjectDirectory(props.rootHandle, props.projectName, props.role);
      handle.value = child;
      permission.value = await checkPermission(child) ? '可扫描' : '需要重新授权根目录';
      if (permission.value !== '可扫描') message.value = '请重新授权统一归档根目录。';
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'NotFoundError') {
        permission.value = '目录不存在';
        message.value = `未找到子目录“${expectedName.value}”。`;
      }
      else throw cause;
    }
  });
}

async function copyName() {
  await operation(async () => {
    if (!handle.value) throw new Error('请先授权归档根目录，并确认该项目子目录存在。');
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持复制，请手动选择上方目录名复制。');
    try { await navigator.clipboard.writeText(handle.value.name); }
    catch (cause) { throw new Error('复制目录名失败，请手动选择上方目录名复制。', { cause }); }
    message.value = '目录名已复制（非完整路径）。';
  });
}

async function scan() {
  emit('invalidate');
  controller = new AbortController();
  count.value = 0;
  await operation(async () => {
    if (!handle.value) throw new Error('请先授权归档根目录，并确认该项目子目录存在。');
    if (!await checkPermission(handle.value)) {
      permission.value = '需要重新授权根目录';
      throw new Error('归档根目录授权已失效，请在上方重新授权。');
    }
    permission.value = '已授权';
    const files = await scanDirectory(handle.value, props.role, controller!.signal, value => { count.value = value; });
    if (!disposed) { emit('results', files); message.value = `扫描完成：枚举 ${count.value} 个条目，找到 ${files.length} 个候选文件。`; }
  });
  controller = undefined;
}

defineExpose({ getHandle: () => handle.value });
onMounted(async () => { await restore(); if (!disposed && props.autoScan && handle.value) await scan(); });
watch(() => [props.rootHandle, props.projectName] as const, async () => {
  emit('invalidate');
  await restore();
  if (!disposed && props.autoScan && handle.value) await scan();
});
onUnmounted(() => { disposed = true; controller?.abort(); });
</script>

<template>
  <section class="directory-card" :aria-label="`${label}目录配置`">
    <div class="section-heading"><h3><AppIcon :name="role === 'engineering' ? 'folder' : 'file'" />{{ label }}目录</h3><span class="permission-badge">{{ permission }}</span></div>
    <p v-if="!supported">当前浏览器不支持目录授权，请使用安全上下文中的 Chrome 或 Edge；已有配置仍可查看。</p>
    <div class="directory-name"><div><span class="field-caption">项目子目录</span><strong>{{ handle?.name ?? expectedName }}</strong></div><button class="secondary icon-button" :disabled="disabled || busy || !handle" :aria-label="`复制${label}目录名`" :title="`复制${label}目录名`" @click="copyName"><AppIcon name="copy" /></button></div>
    <div class="actions">
      <button class="tool-button tool-button-accent" :disabled="disabled || busy || !handle" :aria-label="`扫描${label}目录`" :title="`只读扫描${label}目录`" @click="scan"><AppIcon name="scan" /><span class="tool-caption">扫描</span></button>
      <button v-if="busy && controller" class="tool-button" aria-label="取消扫描" title="取消本次扫描，不提交部分结果" @click="controller?.abort()"><AppIcon name="stop" /><span class="tool-caption">取消扫描</span></button>
    </div>
    <p role="status">{{ busy ? `处理中，已枚举 ${count} 个条目…` : message }}</p>
  </section>
</template>
