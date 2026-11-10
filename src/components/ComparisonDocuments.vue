<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import type { ArchiveLocation } from '../domain/model';
import { mergeDocumentCandidates, type MergedDocumentCandidate } from '../domain/filenames';
import { buildDocumentCopyUri, buildDocumentOpenUri } from '../domain/iqan-protocol';
import { checkPermission, fileOperationErrorMessage, locateFile, projectDirectoryName, sameDirectory, type ArchiveRoots } from '../files/directories';
import { scanDocumentDirectory, type DocumentDirectoryScan } from '../files/document-directories';
import DocumentDirectoryPanel, { type DocumentLocationStates } from './DocumentDirectoryPanel.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string; projectName: string; archiveRoots: ArchiveRoots }>();
const emit = defineEmits<{ busy: [value: boolean]; graph: [] }>();
const sourceStates = shallowRef<DocumentLocationStates>({
  shared: { status: 'idle', message: '尚未扫描', count: 0 },
  local: { status: 'idle', message: '尚未扫描', count: 0 },
});
const selectedSources = ref<Record<string, ArchiveLocation>>({});
const query = ref('');
const scanning = ref(false);
const opening = ref(false);
const copying = ref(false);
const error = ref('');
const status = ref('');
let disposed = false;
const busy = computed(() => scanning.value || opening.value || copying.value);
const files = computed(() => mergeDocumentCandidates({
  shared: sourceStates.value.shared.scan?.files ?? [],
  local: sourceStates.value.local.scan?.files ?? [],
}));
const scanComplete = computed(() => ['success', 'missing'].includes(sourceStates.value.shared.status)
  && ['success', 'missing'].includes(sourceStates.value.local.status));
const scanAttempted = computed(() => (['shared', 'local'] as const).some(location =>
  ['success', 'missing', 'error'].includes(sourceStates.value[location].status)));
const visibleFiles = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return files.value.filter(file => file.relativePath.toLocaleLowerCase().includes(search));
});

function receiveScans(value: DocumentLocationStates) {
  sourceStates.value = value;
  const selected: Record<string, ArchiveLocation> = {};
  for (const file of mergeDocumentCandidates({
    shared: value.shared.scan?.files ?? [],
    local: value.local.scan?.files ?? [],
  })) {
    const previous = selectedSources.value[file.relativePath];
    selected[file.relativePath] = previous && file.locations.includes(previous)
      ? previous : file.locations.includes('local') ? 'local' : 'shared';
  }
  selectedSources.value = selected;
  error.value = '';
}

function scanningChanged(value: boolean) {
  scanning.value = value;
  emit('busy', busy.value);
}

function onRowKeyDown(event: KeyboardEvent, file: MergedDocumentCandidate) {
  if (event.key === 'Enter' && event.target === event.currentTarget) {
    event.preventDefault();
    void openDocument(file);
  }
}

function sourceOptions(file: MergedDocumentCandidate): ArchiveLocation[] {
  return file.locations;
}

function selectOpenSource(file: MergedDocumentCandidate, location: ArchiveLocation) {
  if (busy.value || !sourceOptions(file).includes(location)) return;
  selectedSources.value = { ...selectedSources.value, [file.relativePath]: location };
}

async function openDocument(file: MergedDocumentCandidate) {
  if (busy.value) return;
  const location = selectedSources.value[file.relativePath] ?? (file.locations.includes('local') ? 'local' : 'shared');
  opening.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '正在检查文档…';
  try {
    const original = sourceStates.value[location].scan;
    if (!original?.binding) throw new Error(`${location === 'local' ? '本地' : '共享'}文档目录未成功扫描，请重新扫描。`);
    const latest = await scanDocumentDirectory(props.repository, props.projectId, location, new AbortController().signal);
    if (!latest.binding || !(await sameDirectory(original.root, latest.root)) || !(await sameDirectory(original.binding, latest.binding)))
      throw new Error('文档扫描来源已改变，请重新扫描后再打开。');
    if (!latest.files.some(candidate => candidate.relativePath === file.relativePath))
      throw new Error(`${location === 'local' ? '本地' : '共享'}文档已不存在，请重新扫描。`);
    await locateFile(latest.binding, file.relativePath);
    const uri = buildDocumentOpenUri(props.projectId, latest.binding.name, file.relativePath, location);
    if (disposed) return;
    window.location.assign(uri);
    status.value = `已请求本地启动器打开${location === 'local' ? '本地' : '共享'}文档，请查看系统提示。网页无法确认 Word 是否已打开文档。`;
  } catch (cause) {
    if (!disposed) { error.value = fileOperationErrorMessage(cause); status.value = ''; }
  } finally {
    opening.value = false;
    if (!disposed) emit('busy', busy.value);
  }
}

async function copyDocument(file: MergedDocumentCandidate) {
  if (busy.value || file.locations.length !== 1 || !scanComplete.value) return;
  const sourceLocation = file.locations[0]!;
  const targetLocation: ArchiveLocation = sourceLocation === 'local' ? 'shared' : 'local';
  copying.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '';
  try {
    const currentScans = sourceStates.value;
    const [sharedScan, localScan] = await Promise.all([
      scanDocumentDirectory(props.repository, props.projectId, 'shared', new AbortController().signal),
      scanDocumentDirectory(props.repository, props.projectId, 'local', new AbortController().signal),
    ]);
    const freshScans: Record<ArchiveLocation, DocumentDirectoryScan> = { shared: sharedScan, local: localScan };
    for (const location of ['shared', 'local'] as const) {
      const previous = currentScans[location].scan;
      const latest = freshScans[location];
      if (!previous || previous.missingDirectory !== latest.missingDirectory
        || !(await sameDirectory(previous.root, latest.root))
        || (previous.binding && (!latest.binding || !(await sameDirectory(previous.binding, latest.binding)))))
        throw new Error(`${location === 'local' ? '本地' : '共享'}文档目录授权或项目目录已变化，请重新扫描。`);
    }
    if (!freshScans[sourceLocation].files.some(candidate => candidate.relativePath === file.relativePath))
      throw new Error(`源文档已不存在于${sourceLocation === 'local' ? '本地' : '共享'}目录，请重新扫描。`);
    if (freshScans[targetLocation].files.some(candidate => candidate.relativePath === file.relativePath))
      throw new Error(`目标${targetLocation === 'local' ? '本地' : '共享'}目录已存在同路径文档，不会覆盖。`);
    if (!await checkPermission(freshScans[sourceLocation].root)
      || !await checkPermission(freshScans[targetLocation].root, false, 'readwrite'))
      throw new Error('文档源或目标目录授权已失效，请重新授权后再复制。');

    const uri = buildDocumentCopyUri(
      props.projectId,
      sourceLocation,
      projectDirectoryName(props.projectName, 'word'),
      file.relativePath,
      targetLocation,
    );
    if (disposed) return;
    window.location.assign(uri);
    status.value = `已请求 Launcher 将文档复制到${targetLocation === 'shared' ? '共享' : '本地'}目录，请在本机确认路径。网页无法确认复制是否完成。`;
  } catch (cause) {
    if (!disposed) error.value = fileOperationErrorMessage(cause);
  } finally {
    copying.value = false;
    if (!disposed) emit('busy', busy.value);
  }
}

function directoryBusy(value: boolean) {
  scanning.value = value;
  emit('busy', busy.value);
}
onUnmounted(() => { disposed = true; });
</script>

<template>
  <section class="panel document-workspace" aria-labelledby="document-title" :aria-busy="busy">
    <div class="section-heading">
      <div><p class="eyebrow">COMPARISON DOCUMENTS</p><h2 id="document-title">软件对比文档</h2></div>
      <button class="secondary" :disabled="busy" @click="emit('graph')"><AppIcon name="branch" />版本图</button>
    </div>
    <DocumentDirectoryPanel :repository="repository" :project-id="projectId" :project-name="projectName" :archive-roots="archiveRoots"
      :disabled="opening || copying" @results="receiveScans" @busy="directoryBusy" />
    <div class="document-filters">
      <label for="document-search">搜索文档</label>
      <input id="document-search" v-model="query" type="search" placeholder="文件名或相对路径" />
      <span>{{ visibleFiles.length }} / {{ files.length }} 份文档</span>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="scanning && !files.length" class="form-help">正在扫描共享和本地软件对比文档目录…</p>
    <p v-else-if="!scanAttempted" class="form-help">选择“扫描两侧”同时读取共享和本地目录；扫描失败会按来源分别显示。</p>
    <p v-else-if="!visibleFiles.length" class="form-help">{{ files.length ? '没有匹配的文档。' : '两个目录当前没有可显示的文档结果。' }}</p>
    <ul v-else class="document-list" aria-label="软件对比文档列表">
      <li v-for="file in visibleFiles" :key="file.relativePath" tabindex="0" :aria-label="file.relativePath"
        @keydown="onRowKeyDown($event, file)">
        <AppIcon name="file" />
        <div class="document-file"><strong>{{ file.fileName }}</strong><span>{{ file.relativePath }}</span></div>
        <div class="document-row-actions">
          <div v-if="sourceOptions(file).length === 2" class="document-source-segmented" role="group" :aria-label="`打开 ${file.relativePath} 的来源`">
            <button type="button" :aria-pressed="selectedSources[file.relativePath] === 'local'" :disabled="busy" @click="selectOpenSource(file, 'local')"><AppIcon name="computer" />本地</button>
            <button type="button" :aria-pressed="selectedSources[file.relativePath] === 'shared'" :disabled="busy" @click="selectOpenSource(file, 'shared')"><AppIcon name="cloud" />共享</button>
          </div>
          <span v-else class="document-source-tag"><AppIcon :name="sourceOptions(file)[0] === 'local' ? 'computer' : 'cloud'" />{{ sourceOptions(file)[0] === 'local' ? '本地' : '共享' }}</span>
          <button v-if="file.locations.length === 1" class="secondary" :disabled="busy || !scanComplete" :aria-label="`${file.locations[0] === 'local' ? '上传到共享' : '下载到本地'} ${file.relativePath}`" @click="copyDocument(file)">
            <AppIcon :name="file.locations[0] === 'local' ? 'cloud' : 'computer'" />{{ file.locations[0] === 'local' ? '上传到共享' : '下载到本地' }}
          </button>
          <button class="secondary" :disabled="busy" :aria-label="`在 Word 中打开 ${file.relativePath}`" @click="openDocument(file)"><AppIcon name="arrow" />打开</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.document-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
.document-filters input { flex: 1 1 240px; min-width: 0; }
.document-filters label { margin: 0; }
.document-filters span { color: var(--muted); font-variant-numeric: tabular-nums; }
.document-list { list-style: none; padding: 0; margin: 0; }
.document-list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 12px 4px; border-bottom: 1px solid var(--border); }
.document-file { display: grid; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.document-file span { color: var(--muted); font-family: var(--font-mono, monospace); font-size: 13px; }
.document-row-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
.document-source-segmented { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 7px; background: #101a2a; }
.document-source-segmented button { min-height: 44px; padding: 6px 9px; gap: 5px; background: transparent; color: var(--muted); font-size: 11px; }
.document-source-segmented button[aria-pressed="true"] { border-color: #75b7ff; background: #173254; color: #fff; }
.document-source-segmented button:hover { border-color: var(--accent); color: #fff; }
.document-source-segmented .app-icon { width: 16px; height: 16px; }
.document-source-tag { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; color: #cce2ff; font-size: 11px; white-space: nowrap; }
.document-source-tag .app-icon { width: 16px; height: 16px; }
@media (max-width: 540px) { .document-list li { grid-template-columns: 20px minmax(0, 1fr); } .document-row-actions { grid-column: 2; justify-self: start; flex-wrap: wrap; } }
</style>