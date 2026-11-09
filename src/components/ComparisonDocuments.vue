<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import type { ArchiveLocation } from '../domain/model';
import type { FileCandidate } from '../domain/filenames';
import { buildDocumentOpenUri } from '../domain/iqan-protocol';
import { checkPermission, fileOperationErrorMessage, locateFile, resolveProjectDirectory, sameDirectory, scanDirectory, type ArchiveRoots, type DirectoryHandle } from '../files/directories';
import DirectoryPanel from './DirectoryPanel.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string; projectName: string; archiveRoots: ArchiveRoots }>();
const emit = defineEmits<{ busy: [value: boolean]; graph: [] }>();
const directory = ref<InstanceType<typeof DirectoryPanel>>();
const files = shallowRef<FileCandidate[]>([]);
const scannedDirectory = shallowRef<DirectoryHandle>();
const scannedLocation = ref<ArchiveLocation>('local');
const availableSources = shallowRef<Record<string, ArchiveLocation[]>>({});
const selectedSources = ref<Record<string, ArchiveLocation>>({});
const scanned = ref(false);
const query = ref('');
const scanning = ref(false);
const opening = ref(false);
const checkingSources = ref(false);
const error = ref('');
const status = ref('');
const sourceCheckMessage = ref('');
let disposed = false;
let sourceController: AbortController | undefined;
const busy = computed(() => scanning.value || opening.value || checkingSources.value);
const visibleFiles = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return files.value.filter(file => file.relativePath.toLocaleLowerCase().includes(search));
});

function receiveFiles(location: ArchiveLocation, value: FileCandidate[]) {
  files.value = value;
  scannedDirectory.value = directory.value?.getHandle();
  scannedLocation.value = location;
  availableSources.value = Object.fromEntries(value.map(file => [file.relativePath, [location]]));
  selectedSources.value = Object.fromEntries(value.map(file => [file.relativePath, location]));
  scanned.value = true;
  sourceCheckMessage.value = '';
  void discoverOtherSource(location, value);
}
function invalidate() {
  sourceController?.abort();
  sourceController = undefined;
  checkingSources.value = false;
  files.value = [];
  availableSources.value = {};
  selectedSources.value = {};
  scanned.value = false;
  scannedDirectory.value = undefined;
  sourceCheckMessage.value = '';
  status.value = '';
  error.value = '';
}
function scanningChanged(value: boolean) {
  scanning.value = value;
  emit('busy', busy.value);
}
function onRowKeyDown(event: KeyboardEvent, file: FileCandidate) {
  if (event.key === 'Enter' && event.target === event.currentTarget) {
    event.preventDefault();
    void openDocument(file);
  }
}
async function openDocument(file: FileCandidate) {
  await openDocumentFrom(file, selectedSources.value[file.relativePath] ?? 'local');
}

async function openDocumentFrom(file: FileCandidate, preferredLocation: ArchiveLocation) {
  if (busy.value) return;
  opening.value = true;
  emit('busy', true);
  error.value = '';
  status.value = '正在检查文档…';
  try {
    const scannedRootNow = await props.repository.getArchiveRoot(scannedLocation.value);
    if (!scannedDirectory.value || !scannedRootNow || !await checkPermission(scannedRootNow))
      throw new Error('文档扫描来源已改变，请重新扫描后再打开。');
    const scannedDirectoryNow = await resolveProjectDirectory(scannedRootNow, props.projectName, 'word');
    if (!(await sameDirectory(scannedDirectory.value, scannedDirectoryNow)))
      throw new Error('文档扫描来源已改变，请重新扫描后再打开。');
    const source = await findDocumentSource(file, preferredLocation, new AbortController().signal);
    const uri = buildDocumentOpenUri(props.projectId, source.binding.name, file.relativePath, source.location);
    if (disposed) return;
    window.location.assign(uri);
    status.value = `已请求本地启动器打开${source.location === 'local' ? '本地' : '共享'}文档，请查看系统提示。网页无法确认 Word 是否已打开文档。`;
  } catch (cause) {
    if (!disposed) { error.value = fileOperationErrorMessage(cause); status.value = ''; }
  } finally {
    opening.value = false;
    if (!disposed) emit('busy', busy.value);
  }
}

async function scanDocumentSource(
  file: FileCandidate,
  location: ArchiveLocation,
  signal: AbortSignal,
): Promise<{ location: ArchiveLocation; root: DirectoryHandle; binding: DirectoryHandle } | null> {
  const root = await props.repository.getArchiveRoot(location);
  if (!root || !await checkPermission(root)) return null;
  const graphAtScan = await props.repository.get(props.projectId);
  const binding = await resolveProjectDirectory(root, graphAtScan.project.name, 'word');
  if (!await checkPermission(binding)) return null;
  const candidates = await scanDirectory(binding, 'word', signal, () => undefined);
  if (!candidates.some(candidate => candidate.relativePath === file.relativePath)) return null;
  await locateFile(binding, file.relativePath);
  const [latestRoot, latestGraph] = await Promise.all([
    props.repository.getArchiveRoot(location),
    props.repository.get(props.projectId),
  ]);
  if (!latestRoot || !(await sameDirectory(root, latestRoot))
    || latestGraph.project.name !== graphAtScan.project.name
    || !(await sameDirectory(binding, await resolveProjectDirectory(latestRoot, latestGraph.project.name, 'word'))))
    throw new Error('文档目录在检查期间发生变化，请重新扫描。');
  return { location, root, binding };
}

async function findDocumentSource(
  file: FileCandidate,
  preferredLocation: ArchiveLocation,
  signal: AbortSignal,
): Promise<{ location: ArchiveLocation; root: DirectoryHandle; binding: DirectoryHandle }> {
  const failures: string[] = [];
  for (const location of [preferredLocation, preferredLocation === 'local' ? 'shared' : 'local'] as const) {
    try {
      const source = await scanDocumentSource(file, location, signal);
      if (source) return source;
    } catch (cause) {
      if (signal.aborted) throw cause;
      failures.push(fileOperationErrorMessage(cause));
    }
  }
  throw new Error(failures[0] ?? `共享和本地目录中都没有找到文档“${file.relativePath}”，请重新扫描。`);
}

function sourceOptions(file: FileCandidate): ArchiveLocation[] {
  return availableSources.value[file.relativePath] ?? [scannedLocation.value];
}

function selectOpenSource(file: FileCandidate, location: ArchiveLocation) {
  if (busy.value || !sourceOptions(file).includes(location)) return;
  selectedSources.value = { ...selectedSources.value, [file.relativePath]: location };
}

async function discoverOtherSource(location: ArchiveLocation, candidates: FileCandidate[]) {
  sourceController?.abort();
  const controller = new AbortController();
  sourceController = controller;
  checkingSources.value = true;
  emit('busy', true);
  const otherLocation: ArchiveLocation = location === 'local' ? 'shared' : 'local';
  try {
    const root = await props.repository.getArchiveRoot(otherLocation);
    if (!root) return;
    if (!await checkPermission(root)) {
      sourceCheckMessage.value = `无法检查${otherLocation === 'local' ? '本地' : '共享'}目录权限。`;
      return;
    }
    const graphAtScan = await props.repository.get(props.projectId);
    let binding: DirectoryHandle;
    try { binding = await resolveProjectDirectory(root, graphAtScan.project.name, 'word'); }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === 'NotFoundError') return;
      throw cause;
    }
    if (scannedDirectory.value && await sameDirectory(binding, scannedDirectory.value)) return;
    if (!await checkPermission(binding)) {
      sourceCheckMessage.value = `无法检查${otherLocation === 'local' ? '本地' : '共享'}文档子目录权限。`;
      return;
    }
    const otherFiles = await scanDirectory(binding, 'word', controller.signal, () => undefined);
    const [latestRoot, latestGraph] = await Promise.all([
      props.repository.getArchiveRoot(otherLocation),
      props.repository.get(props.projectId),
    ]);
    if (controller.signal.aborted || !latestRoot || !(await sameDirectory(root, latestRoot))
      || latestGraph.project.name !== graphAtScan.project.name
      || !(await sameDirectory(binding, await resolveProjectDirectory(latestRoot, latestGraph.project.name, 'word')))) return;
    const otherPaths = new Set(otherFiles.map(file => file.relativePath));
    const locationsByPath: Record<string, ArchiveLocation[]> = {};
    const selectedByPath: Record<string, ArchiveLocation> = {};
    for (const file of candidates) {
      const locations: ArchiveLocation[] = [location];
      if (otherPaths.has(file.relativePath)) locations.push(otherLocation);
      locationsByPath[file.relativePath] = locations;
      selectedByPath[file.relativePath] = locations.includes('local') ? 'local' : locations[0]!;
    }
    availableSources.value = locationsByPath;
    selectedSources.value = selectedByPath;
  } catch (cause) {
    if (!controller.signal.aborted) sourceCheckMessage.value = fileOperationErrorMessage(cause);
  } finally {
    if (sourceController === controller) {
      sourceController = undefined;
      checkingSources.value = false;
      emit('busy', busy.value);
    }
  }
}
onUnmounted(() => { disposed = true; sourceController?.abort(); });
</script>

<template>
  <section class="panel document-workspace" aria-labelledby="document-title" :aria-busy="busy">
    <div class="section-heading">
      <div><p class="eyebrow">COMPARISON DOCUMENTS</p><h2 id="document-title">软件对比文档</h2></div>
      <button class="secondary" :disabled="busy" @click="emit('graph')"><AppIcon name="branch" />版本图</button>
    </div>
    <DirectoryPanel ref="directory" :project-name="projectName" :archive-roots="archiveRoots" role="word" :disabled="opening" auto-scan
      @results="receiveFiles" @invalidate="invalidate" @busy="scanningChanged" @error="error = fileOperationErrorMessage($event)" />
    <div class="document-filters">
      <label for="document-search">搜索文档</label>
      <input id="document-search" v-model="query" type="search" placeholder="文件名或相对路径" />
      <span>{{ visibleFiles.length }} / {{ files.length }} 份文档</span>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="sourceCheckMessage" class="form-help" role="status">{{ sourceCheckMessage }}</p>
    <p v-if="!scanned" class="form-help">{{ scanning ? '正在扫描软件对比文档…' : '请选择并扫描软件对比文档目录。' }}</p>
    <p v-else-if="!visibleFiles.length" class="form-help">{{ files.length ? '没有匹配的文档。' : '目录中没有 .doc/.docx 软件对比文档。' }}</p>
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
.document-row-actions { display: flex; align-items: center; gap: 4px; }
.document-source-segmented { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 7px; background: #101a2a; }
.document-source-segmented button { min-height: 44px; padding: 6px 9px; gap: 5px; background: transparent; color: var(--muted); font-size: 11px; }
.document-source-segmented button[aria-pressed="true"] { border-color: #75b7ff; background: #173254; color: #fff; }
.document-source-segmented button:hover { border-color: var(--accent); color: #fff; }
.document-source-segmented .app-icon { width: 16px; height: 16px; }
.document-source-tag { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; color: #cce2ff; font-size: 11px; white-space: nowrap; }
.document-source-tag .app-icon { width: 16px; height: 16px; }
@media (max-width: 540px) { .document-list li { grid-template-columns: 20px minmax(0, 1fr); } .document-row-actions { grid-column: 2; justify-self: start; flex-wrap: wrap; } }
</style>