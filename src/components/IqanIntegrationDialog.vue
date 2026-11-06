<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import type { ProjectGraph, VersionNode } from '../domain/model';
import { matchScannedFiles, type FileCandidate } from '../domain/filenames';
import { checkPermission, fileOperationErrorMessage, locateFile, scanDirectory, type DirectoryHandle } from '../files/directories';
import type { ArchiveRepository } from '../storage/database';
import { buildCompareUri, buildOpenUri } from '../domain/iqan-protocol';

type Action = 'open' | 'compare';

const props = defineProps<{
  graph: ProjectGraph;
  repository: ArchiveRepository;
  projectId: string;
}>();
const emit = defineEmits<{ closed: []; status: [message: string] }>();

const dialog = ref<HTMLDialogElement>();
const action = ref<Action>('open');
const orderedNodeIds = ref<string[]>([]);
const candidatesByNode = ref<Record<string, FileCandidate[]>>({});
const selectedPaths = ref<string[]>([]);
const directoryName = ref('');
const snapshotRevision = ref<number>();
const snapshotPartNumber = ref('');
const snapshotNodes = ref<VersionNode[]>([]);
const busy = ref(false);
const scanCount = ref(0);
const error = ref('');
const status = ref('');
const preparedUri = ref('');
let controller: AbortController | undefined;

const title = () => action.value === 'open' ? '在 IQANdesign 中打开' : '对比所选版本';
const selectedNodes = () => orderedNodeIds.value.map(id => snapshotNodes.value.find(node => node.id === id)!);

function invalidatePreparedRequest() {
  preparedUri.value = '';
  status.value = '';
}

watch(selectedPaths, invalidatePreparedRequest, { deep: true });
watch(() => props.graph.project.revision, revision => {
  if (snapshotRevision.value !== undefined && revision !== snapshotRevision.value) {
    invalidatePreparedRequest();
    error.value = '项目版本图已变化，旧预览已失效。请关闭并重新选择版本。';
  }
});

function validateSelection(graph: ProjectGraph, nodeIds: readonly string[], targetAction: Action): VersionNode[] {
  const expectedCount = targetAction === 'open' ? 1 : 2;
  if (nodeIds.length !== expectedCount) {
    throw new Error(targetAction === 'open' ? '打开需要一个版本节点。' : '对比需要两个不同的版本节点。');
  }
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error('不能重复选择同一个版本节点。');
  const nodes = nodeIds.map(id => graph.nodes.find(node => node.id === id));
  return nodes.map(node => {
    if (!node) throw new Error('所选版本已不存在，请重新选择。');
    if (node.projectId !== graph.project.id) throw new Error('只能操作同一项目中的版本。');
    return node;
  });
}

async function getEngineeringBinding(): Promise<{ handle: DirectoryHandle; name: string }> {
  const binding = await props.repository.db.directoryBindings.get([props.projectId, 'engineering']);
  if (!binding) throw new Error('当前项目尚未绑定工程目录。请前往“项目文件”绑定并授权工程目录。');
  if (!await checkPermission(binding.handle)) {
    throw new Error('工程目录读取授权已失效。请前往“项目文件”重新授权后再试。');
  }
  return { handle: binding.handle, name: binding.handle.name };
}

async function scanEngineeringDirectory(handle: DirectoryHandle, signal: AbortSignal): Promise<FileCandidate[]> {
  scanCount.value = 0;
  return scanDirectory(handle, 'engineering', signal, count => { scanCount.value = count; });
}

async function open(targetAction: Action, nodeIds: readonly string[]) {
  if (busy.value) return;
  action.value = targetAction;
  orderedNodeIds.value = [...nodeIds];
  candidatesByNode.value = {};
  selectedPaths.value = [];
  directoryName.value = '';
  snapshotRevision.value = undefined;
  snapshotNodes.value = [];
  preparedUri.value = '';
  error.value = '';
  status.value = '';
  controller?.abort();
  const operationController = new AbortController();
  controller = operationController;
  let autoRequest = false;
  emit('status', '正在检查工程文件，请稍候…');
  busy.value = true;

  try {
    const graph = await props.repository.get(props.projectId);
    if (props.graph.project.revision !== graph.project.revision) {
      throw new Error('项目版本图刚刚发生变化，请重新选择版本后再试。');
    }
    const nodes = validateSelection(graph, nodeIds, targetAction);
    const binding = await getEngineeringBinding();
    const candidates = await scanEngineeringDirectory(binding.handle, operationController.signal);
    const latestGraph = await props.repository.get(props.projectId);
    if (latestGraph.project.revision !== graph.project.revision) {
      throw new Error('扫描期间项目版本图已变化，请重新选择版本后再试。');
    }
    const latestNodes = validateSelection(latestGraph, nodeIds, targetAction);
    const matches = matchScannedFiles(latestGraph, candidates).matches;
    const grouped: Record<string, FileCandidate[]> = {};
    for (const node of latestNodes) {
      const files = matches.get(node.id) ?? [];
      if (!files.length) throw new Error(`没有找到版本“${node.version}”对应的工程文件。请检查零件号、目录和扫描结果。`);
      grouped[node.id] = files;
    }

    snapshotRevision.value = latestGraph.project.revision;
    snapshotPartNumber.value = latestGraph.project.partNumber;
    snapshotNodes.value = latestNodes;
    candidatesByNode.value = grouped;
    selectedPaths.value = latestNodes.map(node => grouped[node.id]!.length === 1 ? grouped[node.id]![0]!.relativePath : '');
    directoryName.value = binding.name;
    await nextTick();
    operationController.signal.throwIfAborted();
    autoRequest = selectedPaths.value.every(path => !!path);
    if (!autoRequest) {
      error.value = '存在多个匹配文件，请为每个版本明确选择一个工程文件后请求启动器。';
      dialog.value?.showModal();
      dialog.value?.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true });
    }
  } catch (cause) {
    if (!operationController.signal.aborted) {
      error.value = fileOperationErrorMessage(cause);
      dialog.value?.showModal();
    }
  } finally {
    busy.value = false;
    controller = undefined;
    emit('status', '');
  }
  if (autoRequest && !operationController.signal.aborted) await prepareRequest(true);
}

function swapOrder() {
  if (action.value !== 'compare') return;
  orderedNodeIds.value = [...orderedNodeIds.value].reverse();
  selectedPaths.value = [...selectedPaths.value].reverse();
  invalidatePreparedRequest();
}

async function prepareRequest(requestImmediately = false) {
  if (busy.value) return;
  error.value = '';
  status.value = '';
  preparedUri.value = '';
  busy.value = true;
  emit('status', '正在重新检查工程文件，请稍候…');
  const operationController = new AbortController();
  controller = operationController;

  try {
    const current = await props.repository.get(props.projectId);
    if (current.project.revision !== snapshotRevision.value || current.project.partNumber !== snapshotPartNumber.value) {
      throw new Error('项目版本图或零件号已变化，预览已失效。请关闭并重新选择版本。');
    }
    const nodes = validateSelection(current, orderedNodeIds.value, action.value);
    if (nodes.some(node => node.version !== snapshotNodes.value.find(snapshot => snapshot.id === node.id)?.version)) {
      throw new Error('所选版本信息已变化，请重新选择版本。');
    }
    if (selectedPaths.value.length !== nodes.length || selectedPaths.value.some(path => !path)) {
      throw new Error('请为每个版本明确选择一个工程文件。');
    }

    const binding = await getEngineeringBinding();
    if (binding.name !== directoryName.value) throw new Error('工程目录绑定已变化，旧预览已失效。请重新扫描。');
    const candidates = await scanEngineeringDirectory(binding.handle, operationController.signal);
    const latestGraph = await props.repository.get(props.projectId);
    if (latestGraph.project.revision !== snapshotRevision.value || latestGraph.project.partNumber !== snapshotPartNumber.value) {
      throw new Error('扫描期间项目版本图已变化，预览已失效。请关闭并重新选择版本。');
    }
    const latestNodes = validateSelection(latestGraph, orderedNodeIds.value, action.value);
    if (latestNodes.some(node => node.version !== snapshotNodes.value.find(snapshot => snapshot.id === node.id)?.version)) {
      throw new Error('扫描期间所选版本信息已变化，请重新选择版本。');
    }
    const matches = matchScannedFiles(latestGraph, candidates).matches;
    for (const [index, node] of latestNodes.entries()) {
      const path = selectedPaths.value[index]!;
      if (!matches.get(node.id)?.some(candidate => candidate.relativePath === path)) {
        throw new Error(`文件“${path}”已不再匹配版本“${node.version}”，预览已失效。请重新选择。`);
      }
      await locateFile(binding.handle, path);
    }

    const finalGraph = await props.repository.get(props.projectId);
    if (finalGraph.project.revision !== snapshotRevision.value || finalGraph.project.partNumber !== snapshotPartNumber.value) {
      throw new Error('文件检查期间项目已变化，请关闭并重新选择版本。');
    }
    operationController.signal.throwIfAborted();
    preparedUri.value = action.value === 'open'
      ? buildOpenUri(latestGraph.project.id, binding.name, selectedPaths.value[0]!)
      : buildCompareUri(latestGraph.project.id, binding.name, selectedPaths.value[0]!, selectedPaths.value[1]!);
    status.value = '文件已重新扫描并定位。点击下方链接后，浏览器将请求打开本地启动器。';
    if (requestImmediately) {
      window.location.assign(preparedUri.value);
      if (dialog.value?.open) dialog.value.close();
      emit('status', '已请求本地启动器，请查看系统提示。网页无法确认启动结果；若没有出现系统提示，请检查 Launcher 安装及浏览器外部应用权限后重新发起操作。');
    } else {
      emit('status', '');
    }
  } catch (cause) {
    if (!operationController.signal.aborted) {
      error.value = fileOperationErrorMessage(cause);
      dialog.value?.showModal();
      emit('status', '');
    }
  } finally {
    busy.value = false;
    controller = undefined;
  }
}

function markRequested() {
  status.value = '已请求本地启动器，请查看系统提示。网页无法确认启动器是否已安装、IQANdesign 是否启动或操作是否完成。';
  emit('status', status.value);
}

function cancelDialog(event: Event) {
  if (busy.value) event.preventDefault();
}

function closeDialog() {
  controller?.abort();
  controller = undefined;
  error.value = '';
  status.value = '';
  preparedUri.value = '';
  emit('closed');
}

defineExpose({ open });
onUnmounted(() => controller?.abort());
</script>

<template>
  <dialog ref="dialog" class="iqan-integration-dialog" :aria-busy="busy" aria-labelledby="iqan-dialog-title" @cancel="cancelDialog" @close="closeDialog">
    <header class="iqan-dialog-header">
      <div>
        <p class="eyebrow">LOCAL IQANDESIGN</p>
        <h2 id="iqan-dialog-title">{{ title() }}</h2>
      </div>
      <button type="button" class="secondary icon-button" :disabled="busy" aria-label="关闭本地操作预览" title="关闭预览" @click="dialog?.close()">
        <span aria-hidden="true">×</span>
      </button>
    </header>

    <p class="form-help">选择与检查只在本次页面会话中进行，不写入项目、JSON 或版本关系。网页不会读取工程二进制内容。</p>

    <p v-if="busy" role="status" class="integration-status">正在检查项目并扫描工程目录，已枚举 {{ scanCount }} 个条目…</p>
    <template v-else-if="snapshotNodes.length">
      <div v-if="action === 'compare'" class="comparison-order">
        <span>文件 A / 文件 B 顺序由你确认，网页不推断基准或目标。</span>
        <button type="button" class="secondary" :disabled="busy" @click="swapOrder">交换 A / B</button>
      </div>

      <p class="directory-caption">工程目录名：<code>{{ directoryName }}</code>（仅目录名，非完整路径）</p>
      <div class="integration-files">
        <label v-for="(node, index) in selectedNodes()" :key="node.id" class="integration-file">
          <span>
            <strong>{{ action === 'compare' ? `文件 ${index === 0 ? 'A' : 'B'}` : '工程文件' }} · {{ node.version }}</strong>
            <small>节点 {{ node.id.slice(0, 8) }} · {{ candidatesByNode[node.id]?.length ?? 0 }} 个匹配文件</small>
          </span>
          <select v-model="selectedPaths[index]" :disabled="busy" :aria-label="`${action === 'compare' ? `文件 ${index === 0 ? 'A' : 'B'}` : '打开'}：${node.version} 工程文件`">
            <option value="">请选择一个工程文件</option>
            <option v-for="candidate in candidatesByNode[node.id]" :key="candidate.relativePath" :value="candidate.relativePath">
              {{ candidate.fileName }} · {{ candidate.relativePath }}
            </option>
          </select>
        </label>
      </div>

      <p class="form-help">IQANdesign 手册只给出 .idax 对比示例；其他扩展名的兼容性尚未核实。Launcher 会在本机重新校验文件并要求确认。</p>
    </template>

    <p v-if="error" role="alert" class="integration-error">{{ error }}</p>
    <p v-if="status" role="status" class="integration-status">{{ status }}</p>

    <div class="integration-actions">
      <button type="button" class="secondary" :disabled="busy" @click="dialog?.close()">取消</button>
      <button v-if="snapshotNodes.length" type="button" :disabled="busy || selectedPaths.some(path => !path)" @click="prepareRequest(true)">
        {{ busy ? '检查中…' : '检查并请求 Launcher' }}
      </button>
      <a v-if="preparedUri" class="integration-launch-link" :href="preparedUri" @click="markRequested">
        {{ action === 'open' ? '请求 Launcher 打开工程' : '请求 Launcher 对比工程' }}
      </a>
    </div>

    <aside class="integration-fallback">
      <strong>启动器状态未知</strong>
      <p>网页无法检测 Launcher 是否已安装，也收不到启动或对比结果。若未出现系统提示，请确认安装时勾选了协议集成；也可在 IQANdesign 中手动选择所列文件并执行相应操作。文件不会上传或自动合并。</p>
    </aside>
  </dialog>
</template>

<style scoped>
.iqan-integration-dialog {
  width: min(680px, calc(100vw - 32px));
  max-height: min(760px, calc(100dvh - 32px));
  overflow: auto;
  padding: 22px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 24px 70px #020617aa;
}
.iqan-integration-dialog::backdrop { background: #020617bb; }
.iqan-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.iqan-dialog-header h2 { margin: 0; }
.iqan-dialog-header .eyebrow { margin-bottom: 6px; }
.iqan-dialog-header .icon-button { font-size: 24px; }
.integration-files { display: grid; gap: 14px; margin: 20px 0; }
.integration-file { display: grid; gap: 8px; margin: 0; }
.integration-file > span { display: grid; gap: 4px; }
.integration-file strong { font-size: 13px; }
.integration-file small { color: var(--muted); font-weight: 400; }
.directory-caption { margin: 16px 0 0; color: var(--muted); font-size: 12px; }
.directory-caption code { color: var(--ink); overflow-wrap: anywhere; }
.integration-file select { margin: 0; font-family: ui-monospace, Consolas, monospace; }
.comparison-order { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; color: var(--muted); font-size: 12px; }
.integration-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.integration-launch-link { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: 10px 16px; border-radius: 8px; background: var(--primary); color: #fff; font-size: 13px; font-weight: 600; text-decoration: none; }
.integration-launch-link:hover { background: var(--primary-hover); }
.integration-launch-link:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
.integration-status, .integration-error, .integration-fallback { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); font-size: 12px; line-height: 1.65; }
.integration-error { border-color: #9f3d48; color: var(--danger); }
.integration-fallback { margin-top: 18px; border-left: 3px solid var(--warning); }
.integration-fallback strong { color: var(--ink); }
.integration-fallback p { margin: 6px 0 0; color: var(--muted); }
@media (max-width: 520px) {
  .iqan-integration-dialog { padding: 16px; }
  .comparison-order { align-items: flex-start; flex-direction: column; }
  .integration-actions > * { flex: 1 1 100%; }
}
</style>
