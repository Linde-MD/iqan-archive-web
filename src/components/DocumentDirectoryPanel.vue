<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ArchiveLocation } from '../domain/model';
import type { ArchiveRoots } from '../files/directories';
import { fileOperationErrorMessage } from '../files/directories';
import { scanDocumentDirectory, type DocumentDirectoryScan } from '../files/document-directories';
import type { ArchiveRepository } from '../storage/database';
import AppIcon from './AppIcon.vue';

export interface DocumentLocationState {
  status: 'idle' | 'scanning' | 'success' | 'missing' | 'error';
  message: string;
  count: number;
  scan?: DocumentDirectoryScan;
}

export type DocumentLocationStates = Record<ArchiveLocation, DocumentLocationState>;

const props = defineProps<{
  repository: ArchiveRepository;
  projectId: string;
  projectName: string;
  archiveRoots: ArchiveRoots;
  disabled: boolean;
}>();
const emit = defineEmits<{ results: [states: DocumentLocationStates] }>();
const states = ref<DocumentLocationStates>({ shared: emptyState(), local: emptyState() });
const scanning = ref(false);
const authorizing = ref<Record<ArchiveLocation, boolean>>({ shared: false, local: false });
const busy = computed(() => scanning.value || authorizing.value.shared || authorizing.value.local);
const controllers = new Map<ArchiveLocation, AbortController>();
let disposed = false;

function emptyState(): DocumentLocationState {
  return { status: 'idle', message: '尚未扫描', count: 0 };
}

function locationLabel(location: ArchiveLocation) {
  return location === 'shared' ? '共享' : '本地';
}

function folderName(location: ArchiveLocation) {
  const root = props.archiveRoots[location];
  return root ? `${props.projectName}_software_changes_docs` : '未设置根目录';
}

async function scanBoth() {
  if (props.disabled) return;
  await Promise.all((['local', 'shared'] as const).map(location => scanLocation(location)));
}

async function scanLocation(location: ArchiveLocation) {
  if (props.disabled || authorizing.value[location]) return;
  controllers.get(location)?.abort();
  const active = new AbortController();
  controllers.set(location, active);
  scanning.value = true;
  let count = 0;
  states.value = { ...states.value, [location]: { status: 'scanning', message: '正在扫描…', count } };
  emit('results', states.value);
  try {
    const scan = await scanDocumentDirectory(props.repository, props.projectId, location, active.signal, value => {
      count = value;
      if (controllers.get(location) === active && !active.signal.aborted)
        states.value = { ...states.value, [location]: { ...states.value[location], count } };
    });
    if (disposed || active.signal.aborted || controllers.get(location) !== active) return;
    states.value = { ...states.value, [location]: scan.missingDirectory
      ? { status: 'missing', message: '项目文档子目录不存在；复制到此位置时 Launcher 会创建。', count: 0, scan }
      : { status: 'success', message: `扫描成功，找到 ${scan.files.length} 份文档`, count, scan } };
    emit('results', states.value);
  } catch (cause) {
    if (disposed || controllers.get(location) !== active) return;
    states.value = { ...states.value, [location]: active.signal.aborted
      ? { status: 'idle', message: '扫描已取消，未提交本次结果', count: 0 }
      : { status: 'error', message: fileOperationErrorMessage(cause), count } };
    emit('results', states.value);
  } finally {
    if (controllers.get(location) === active) controllers.delete(location);
    scanning.value = controllers.size > 0;
  }
}

async function authorizeLocation(location: ArchiveLocation) {
  if (authorizing.value[location] || props.disabled) return;
  const root = props.archiveRoots[location];
  if (!root) return;
  controllers.get(location)?.abort();
  authorizing.value = { ...authorizing.value, [location]: true };
  try {
    const permission = await root.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error(`${locationLabel(location)}根目录读写授权未获批准。`);
    if (props.archiveRoots[location] !== root) throw new Error('根目录已变更，请重新授权。');
  } catch (cause) {
    states.value = { ...states.value, [location]: { status: 'error', message: fileOperationErrorMessage(cause), count: 0 } };
    emit('results', states.value);
    return;
  } finally {
    authorizing.value = { ...authorizing.value, [location]: false };
  }
  await scanLocation(location);
}

function cancelScan() {
  for (const [location, active] of controllers) {
    active.abort();
    states.value = { ...states.value, [location]: { status: 'idle', message: '扫描已取消，未提交本次结果', count: 0 } };
  }
  controllers.clear();
  scanning.value = false;
  if (!disposed) emit('results', states.value);
}

defineExpose({ scanBoth });

watch(() => [props.archiveRoots.shared, props.archiveRoots.local, props.projectName] as const, () => {
  cancelScan();
  states.value = { shared: emptyState(), local: emptyState() };
  emit('results', states.value);
  if (props.archiveRoots.shared || props.archiveRoots.local) void scanBoth();
});

onMounted(() => {
  if (props.archiveRoots.shared || props.archiveRoots.local) void scanBoth();
});
onUnmounted(() => { disposed = true; cancelScan(); });
</script>

<template>
  <section class="directory-card document-directories" aria-label="共享和本地软件对比文档目录" :aria-busy="busy">
    <div class="section-heading">
      <h3><AppIcon name="file" />软件对比文档目录</h3>
      <div class="document-directory-actions">
        <button type="button" class="tool-button tool-button-accent" :disabled="disabled || (!archiveRoots.shared && !archiveRoots.local)" @click="scanBoth"><AppIcon name="scan" />扫描两侧</button>
        <button v-if="scanning" type="button" class="secondary" aria-label="取消双目录扫描" @click="cancelScan"><AppIcon name="stop" />取消</button>
      </div>
    </div>
    <div class="document-location-status-grid">
      <div v-for="location in ['shared', 'local'] as const" :key="location" class="document-location-status">
        <div class="document-location-heading">
          <strong><AppIcon :name="location === 'shared' ? 'cloud' : 'computer'" />{{ locationLabel(location) }}根目录</strong>
          <span class="permission-badge">{{ states[location].status === 'success' ? '已扫描' : states[location].status === 'missing' ? '目录不存在' : states[location].status === 'error' ? '需处理' : states[location].status === 'scanning' ? '扫描中' : archiveRoots[location] ? '已设置' : '未设置' }}</span>
        </div>
        <span class="document-location-folder">{{ folderName(location) }}</span>
        <span v-if="states[location].status === 'scanning'" class="document-location-message" role="status">已枚举 {{ states[location].count }} 个条目…</span>
        <span v-else-if="states[location].status === 'missing'" class="document-location-message" role="status">项目文档子目录不存在；复制到此位置时 Launcher 会创建。</span>
        <span v-else-if="states[location].status === 'error'" class="document-location-message document-location-error" role="status">{{ states[location].message }}</span>
        <span v-else-if="states[location].status === 'success'" class="document-location-message" role="status">{{ states[location].message }}（枚举 {{ states[location].count }} 个条目）</span>
        <span v-else class="document-location-message">{{ states[location].message }}</span>
        <div class="document-directory-actions">
          <button type="button" class="secondary" :disabled="disabled || !archiveRoots[location] || authorizing[location]" @click="authorizeLocation(location)"><AppIcon name="shield" />授权{{ locationLabel(location) }}</button>
          <button type="button" class="secondary" :disabled="disabled || !archiveRoots[location] || authorizing[location]" @click="scanLocation(location)"><AppIcon name="scan" />扫描{{ locationLabel(location) }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.document-directories > .section-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin: 0 0 14px;
  padding: 0 0 12px;
  border-bottom: 1px solid var(--border);
}
.document-directories > .section-heading h3 { min-width: 0; margin: 0; }
.document-directory-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; min-width: 0; }
.document-directory-actions > button { min-width: 118px; min-height: 44px; margin: 0; }
.document-directory-actions > .tool-button {
  flex-direction: row;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: #152840;
  color: #a9d2ff;
}
.document-directory-actions > .tool-button:hover { border-color: var(--accent); background: #1d3858; }
.document-location-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.document-location-status { display: grid; align-content: start; gap: 8px; min-width: 0; min-height: 112px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: linear-gradient(145deg, #15243a, #101a2a); }
.document-location-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.document-location-heading strong { display: inline-flex; align-items: center; gap: 7px; }
.document-location-heading .app-icon { width: 17px; height: 17px; }
.document-location-folder { color: var(--muted); font: 12px var(--font-mono, monospace); overflow-wrap: anywhere; }
.document-location-message { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.document-location-error { color: var(--danger, #ffaaa5); }
@media (max-width: 620px) {
  .document-directories > .section-heading { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .document-directory-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); justify-content: stretch; width: 100%; gap: 8px; }
  .document-directory-actions > button { min-width: 0; width: 100%; }
  .document-location-status-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>