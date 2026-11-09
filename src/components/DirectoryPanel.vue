<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { ArchiveLocation } from '../domain/model';
import { checkPermission, projectDirectoryName, resolveProjectDirectory, scanDirectory, type ArchiveRoots, type DirectoryHandle, type DirectoryRole } from '../files/directories';
import type { FileCandidate } from '../domain/filenames';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ projectName: string; archiveRoots: ArchiveRoots; role: DirectoryRole; disabled: boolean; autoScan?: boolean }>();
const emit = defineEmits<{
  results: [location: ArchiveLocation, files: FileCandidate[]];
  invalidate: [];
  busy: [value: boolean];
  error: [cause: unknown];
}>();
const label = props.role === 'engineering' ? '工程' : '软件对比文档';
const location = ref<ArchiveLocation>(props.archiveRoots.local ? 'local' : 'shared');
const handle = shallowRef<DirectoryHandle>();
const rootHandle = computed(() => props.archiveRoots[location.value]);
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
    const root = rootHandle.value;
    if (disposed || !root) { permission.value = '未设置根目录'; return; }
    if (!await checkPermission(root, false, 'readwrite')) { permission.value = '需要读写授权'; return; }
    try {
      const child = await resolveProjectDirectory(root, props.projectName, props.role);
      handle.value = child;
      permission.value = await checkPermission(child) ? '可扫描' : '需要重新授权根目录';
      if (permission.value !== '可扫描') message.value = `请重新授权${location.value === 'local' ? '本地' : '共享'}根目录。`;
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
    if (!rootHandle.value || !handle.value) throw new Error(`请先设置${location.value === 'local' ? '本地' : '共享'}根目录，并确认该项目子目录存在。`);
    if (!await checkPermission(handle.value)) {
      permission.value = '需要重新授权根目录';
      throw new Error(`${location.value === 'local' ? '本地' : '共享'}根目录授权已失效，请重新授权。`);
    }
    permission.value = '已授权';
    const files = await scanDirectory(handle.value, props.role, controller!.signal, value => { count.value = value; });
    if (!disposed) { emit('results', location.value, files); message.value = `扫描完成：${location.value === 'local' ? '本地' : '共享'}目录枚举 ${count.value} 个条目，找到 ${files.length} 个候选文件。`; }
  });
  controller = undefined;
}

async function authorizeRoot() {
  const root = rootHandle.value;
  if (!root || busy.value || props.disabled) return;
  busy.value = true;
  emit('busy', true);
  message.value = '';
  try {
    const request = root.requestPermission({ mode: 'readwrite' });
    const granted = await request === 'granted';
    if (!granted) throw new Error(`${location.value === 'local' ? '本地' : '共享'}根目录授权未获批准。`);
    await restore();
  } catch (cause) {
    emit('error', cause);
  } finally {
    busy.value = false;
    emit('busy', false);
  }
}

function selectLocation(next: ArchiveLocation) {
  if (busy.value || props.disabled || location.value === next) return;
  location.value = next;
}

defineExpose({ getHandle: () => handle.value, getLocation: () => location.value });
onMounted(async () => { await restore(); if (!disposed && props.autoScan && handle.value) await scan(); });
watch(() => [props.archiveRoots.shared, props.archiveRoots.local, props.projectName, location.value] as const, async () => {
  emit('invalidate');
  await restore();
  if (!disposed && props.autoScan && handle.value) await scan();
});
onUnmounted(() => { disposed = true; controller?.abort(); });
</script>

<template>
  <section class="directory-card" :aria-label="`${label}目录配置`">
    <div class="section-heading"><h3><AppIcon :name="role === 'engineering' ? 'folder' : 'file'" />{{ label }}目录</h3><span class="permission-badge">{{ permission }}</span></div>
    <div class="directory-control-row">
      <div class="scan-location" role="group" :aria-label="`选择扫描${label}的位置`">
        <button type="button" class="secondary" :aria-pressed="location === 'shared'" :disabled="disabled || busy" @click="selectLocation('shared')">共享</button>
        <button type="button" class="secondary" :aria-pressed="location === 'local'" :disabled="disabled || busy" @click="selectLocation('local')">本地</button>
      </div>
      <div class="directory-name"><div><span class="field-caption">{{ location === 'local' ? '本地' : '共享' }}项目子目录</span><strong>{{ handle?.name ?? expectedName }}</strong></div><button class="secondary icon-button" :disabled="disabled || busy || !handle" :aria-label="`复制${label}目录名`" :title="`复制${label}目录名`" @click="copyName"><AppIcon name="copy" /></button></div>
    </div>
    <p v-if="!supported">当前浏览器不支持目录授权，请使用安全上下文中的 Chrome 或 Edge；已有配置仍可查看。</p>
    <div class="actions">
      <button class="tool-button tool-button-accent" :disabled="disabled || busy || !rootHandle || !handle" :aria-label="`扫描${location === 'local' ? '本地' : '共享'}${label}目录`" :title="`只读扫描${location === 'local' ? '本地' : '共享'}${label}目录`" @click="scan"><AppIcon name="scan" /><span class="tool-caption">扫描</span></button>
      <button v-if="rootHandle" class="tool-button" :disabled="disabled || busy" :aria-label="`重新授权${location === 'local' ? '本地' : '共享'}根目录`" :title="`请求${location === 'local' ? '本地' : '共享'}根目录读写授权`" @click="authorizeRoot"><AppIcon name="shield" /><span class="tool-caption">授权</span></button>
      <button v-if="busy && controller" class="tool-button" aria-label="取消扫描" title="取消本次扫描，不提交部分结果" @click="controller?.abort()"><AppIcon name="stop" /><span class="tool-caption">取消扫描</span></button>
    </div>
    <p role="status">{{ busy ? `处理中，已枚举 ${count} 个条目…` : message }}</p>
  </section>
</template>
