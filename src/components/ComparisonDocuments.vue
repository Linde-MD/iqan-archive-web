<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import type { FileCandidate } from '../domain/filenames';
import { buildDocumentOpenUri } from '../domain/iqan-protocol';
import { checkPermission, fileOperationErrorMessage, locateFile, type DirectoryHandle } from '../files/directories';
import DirectoryPanel from './DirectoryPanel.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string }>();
const emit = defineEmits<{ busy: [value: boolean]; graph: [] }>();
const directory = ref<InstanceType<typeof DirectoryPanel>>();
const files = shallowRef<FileCandidate[]>([]);
const scannedRoot = shallowRef<DirectoryHandle>();
const scanned = ref(false);
const query = ref('');
const scanning = ref(false);
const opening = ref(false);
const error = ref('');
const status = ref('');
const menu = ref<{ file: FileCandidate; x: number; y: number }>();
const menuElement = ref<HTMLElement>();
let returnFocus: HTMLElement | undefined;
let disposed = false;
const busy = computed(() => scanning.value || opening.value);
const visibleFiles = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return files.value.filter(file => file.relativePath.toLocaleLowerCase().includes(search));
});

function receiveFiles(value: FileCandidate[]) {
  files.value = value;
  scannedRoot.value = directory.value?.getHandle();
  scanned.value = true;
}
function invalidate() {
  files.value = [];
  scanned.value = false;
  scannedRoot.value = undefined;
  closeMenu(false);
  status.value = '';
  error.value = '';
}
function scanningChanged(value: boolean) {
  scanning.value = value;
  emit('busy', busy.value);
}
function closeMenu(restoreFocus = true) {
  menu.value = undefined;
  const target = returnFocus;
  returnFocus = undefined;
  if (restoreFocus) target?.focus({ preventScroll: true });
}
function outsideMenu(event: PointerEvent) {
  if (menu.value && !event.composedPath().includes(menuElement.value as EventTarget)) closeMenu(false);
}
async function showMenu(event: MouseEvent | KeyboardEvent, file: FileCandidate) {
  event.preventDefault();
  if (busy.value) return;
  returnFocus = event.currentTarget as HTMLElement;
  const bounds = returnFocus.getBoundingClientRect();
  const pointer = event instanceof MouseEvent && event.button === 2;
  menu.value = {
    file,
    x: Math.max(8, Math.min(pointer ? event.clientX : bounds.left, window.innerWidth - 250)),
    y: Math.max(8, Math.min(pointer ? event.clientY : bounds.bottom, window.innerHeight - 80)),
  };
  await nextTick();
  menuElement.value?.querySelector<HTMLButtonElement>('button')?.focus();
}
async function sameDirectory(handle: DirectoryHandle): Promise<boolean> {
  const root = scannedRoot.value;
  return !!root && (handle.isSameEntry ? await handle.isSameEntry(root) : handle === root);
}
function onRowKeyDown(event: KeyboardEvent, file: FileCandidate) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) void showMenu(event, file);
  else if (event.key === 'Enter' && event.target === event.currentTarget) {
    event.preventDefault();
    void openDocument(file);
  }
}
async function openDocument(file: FileCandidate) {
  if (busy.value) return;
  closeMenu(false);
  opening.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '正在检查文档…';
  try {
    await props.repository.get(props.projectId);
    const binding = await props.repository.db.directoryBindings.get([props.projectId, 'word']);
    if (!binding || !await sameDirectory(binding.handle)) throw new Error('文档目录绑定已改变，请重新扫描后再打开。');
    if (!await checkPermission(binding.handle)) throw new Error('文档目录未授权，请重新授权后再打开。');
    await locateFile(binding.handle, file.relativePath);
    const latest = await props.repository.db.directoryBindings.get([props.projectId, 'word']);
    if (!latest || !await sameDirectory(latest.handle)) throw new Error('文件检查期间目录绑定已改变，请重新扫描。');
    if (!await checkPermission(latest.handle)) throw new Error('文档目录授权已失效，请重新授权。');
    const uri = buildDocumentOpenUri(props.projectId, binding.handle.name, file.relativePath);
    if (disposed) return;
    window.location.assign(uri);
    status.value = '已请求本地启动器，请查看系统提示。网页无法确认 Word 是否已打开文档。';
  } catch (cause) {
    if (!disposed) { error.value = fileOperationErrorMessage(cause); status.value = ''; }
  } finally {
    opening.value = false;
    if (!disposed) emit('busy', busy.value);
  }
}
onMounted(() => window.addEventListener('pointerdown', outsideMenu, true));
onUnmounted(() => { disposed = true; window.removeEventListener('pointerdown', outsideMenu, true); });
</script>

<template>
  <section class="panel document-workspace" aria-labelledby="document-title" :aria-busy="busy">
    <div class="section-heading">
      <div><p class="eyebrow">COMPARISON DOCUMENTS</p><h2 id="document-title">软件对比文档</h2></div>
      <button class="secondary" :disabled="busy" @click="emit('graph')"><AppIcon name="branch" />版本图</button>
    </div>
    <DirectoryPanel ref="directory" :repository="repository" :project-id="projectId" role="word" :disabled="opening" auto-scan
      @results="receiveFiles" @invalidate="invalidate" @busy="scanningChanged" @error="error = fileOperationErrorMessage($event)" />
    <div class="document-filters">
      <label for="document-search">搜索文档</label>
      <input id="document-search" v-model="query" type="search" placeholder="文件名或相对路径" />
      <span>{{ visibleFiles.length }} / {{ files.length }} 份文档</span>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="!scanned" class="form-help">{{ scanning ? '正在扫描软件对比文档…' : '请选择并扫描软件对比文档目录。' }}</p>
    <p v-else-if="!visibleFiles.length" class="form-help">{{ files.length ? '没有匹配的文档。' : '目录中没有 .doc/.docx 软件对比文档。' }}</p>
    <ul v-else class="document-list" aria-label="软件对比文档列表">
      <li v-for="file in visibleFiles" :key="file.relativePath" tabindex="0" :aria-label="file.relativePath"
        @contextmenu="showMenu($event, file)" @keydown="onRowKeyDown($event, file)">
        <AppIcon name="file" />
        <div class="document-file"><strong>{{ file.fileName }}</strong><span>{{ file.relativePath }}</span></div>
        <button class="secondary" :disabled="busy" :aria-label="`在 Word 中打开 ${file.relativePath}`" @click="openDocument(file)"><AppIcon name="arrow" />打开</button>
      </li>
    </ul>
    <div v-if="menu" ref="menuElement" class="document-menu" role="menu" aria-label="文档操作"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @keydown.escape.prevent.stop="closeMenu()">
      <button role="menuitem" :disabled="busy" @click="openDocument(menu.file)"><AppIcon name="arrow" />在 Word 中打开</button>
    </div>
  </section>
</template>

<style scoped>
.document-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
.document-filters input { flex: 1 1 240px; min-width: 0; }
.document-filters label { margin: 0; }
.document-filters span { color: var(--muted); font-variant-numeric: tabular-nums; }
.document-list { list-style: none; padding: 0; margin: 0; }
.document-list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 16px 4px; border-bottom: 1px solid var(--border); }
.document-file { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.document-file span { color: var(--muted); font-family: var(--font-mono, monospace); font-size: 13px; }
.document-menu { position: fixed; z-index: 100; width: 240px; padding: 6px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); box-shadow: 0 12px 32px #0006; }
.document-menu button { width: 100%; justify-content: flex-start; }
@media (max-width: 540px) { .document-list li { grid-template-columns: 20px minmax(0, 1fr); } .document-list li > button { grid-column: 2; justify-self: start; } }
</style>