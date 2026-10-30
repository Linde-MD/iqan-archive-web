<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import { checkPermission, chooseDirectory, scanDirectory, type DirectoryHandle, type DirectoryRole } from '../files/directories';
import type { FileCandidate } from '../domain/filenames';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string; role: DirectoryRole; disabled: boolean }>();
const emit = defineEmits<{
  results: [files: FileCandidate[]];
  invalidate: [];
  busy: [value: boolean];
  error: [cause: unknown];
}>();
const label = props.role === 'engineering' ? '工程' : '软件对比文档';
const handle = shallowRef<DirectoryHandle>();
const permission = ref('未绑定');
const busy = ref(false);
const count = ref(0);
const message = ref('');
const supported = window.isSecureContext && typeof window.showDirectoryPicker === 'function';
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
    const binding = await props.repository.db.directoryBindings.get([props.projectId, props.role]);
    if (disposed || !binding) return;
    handle.value = binding.handle;
    permission.value = await checkPermission(binding.handle) ? '已授权' : '需要重新授权';
  });
}

async function choose() {
  await operation(async () => {
    const next = await chooseDirectory();
    if (!next) { message.value = '已取消选择，原绑定未改变。'; return; }
    if (!await checkPermission(next)) throw new Error('选择的目录未获读取授权，原绑定未改变。');
    await props.repository.bind(props.projectId, props.role, next);
    handle.value = next; permission.value = '已授权'; emit('invalidate');
    message.value = '目录已在本机绑定。请确认目录与当前项目对应后扫描。';
  });
}

async function authorize() {
  await operation(async () => {
    if (!handle.value) throw new Error('请先选择目录。');
    const granted = await checkPermission(handle.value, true);
    permission.value = granted ? '已授权' : '需要重新授权';
    if (!granted) throw new Error('目录读取权限被拒绝，请重新授权或选择目录。');
  });
}

async function copyName() {
  await operation(async () => {
    if (!handle.value) throw new Error('请先绑定目录。');
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
    if (!handle.value) throw new Error('请先选择目录。');
    if (!await checkPermission(handle.value)) {
      permission.value = '需要重新授权';
      throw new Error('目录权限已失效，请点击重新授权。');
    }
    permission.value = '已授权';
    const files = await scanDirectory(handle.value, props.role, controller!.signal, value => { count.value = value; });
    if (!disposed) { emit('results', files); message.value = `扫描完成：枚举 ${count.value} 个条目，找到 ${files.length} 个候选文件。`; }
  });
  controller = undefined;
}

async function unbind() {
  await operation(async () => {
    await props.repository.db.directoryBindings.delete([props.projectId, props.role]);
    handle.value = undefined; permission.value = '未绑定'; emit('invalidate');
    message.value = '仅解除本机授权绑定，原文件与版本图均未删除。';
  });
}

defineExpose({ getHandle: () => handle.value });
onMounted(restore);
onUnmounted(() => { disposed = true; controller?.abort(); });
</script>

<template>
  <section class="directory-card" :aria-label="`${label}目录配置`">
    <div class="section-heading"><h3><AppIcon :name="role === 'engineering' ? 'folder' : 'file'" />{{ label }}目录</h3><span class="permission-badge">{{ permission }}</span></div>
    <p v-if="!supported">当前浏览器不支持目录授权，请使用安全上下文中的 Chrome 或 Edge；已有配置仍可查看。</p>
    <div class="directory-name"><div><span class="field-caption">已绑定目录</span><strong>{{ handle?.name ?? '未绑定目录' }}</strong></div><button class="secondary icon-button" :disabled="disabled || busy || !handle" :aria-label="`复制${label}目录名`" :title="`复制${label}目录名`" @click="copyName"><AppIcon name="copy" /></button></div>
    <p class="form-help">仅目录名，非完整路径 · 绑定自动保存，刷新复查权限。</p>
    <div class="actions">
      <button class="secondary icon-button" :disabled="disabled || busy" :aria-label="`选择${label}目录`" :title="`选择${label}目录`" @click="choose"><AppIcon name="folder" /></button>
      <button class="secondary icon-button" :disabled="disabled || busy || !handle" :aria-label="`重新授权${label}目录`" :title="`重新授权${label}目录`" @click="authorize"><AppIcon name="shield" /></button>
      <button :disabled="disabled || busy || !handle" :aria-label="`扫描${label}目录`" @click="scan"><AppIcon name="scan" />扫描</button>
      <button class="secondary icon-button" :disabled="disabled || busy || !handle" :aria-label="`解除${label}绑定`" :title="`解除${label}绑定`" @click="unbind"><AppIcon name="unlink" /></button>
      <button v-if="busy && controller" class="secondary" @click="controller?.abort()"><AppIcon name="stop" />取消扫描</button>
    </div>
    <p role="status">{{ busy ? `处理中，已枚举 ${count} 个条目…` : message }}</p>
  </section>
</template>
