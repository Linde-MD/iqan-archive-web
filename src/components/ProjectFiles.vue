<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue';
import type { ProjectGraph } from '../domain/model';
import type { ArchiveRepository } from '../storage/database';
import { candidateState, type FileCandidate } from '../domain/filenames';
import { locateFile, type DirectoryRole } from '../files/directories';
import DirectoryPanel from './DirectoryPanel.vue';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const graph = shallowRef<ProjectGraph>();
const engineering = ref<InstanceType<typeof DirectoryPanel>>();
const candidates = shallowRef<FileCandidate[]>([]);
const comparisonDocuments = shallowRef<FileCandidate[]>([]);
const scanned = ref(false);
const comparisonDocumentsScanned = ref(false);
const selected = ref<string[]>([]);
const busyRoles = ref(new Set<DirectoryRole>());
const saving = ref(false);
const error = ref('');
const status = ref('');
const errorHeading = ref<HTMLElement>();
const rebindFile = ref('');
const rebindPath = ref('');
const busy = computed(() => saving.value || busyRoles.value.size > 0);
const rows = computed(() => graph.value ? candidates.value.map(file => ({ ...file, reason: candidateState(graph.value!, file) })) : []);
const selectedSet = computed(() => new Set(selected.value));
const eligibleRows = computed(() => rows.value.filter(row => row.reason === null));
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
  error.value = cause instanceof Error ? cause.message : '文件操作失败，请重试。';
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
  candidates.value = []; selected.value = []; scanned.value = false; rebindPath.value = '';
}
async function refresh() {
  await operation(async () => {
    graph.value = await props.repository.get(props.projectId);
    invalidate(); comparisonDocuments.value = []; comparisonDocumentsScanned.value = false;
  });
}
async function register() {
  await operation(async () => {
    if (!graph.value) throw new Error('请先读取项目。');
    if (rows.value.some(row => selectedSet.value.has(row.relativePath) && row.reason)) throw new Error('所选文件状态已变化，请重新检查。');
    graph.value = await props.repository.register(props.projectId, graph.value.project.revision, selectedRows.value);
    selected.value = []; status.value = '文件元数据已登记；未推断父边或推进分支头。';
  });
}
async function locate(path: string) {
  await operation(async () => {
    const root = engineering.value?.getHandle();
    if (!root) throw new Error('请先绑定工程目录。');
    await locateFile(root, path);
    status.value = `文件存在且可读取：${path}。未启动本机程序。`;
  });
}
async function rebind() {
  await operation(async () => {
    if (!graph.value) throw new Error('请先读取项目。');
    const candidate = candidates.value.find(item => item.relativePath === rebindPath.value);
    if (!candidate) throw new Error('请先扫描并明确选择一个候选文件。');
    const root = engineering.value?.getHandle();
    if (!root) throw new Error('工程目录未绑定。');
    await locateFile(root, candidate.relativePath);
    graph.value = await props.repository.rebind(props.projectId, graph.value.project.revision, rebindFile.value, candidate);
    status.value = '文件引用已重绑，原磁盘文件未改动。';
  });
}
onMounted(refresh);
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
      <div class="workspace-meta"><strong>{{ graph.project.name }}</strong><span>零件号 <code>{{ graph.project.partNumber }}</code></span><span class="count">{{ graph.nodes.length }} 个版本 · {{ graph.files.length }} 个文件</span></div>
      <details class="workspace-details"><summary>项目标识与扫描规则</summary><p class="project-id">稳定项目 ID：<code>{{ graph.project.id }}</code></p><p>只读递归扫描，每次最多枚举 5000 个条目。文件名日期文本属于完整版本号；磁盘修改时间不决定身份。不支持目录 API 时仍可查看已保存元数据。</p></details>
      <div class="directory-grid">
        <DirectoryPanel ref="engineering" :repository="repository" :project-id="projectId" role="engineering" :disabled="busy" @busy="setBusy('engineering', $event)" @error="showError" @invalidate="invalidate" @results="candidates = $event; scanned = true" />
        <DirectoryPanel :repository="repository" :project-id="projectId" role="word" :disabled="busy" @busy="setBusy('word', $event)" @error="showError" @invalidate="comparisonDocuments = []; comparisonDocumentsScanned = false" @results="comparisonDocuments = $event; comparisonDocumentsScanned = true" />
      </div>

      <h3>工程扫描预览</h3>
      <p v-if="!scanned">尚未扫描工程目录。</p>
      <p v-else-if="!rows.length">本次未找到 .idax、.idsx、.idvx 文件。</p>
      <template v-else>
        <p class="form-help">仅可登记项参与全选。新版本无父节点；相同路径不覆盖，登记前需确认。</p>
        <div class="selection-toolbar">
          <div class="actions">
            <button class="secondary" :disabled="busy || !eligibleRows.length || allSelected" @click="selectAll"><AppIcon name="check" />全选可登记项</button>
            <button class="secondary" :disabled="busy || !selectedRows.length" @click="selected = []"><AppIcon name="clear" />全不选</button>
          </div>
          <span role="status" class="selection-count">已选 {{ selectedRows.length }} / {{ eligibleRows.length }} 项 · 共 {{ rows.length }} 项</span>
        </div>
        <div class="table-scroll" tabindex="0" aria-label="工程候选文件表">
          <table><thead><tr><th class="selection-cell"><label class="checkbox-target"><input type="checkbox" :checked="allSelected" :indeterminate.prop="partlySelected" :disabled="busy || !eligibleRows.length" aria-label="全选或取消全部可登记文件" @change="toggleAll" /></label></th><th>相对路径</th><th>登记状态</th></tr></thead>
            <tbody><tr v-for="row in rows" :key="row.relativePath" :class="{ 'row-selected': selectedSet.has(row.relativePath) && !row.reason }">
              <td class="selection-cell"><label class="checkbox-target"><input v-model="selected" type="checkbox" :value="row.relativePath" :disabled="busy || !!row.reason" :aria-label="`登记 ${row.relativePath}`" /></label></td>
              <td class="file-path">{{ row.relativePath }}</td><td><span :class="['candidate-state', { eligible: !row.reason }]">{{ row.reason ?? '可登记' }}</span></td>
            </tr></tbody>
          </table>
        </div>
        <div class="registration-bar"><span>仅登记元数据，不修改原文件</span><button :disabled="busy || !selectedRows.length" @click="register"><AppIcon name="check" />确认登记 {{ selectedRows.length }} 个文件</button></div>
      </template>

      <h3 class="subheading">已登记版本与文件</h3>
      <p v-if="!graph.nodes.length">尚无版本节点。请扫描、预览并确认登记工程文件。</p>
      <ul class="version-list">
        <li v-for="node in graph.nodes" :key="node.id">
          <strong>{{ node.version }}</strong> · {{ node.releasedAt ? '已放行，文件引用锁定' : '未放行' }}
          <ul><li v-for="file in graph.files.filter(item => item.nodeId === node.id)" :key="file.id">
            <span>{{ file.relativePath }}</span>
            <button class="secondary icon-button" :disabled="busy" :aria-label="`检查文件 ${file.fileName}`" :title="`检查文件 ${file.fileName}`" @click="locate(file.relativePath)"><AppIcon name="scan" /></button>
          </li></ul>
        </li>
      </ul>

      <details class="rebind-details"><summary>高级操作 · 显式重绑文件引用</summary><form class="rebind-form" @submit.prevent="rebind">
        <p>先扫描新位置，再选择原引用与候选；仅同完整版本可重绑。已放行引用须先在后续版本图流程撤销放行。</p>
        <label for="rebind-file">原文件引用</label>
        <select id="rebind-file" v-model="rebindFile" :disabled="busy" required>
          <option value="">请选择原引用</option>
          <option v-for="file in graph.files" :key="file.id" :value="file.id">{{ file.relativePath }}</option>
        </select>
        <label for="rebind-path">扫描到的新文件</label>
        <select id="rebind-path" v-model="rebindPath" :disabled="busy" required>
          <option value="">请选择扫描候选</option>
          <option v-for="file in candidates" :key="file.relativePath" :value="file.relativePath">{{ file.relativePath }}</option>
        </select>
        <button :disabled="busy || !rebindFile || !rebindPath"><AppIcon name="refresh" />确认替换所选文件引用</button>
      </form></details>

      <h3 class="subheading">软件对比文档</h3>
      <p>用于存放软件版本对比说明。首版支持 .doc/.docx 格式，按项目列出，不关联版本。通过本机 Word 打开原文件将在 Launcher 集成后提供，当前不能直接打开。</p>
      <p v-if="!comparisonDocumentsScanned">尚未扫描软件对比文档目录。</p><p v-else-if="!comparisonDocuments.length">未找到支持的 .doc/.docx 软件对比文档。</p>
      <ul class="comparison-document-list"><li v-for="file in comparisonDocuments" :key="file.relativePath">{{ file.relativePath }}</li></ul>
    </template>
  </section>
</template>
