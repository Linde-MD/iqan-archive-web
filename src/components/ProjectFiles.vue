<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { liveQuery } from 'dexie';
import type { ArchiveLocation, ProjectGraph } from '../domain/model';
import { orderedVersionNodes, type VersionOrder } from '../domain/version-order';
import type { ArchiveRepository } from '../storage/database';
import { matchScannedFiles, type FileCandidate } from '../domain/filenames';
import { fileOperationErrorMessage, locateFile, type DirectoryRole } from '../files/directories';
import type { ArchiveRoots, DirectoryHandle } from '../files/directories';
import DirectoryPanel from './DirectoryPanel.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string; projectName: string; archiveRoots: ArchiveRoots }>();
const versionOrder = defineModel<VersionOrder>('versionOrder', { default: 'newest' });
const emit = defineEmits<{ busy: [value: boolean] }>();
const graph = shallowRef<ProjectGraph>();
const engineering = ref<InstanceType<typeof DirectoryPanel>>();
const candidates = shallowRef<FileCandidate[]>([]);
const comparisonDocuments = shallowRef<FileCandidate[]>([]);
const scanned = ref(false);
const comparisonDocumentsScanned = ref(false);
const engineeringLocation = ref<ArchiveLocation>('local');
const documentsLocation = ref<ArchiveLocation>('local');
const selected = ref<string[]>([]);
const busyRoles = ref(new Set<DirectoryRole>());
const saving = ref(false);
const error = ref('');
const status = ref('');
const errorHeading = ref<HTMLElement>();
let subscription: { unsubscribe(): void } | undefined;
const busy = computed(() => saving.value || busyRoles.value.size > 0);
const association = computed(() => graph.value ? matchScannedFiles(graph.value, candidates.value) : undefined);
const rows = computed(() => association.value?.rows ?? []);
const versionRows = computed(() => graph.value ? orderedVersionNodes(graph.value, versionOrder.value).map(node => ({ ...node, files: association.value?.matches.get(node.id) ?? [] })) : []);
const selectedSet = computed(() => new Set(selected.value));
const eligibleRows = computed(() => rows.value.filter(row => row.reason === null && row.nodeId === null));
const selectedRows = computed(() => eligibleRows.value.filter(row => selectedSet.value.has(row.relativePath)));
const allSelected = computed(() => eligibleRows.value.length > 0 && selectedRows.value.length === eligibleRows.value.length);
const partlySelected = computed(() => selectedRows.value.length > 0 && !allSelected.value);

function selectAll() {
  selected.value = eligibleRows.value.map(row => row.relativePath);
}
function toggleAll() {
  if (allSelected.value) selected.value = [];
  else selectAll();
}

function showError(cause: unknown) {
  error.value = fileOperationErrorMessage(cause);
  status.value = '';
  void nextTick(() => errorHeading.value?.focus());
}
function setBusy(role: DirectoryRole, value: boolean) {
  if (value) { error.value = ''; status.value = ''; }
  const next = new Set(busyRoles.value);
  if (value) next.add(role); else next.delete(role);
  busyRoles.value = next;
  emit('busy', busy.value);
}
async function operation(action: () => Promise<void>) {
  saving.value = true; emit('busy', true); error.value = ''; status.value = '';
  try { await action(); } catch (cause) { showError(cause); }
  finally { saving.value = false; emit('busy', busy.value); }
}
function invalidate() {
  candidates.value = []; selected.value = []; scanned.value = false;
}
function receiveGraph(next: ProjectGraph) {
  if (graph.value && graph.value.project.partNumber !== next.project.partNumber) {
    invalidate();
    status.value = '零件号已修改，请重新扫描工程目录。';
  }
  graph.value = next;
}
async function refresh() {
  await operation(async () => {
    receiveGraph(await props.repository.get(props.projectId));
    invalidate(); comparisonDocuments.value = []; comparisonDocumentsScanned.value = false;
  });
}
async function register() {
  await operation(async () => {
    if (!graph.value) throw new Error('请先读取项目。');
    if (!selectedRows.value.length) throw new Error('请至少选择一个尚无对应版本的合法文件。');
    graph.value = await props.repository.register(props.projectId, graph.value.project.revision, selectedRows.value);
    selected.value = []; status.value = '缺失版本已创建并自动关联；未保存本地文件信息，未推断父边或推进分支头。';
  });
}
async function locate(path: string) {
  await operation(async () => {
    const root = engineering.value?.getHandle();
    if (!root) throw new Error(`请先设置${engineeringLocation.value === 'local' ? '本地' : '共享'}工程目录并扫描。`);
    await locateFile(root, path);
    status.value = `文件存在且可读取：${path}。未启动本机程序。`;
  });
}
function receiveEngineeringFiles(location: ArchiveLocation, files: FileCandidate[]) {
  engineeringLocation.value = location;
  candidates.value = files;
  scanned.value = true;
}
function receiveComparisonDocuments(location: ArchiveLocation, files: FileCandidate[]) {
  documentsLocation.value = location;
  comparisonDocuments.value = files;
  comparisonDocumentsScanned.value = true;
}
onMounted(() => {
  subscription = liveQuery(() => props.repository.get(props.projectId)).subscribe({
    next: receiveGraph,
    error: showError,
  });
});
onUnmounted(() => subscription?.unsubscribe());
</script>

<template>
  <section class="panel file-workspace" aria-labelledby="file-title" :aria-busy="busy">
    <div class="section-heading">
      <div><p class="eyebrow">PROJECT FILES</p><h2 id="file-title">项目文件工作区</h2></div>
      <button class="secondary icon-button" :disabled="busy" aria-label="重新读取项目" title="重新读取项目" @click="refresh"><AppIcon name="refresh" /></button>
    </div>
    <div v-if="error" role="alert" class="error"><h3 ref="errorHeading" tabindex="-1">文件操作未完成</h3><p>{{ error }}</p><p>失败不会部分提交。扫描失败请重扫；若提示修订冲突，请重新读取项目并重扫。</p></div>
    <p role="status">{{ status }}</p>
    <template v-if="graph">
      <div class="workspace-meta"><strong>{{ graph.project.name }}</strong><span>零件号 <code>{{ graph.project.partNumber }}</code></span><span class="count">{{ graph.nodes.length }} 个版本 · {{ scanned ? rows.filter(row => row.nodeId !== null).length : '尚未扫描' }}{{ scanned ? ' 个关联文件' : '' }}</span></div>
      <div class="directory-grid">
        <DirectoryPanel ref="engineering" :project-name="projectName" :archive-roots="archiveRoots" role="engineering" :disabled="busy" @busy="setBusy('engineering', $event)" @error="showError" @invalidate="invalidate" @results="receiveEngineeringFiles" />
        <DirectoryPanel :project-name="projectName" :archive-roots="archiveRoots" role="word" :disabled="busy" @busy="setBusy('word', $event)" @error="showError" @invalidate="comparisonDocuments = []; comparisonDocumentsScanned = false" @results="receiveComparisonDocuments" />
      </div>

      <div class="file-section-heading"><h3>工程扫描预览</h3><span v-if="scanned" class="source-tag">{{ engineeringLocation === 'local' ? '本地' : '共享' }}</span></div>
      <p v-if="!scanned">尚未扫描工程子目录。</p>
      <p v-else-if="!rows.length">本次未找到 .idax、.idsx、.idvx 文件。</p>
      <template v-else>
        <div class="selection-toolbar">
          <div class="actions">
            <button class="tool-button" :disabled="busy || !eligibleRows.length || allSelected" aria-label="全选可登记项" title="选择所有可登记创建版本的文件" @click="selectAll"><AppIcon name="check" /><span class="tool-caption">全选</span></button>
            <button class="tool-button" :disabled="busy || !selectedRows.length" aria-label="全不选" title="取消选择所有文件" @click="selected = []"><AppIcon name="clear" /><span class="tool-caption">全不选</span></button>
          </div>
          <span role="status" class="selection-count">已选 {{ selectedRows.length }} / {{ eligibleRows.length }} 项 · 共 {{ rows.length }} 项</span>
        </div>
        <div class="table-scroll" tabindex="0" aria-label="工程候选文件表">
          <table><thead><tr><th class="selection-cell"><label class="checkbox-target"><input type="checkbox" :checked="allSelected" :indeterminate.prop="partlySelected" :disabled="busy || !eligibleRows.length" aria-label="全选或取消全部可登记文件" @change="toggleAll" /></label></th><th>相对路径</th><th>匹配状态</th></tr></thead>
            <tbody><tr v-for="row in rows" :key="row.relativePath" :class="{ 'row-selected': selectedSet.has(row.relativePath) && !row.reason && !row.nodeId }">
              <td class="selection-cell"><label class="checkbox-target"><input v-model="selected" type="checkbox" :value="row.relativePath" :disabled="busy || !!row.reason || row.nodeId !== null" :aria-label="`登记 ${row.relativePath}`" /></label></td>
              <td class="file-path">{{ row.relativePath }}</td><td><span :class="['candidate-state', { eligible: !row.reason }]">{{ row.reason ?? (row.nodeId ? '已自动关联' : '可登记创建版本') }}</span></td>
            </tr></tbody>
          </table>
        </div>
        <div class="registration-bar"><span>同完整版本只创建一次，不修改原文件</span><button :disabled="busy || !selectedRows.length" @click="register"><AppIcon name="plus" />从 {{ selectedRows.length }} 个所选文件创建缺失版本</button></div>
      </template>

      <p v-if="scanned && graph.nodes.length" class="form-help" role="status">{{ association?.missing.length ? `本次扫描：${association.missing.length} 个版本缺少源文件（不影响版本图配置）。` : '本次扫描：所有版本均已找到匹配源文件。' }}</p>
      <div class="file-section-heading subheading"><h3>版本与自动关联文件</h3><button class="tool-button" :disabled="busy" :aria-label="`切换版本排序，当前${versionOrder === 'oldest' ? '旧到新' : '新到旧'}`" :title="`当前${versionOrder === 'oldest' ? '旧到新' : '新到旧'}；父子关系优先`" @click="versionOrder = versionOrder === 'oldest' ? 'newest' : 'oldest'"><AppIcon name="sort" /><span class="tool-caption">{{ versionOrder === 'oldest' ? '旧 → 新' : '新 → 旧' }}</span></button></div>
      <p v-if="!graph.nodes.length">尚无版本节点。可在版本图创建，或从扫描文件登记创建。</p>
      <p v-else-if="!scanned" class="form-help">选择共享或本地目录并扫描后，显示版本文件。</p>
      <div class="version-files-scroll" tabindex="0" role="region" aria-label="版本与自动关联文件，可滚动">
      <ul class="version-list">
        <li v-for="node in versionRows" :key="node.id">
          <div class="version-file-heading"><code>{{ node.version }}</code><span :class="['release-label', { released: node.releasedAt }]">{{ node.releasedAt ? '已放行' : '未放行' }}</span></div>
          <ul class="source-file-list">
            <li v-for="file in node.files" :key="file.relativePath" class="source-file-row">
              <AppIcon name="file" />
              <span class="source-file-path">{{ file.relativePath }}</span>
              <span class="source-tag">{{ engineeringLocation === 'local' ? '本地' : '共享' }}</span>
              <button class="secondary icon-button" :disabled="busy" :aria-label="`检查文件 ${file.fileName}`" :title="`检查文件 ${file.fileName}`" @click="locate(file.relativePath)"><AppIcon name="scan" /></button>
            </li>
            <li v-if="scanned && !node.files.length" class="source-file-empty">本次扫描未找到匹配文件</li>
          </ul>
        </li>
      </ul>
      </div>

      <div class="file-section-heading subheading"><h3>软件对比文档</h3><span v-if="comparisonDocumentsScanned" class="source-tag">{{ documentsLocation === 'local' ? '本地' : '共享' }}</span></div>
      <p v-if="!comparisonDocumentsScanned">尚未扫描软件对比文档目录。</p><p v-else-if="!comparisonDocuments.length">未找到支持的 .doc/.docx 软件对比文档。</p>
      <ul v-if="comparisonDocuments.length" class="source-file-list comparison-document-list">
        <li v-for="file in comparisonDocuments" :key="file.relativePath" class="source-file-row">
          <AppIcon name="documents" />
          <span class="source-file-path">{{ file.relativePath }}</span>
          <span class="source-tag">{{ documentsLocation === 'local' ? '本地' : '共享' }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>
