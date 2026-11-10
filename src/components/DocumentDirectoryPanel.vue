<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ArchiveLocation } from '../domain/model';
import type { ArchiveRoots } from '../files/directories';
import { fileOperationErrorMessage } from '../files/directories';
import { scanDocumentDirectories, type DocumentDirectoryScan, type DocumentLocationScanResult } from '../files/document-directories';
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
const emit = defineEmits<{ results: [states: DocumentLocationStates]; busy: [value: boolean] }>();
const states = ref<DocumentLocationStates>({ shared: emptyState(), local: emptyState() });
const scanning = ref(false);
const authorizing = ref(false);
const busy = computed(() => scanning.value || authorizing.value);
let controller: AbortController | undefined;
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
  if (authorizing.value || props.disabled) return;
  controller?.abort();
  const activeController = new AbortController();
  controller = activeController;
  scanning.value = true;
  emit('busy', true);
  states.value = {
    shared: { status: 'scanning', message: '正在扫描…', count: 0 },
    local: { status: 'scanning', message: '正在扫描…', count: 0 },
  };
  emit('results', states.value);
  const progress: Record<ArchiveLocation, number> = { shared: 0, local: 0 };

  try {
    const results = await scanDocumentDirectories(props.repository, props.projectId, activeController.signal, (location, count) => {
      progress[location] = count;
      const current = states.value[location];
      if (current.status === 'scanning') states.value = {
        ...states.value,
        [location]: { ...current, count },
      };
    });
    if (disposed || activeController.signal.aborted) return;
    states.value = {
      shared: resultToState(results.find(result => result.location === 'shared')!),
      local: resultToState(results.find(result => result.location === 'local')!),
    };
    emit('results', states.value);
  } catch (cause) {
    if (!activeController.signal.aborted) {
      const state = { status: 'error', message: fileOperationErrorMessage(cause), count: 0 } satisfies DocumentLocationState;
      states.value = { shared: state, local: state };
      emit('results', states.value);
    } else if (controller === activeController && !disposed) {
      const state = { status: 'idle', message: '扫描已取消，未提交本次结果', count: 0 } satisfies DocumentLocationState;
      states.value = { shared: state, local: state };
      emit('results', states.value);
    }
  } finally {
    if (controller === activeController) {
      controller = undefined;
      scanning.value = false;
      emit('busy', busy.value);
    }
  }
}

function resultToState(result: DocumentLocationScanResult): DocumentLocationState {
  return result.status === 'success'
    ? { status: 'success', message: `扫描成功，找到 ${result.scan.files.length} 份文档`, count: result.count, scan: result.scan }
    : result.status === 'missing'
      ? { status: 'missing', message: '项目文档子目录不存在；复制到此位置时 Launcher 会创建。', count: 0, scan: result.scan }
    : { status: 'error', message: result.message, count: result.count };
}

async function authorizeBoth() {
  if (busy.value || props.disabled) return;
  authorizing.value = true;
  emit('busy', true);
  try {
    await Promise.all((['shared', 'local'] as const).map(async location => {
      const root = props.archiveRoots[location];
      if (!root) return;
      try {
        const permission = await root.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
          states.value = {
            ...states.value,
            [location]: { status: 'error', message: `${locationLabel(location)}根目录读写授权未获批准。`, count: 0 },
          };
        }
      } catch (cause) {
        states.value = {
          ...states.value,
          [location]: { status: 'error', message: fileOperationErrorMessage(cause), count: 0 },
        };
      }
    }));
  } finally {
    authorizing.value = false;
    emit('busy', false);
  }
  await scanBoth();
}

function cancelScan() {
  controller?.abort();
}

defineExpose({ scanBoth });

watch(() => [props.archiveRoots.shared, props.archiveRoots.local, props.projectName] as const, () => {
  controller?.abort();
  states.value = { shared: emptyState(), local: emptyState() };
  emit('results', states.value);
  if (props.archiveRoots.shared || props.archiveRoots.local) void scanBoth();
});

onMounted(() => {
  if (props.archiveRoots.shared || props.archiveRoots.local) void scanBoth();
});
onUnmounted(() => { disposed = true; controller?.abort(); });
</script>

<template>
  <section class="directory-card document-directories" aria-label="共享和本地软件对比文档目录" :aria-busy="busy">
    <div class="section-heading">
      <h3><AppIcon name="file" />软件对比文档目录</h3>
      <div class="document-directory-actions">
        <button type="button" class="secondary" :disabled="disabled || busy || (!archiveRoots.shared && !archiveRoots.local)" @click="authorizeBoth"><AppIcon name="shield" />授权两侧</button>
        <button type="button" class="tool-button tool-button-accent" :disabled="disabled || busy || (!archiveRoots.shared && !archiveRoots.local)" @click="scanBoth"><AppIcon name="scan" />扫描两侧</button>
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
      </div>
    </div>
  </section>
</template>

<style scoped>
.document-directories .section-heading { align-items: flex-start; gap: 12px; }
.document-directory-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.document-location-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.document-location-status { display: grid; align-content: start; gap: 7px; min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: rgba(8, 15, 27, .35); }
.document-location-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.document-location-heading strong { display: inline-flex; align-items: center; gap: 7px; }
.document-location-heading .app-icon { width: 17px; height: 17px; }
.document-location-folder { color: var(--muted); font: 12px var(--font-mono, monospace); overflow-wrap: anywhere; }
.document-location-message { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.document-location-error { color: var(--danger, #ffaaa5); }
@media (max-width: 620px) {
  .document-directories .section-heading { flex-direction: column; }
  .document-directory-actions { justify-content: flex-start; }
  .document-location-status-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>