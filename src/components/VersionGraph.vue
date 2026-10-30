<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue';
import type { Branch, ProjectGraph, VersionNode } from '../domain/model';
import type { ArchiveRepository } from '../storage/database';
import { layoutDag, LAYOUT, type Point } from '../domain/layout';
import { planDeletion, type DeletionPlan } from '../domain/graph';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; projectId: string }>();
const emit = defineEmits<{ busy: [value: boolean] }>();

const graph = shallowRef<ProjectGraph>();
const error = ref('');
const status = ref('');
const saving = ref(false);
const errorHeading = ref<HTMLElement>();
const svgEl = ref<SVGSVGElement>();

const viewport = ref({ scale: 1, x: 40, y: 40 });
const selected = ref<string[]>([]);
const menu = ref<{ x: number; y: number; nodeId: string } | null>(null);
const panel = ref<'node-add' | 'node-edit' | 'branch-add' | 'branch-edit' | 'merge' | null>(null);

// Form state
const form = ref({
  version: '',
  description: '',
  parentIds: [] as string[],
  targetBranchId: '' as string | null,
  branchId: '' as string | null,
  branchName: '',
  branchDescription: '',
  branchColor: '#2563eb',
  deleteConfirmedVersion: '',
});

const layout = computed(() => (graph.value ? layoutDag(graph.value) : { positions: new Map<string, Point>(), width: 0, height: 0 }));
const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map(node => [node.id, node])));
const parentIdsOf = computed(() => {
  const map = new Map<string, string[]>();
  for (const node of graph.value?.nodes ?? []) map.set(node.id, []);
  for (const edge of graph.value?.edges ?? []) map.get(edge.childId)!.push(edge.parentId);
  return map;
});
const childIdsOf = computed(() => {
  const map = new Map<string, string[]>();
  for (const node of graph.value?.nodes ?? []) map.set(node.id, []);
  for (const edge of graph.value?.edges ?? []) map.get(edge.parentId)!.push(edge.childId);
  return map;
});
const branchHeads = computed(() => {
  const map = new Map<string, Branch[]>();
  for (const branch of graph.value?.branches ?? []) {
    const list = map.get(branch.headId) ?? [];
    list.push(branch);
    map.set(branch.headId, list);
  }
  return map;
});
const selectedNode = computed(() => {
  if (selected.value.length !== 1) return undefined;
  return nodeById.value.get(selected.value[0]!);
});
const selectedSet = computed(() => new Set(selected.value));
const editingBranch = computed(() => (form.value.branchId ? graph.value?.branches.find(item => item.id === form.value.branchId) : undefined));

function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '图操作失败，请重试。';
  status.value = '';
  void nextTick(() => errorHeading.value?.focus());
}

async function operation(action: () => Promise<void>) {
  saving.value = true; emit('busy', true); error.value = ''; status.value = '';
  try { await action(); } catch (cause) { showError(cause); }
  finally { saving.value = false; emit('busy', false); }
}

async function refresh() {
  await operation(async () => {
    graph.value = await props.repository.get(props.projectId);
    selected.value = [];
    menu.value = null;
    panel.value = null;
  });
}

function centerViewport() {
  const target = graph.value;
  if (!target || !svgEl.value) return;
  const rect = svgEl.value.getBoundingClientRect();
  const l = layout.value;
  const scale = Math.min(1, Math.max(0.2, (rect.width - 80) / Math.max(l.width, 1), (rect.height - 80) / Math.max(l.height, 1)));
  viewport.value = { scale, x: 40, y: 40 };
}

function zoomBy(factor: number) {
  const next = Math.min(3, Math.max(0.2, viewport.value.scale * factor));
  viewport.value = { ...viewport.value, scale: next };
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const rect = svgEl.value!.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const factor = event.deltaY < 0 ? 1.1 : 0.9;
  const scale = Math.min(3, Math.max(0.2, viewport.value.scale * factor));
  const k = scale / viewport.value.scale;
  viewport.value = {
    scale,
    x: px - (px - viewport.value.x) * k,
    y: py - (py - viewport.value.y) * k,
  };
}

let panning = false;
let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
function onCanvasPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  panning = true;
  panStart = { x: event.clientX, y: event.clientY, vx: viewport.value.x, vy: viewport.value.y };
  (event.target as Element).setPointerCapture?.(event.pointerId);
}
function onCanvasPointerMove(event: PointerEvent) {
  if (!panning) return;
  viewport.value = {
    ...viewport.value,
    x: panStart.vx + (event.clientX - panStart.x),
    y: panStart.vy + (event.clientY - panStart.y),
  };
}
function onCanvasPointerUp() { panning = false; }

function selectNode(nodeId: string, additive: boolean) {
  if (additive) {
    selected.value = selected.value.includes(nodeId)
      ? selected.value.filter(id => id !== nodeId)
      : [...selected.value, nodeId].slice(-2);
  } else {
    selected.value = [nodeId];
  }
  menu.value = null;
}

function openMenu(event: MouseEvent, nodeId: string) {
  event.preventDefault();
  if (!selected.value.includes(nodeId)) selected.value = [nodeId];
  const rect = svgEl.value!.getBoundingClientRect();
  menu.value = { x: event.clientX - rect.left, y: event.clientY - rect.top, nodeId };
}

function formatReleasedAt(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function branchLabelOffset(branch: Branch, index: number) {
  return { y: -12 - index * 20 };
}

function nodeCenter(id: string): Point {
  const p = layout.value.positions.get(id);
  if (!p) return { x: 0, y: 0 };
  return { x: p.x + LAYOUT.nodeWidth / 2, y: p.y + LAYOUT.nodeHeight / 2 };
}
function edgePath(parentId: string, childId: string): string {
  const a = nodeCenter(parentId);
  const b = nodeCenter(childId);
  const dx = Math.max(40, (b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function openNodeAdd() { resetForm(); form.value.parentIds = selected.value.slice(); panel.value = 'node-add'; }
function openNodeEdit() {
  const node = selectedNode.value;
  if (!node) return;
  resetForm();
  form.value.version = node.version;
  form.value.description = node.description;
  form.value.parentIds = parentIdsOf.value.get(node.id) ?? [];
  panel.value = 'node-edit';
}
function openMerge() {
  resetForm();
  form.value.parentIds = selected.value.slice();
  panel.value = 'merge';
}
function openBranchAdd() {
  resetForm();
  form.value.branchName = '';
  form.value.branchColor = '#2563eb';
  panel.value = 'branch-add';
}
function openBranchEdit(branchId: string) {
  const branch = graph.value?.branches.find(item => item.id === branchId);
  if (!branch) return;
  resetForm();
  form.value.branchId = branch.id;
  form.value.branchName = branch.name;
  form.value.branchDescription = branch.description;
  form.value.branchColor = branch.color;
  panel.value = 'branch-edit';
}
function resetForm() {
  form.value = {
    version: '', description: '', parentIds: [], targetBranchId: null,
    branchId: null, branchName: '', branchDescription: '', branchColor: '#2563eb',
    deleteConfirmedVersion: '',
  };
}

function buildNode(): VersionNode {
  const project = graph.value!.project;
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    version: form.value.version.trim(),
    description: form.value.description.trim(),
    taskId: null,
    releasedAt: null,
  };
}

async function submitNode() {
  await operation(async () => {
    const g = graph.value!;
    if (panel.value === 'node-add') {
      graph.value = await props.repository.addNode(props.projectId, g.project.revision, buildNode(), form.value.parentIds, form.value.targetBranchId);
      status.value = '节点已新增。';
    } else if (panel.value === 'node-edit') {
      const node = selectedNode.value!;
      graph.value = await props.repository.saveNode(props.projectId, g.project.revision, node.id, {
        version: form.value.version,
        description: form.value.description,
      });
      status.value = '节点已更新。';
    } else if (panel.value === 'merge') {
      graph.value = await props.repository.merge(props.projectId, g.project.revision, buildNode(), form.value.parentIds, form.value.targetBranchId!);
      status.value = '合并版本已创建。';
    }
    panel.value = null;
  });
}

async function submitBranch() {
  await operation(async () => {
    const g = graph.value!;
    if (panel.value === 'branch-add') {
      const project = g.project;
      const branch: Branch = {
        id: crypto.randomUUID(), projectId: project.id, name: form.value.branchName.trim(),
        description: form.value.branchDescription.trim(), color: form.value.branchColor, headId: selected.value[0]!,
      };
      graph.value = await props.repository.addBranch(props.projectId, g.project.revision, branch);
      status.value = '分支已创建。';
    } else if (panel.value === 'branch-edit') {
      graph.value = await props.repository.saveBranch(props.projectId, g.project.revision, form.value.branchId!, {
        name: form.value.branchName,
        description: form.value.branchDescription,
        color: form.value.branchColor,
      });
      status.value = '分支已更新。';
    }
    panel.value = null;
  });
}

const deletionPlan = ref<DeletionPlan | null>(null);
const deletionBranchTargets = ref<Record<string, string | null>>({});
const deletionNodeId = computed(() => deletionPlan.value?.nodeId ?? '');
function openDelete() {
  const node = selectedNode.value;
  if (!node) return;
  deletionPlan.value = planDeletion(graph.value!, node.id);
  deletionBranchTargets.value = Object.fromEntries(
    (graph.value?.branches ?? []).filter(branch => branch.headId === node.id).map(branch => [branch.id, null]),
  );
  form.value.deleteConfirmedVersion = '';
}

async function confirmDelete() {
  const plan = deletionPlan.value;
  if (!plan) return;
  await operation(async () => {
    const g = graph.value!;
    graph.value = await props.repository.deleteNode(props.projectId, g.project.revision, { ...plan, branchHeads: deletionBranchTargets.value }, form.value.deleteConfirmedVersion || null);
    status.value = '节点已删除，关系已重连。';
    deletionPlan.value = null;
    selected.value = [];
  });
}

async function toggleRelease() {
  const node = selectedNode.value;
  if (!node) return;
  await operation(async () => {
    const g = graph.value!;
    graph.value = node.releasedAt
      ? await props.repository.revoke(props.projectId, g.project.revision, node.id)
      : await props.repository.release(props.projectId, g.project.revision, node.id);
    status.value = node.releasedAt ? '放行已撤销。' : '节点及全部祖先已放行。';
  });
}

watch(() => props.projectId, () => { void refresh(); });
onMounted(() => { void refresh(); });
watch(layout, () => { if (graph.value && !panning) centerViewport(); });
</script>

<template>
  <section class="panel graph-workspace" aria-labelledby="graph-title" :aria-busy="saving">
    <div class="section-heading">
      <div><p class="eyebrow">VERSION GRAPH</p><h2 id="graph-title">版本分支图</h2></div>
      <div class="actions">
        <button class="secondary icon-button" :disabled="saving" aria-label="缩小" title="缩小" @click="zoomBy(0.8)"><AppIcon name="zoom-out" /></button>
        <button class="secondary icon-button" :disabled="saving" aria-label="放大" title="放大" @click="zoomBy(1.25)"><AppIcon name="zoom-in" /></button>
        <button class="secondary icon-button" :disabled="saving" aria-label="适应视图" title="适应视图" @click="centerViewport"><AppIcon name="fit" /></button>
        <button class="secondary icon-button" :disabled="saving" aria-label="重新读取图" title="重新读取图" @click="refresh"><AppIcon name="refresh" /></button>
      </div>
    </div>

    <div v-if="error" role="alert" class="error"><h3 ref="errorHeading" tabindex="-1">图操作未完成</h3><p>{{ error }}</p></div>
    <p role="status" class="status">{{ status }}</p>

    <div v-if="graph" class="graph-meta">
      <span><strong>{{ graph.project.name }}</strong> · 零件号 <code>{{ graph.project.partNumber }}</code></span>
      <span class="count">{{ graph.nodes.length }} 个版本 · {{ graph.branches.length }} 个分支</span>
    </div>

    <div v-if="graph" class="graph-toolbar">
      <div class="actions">
        <button :disabled="saving || (selected.length !== 1 && graph.nodes.length !== 0)" @click="openNodeAdd"><AppIcon name="plus" />{{ graph.nodes.length === 0 ? '新增根版本' : '新增子版本' }}</button>
        <button class="secondary" :disabled="saving || selected.length !== 1" @click="openNodeEdit"><AppIcon name="edit" />编辑</button>
        <button class="secondary" :disabled="saving || selected.length < 2" @click="openMerge"><AppIcon name="merge" />合并</button>
        <button class="secondary" :disabled="saving || selected.length !== 1" @click="toggleRelease"><AppIcon :name="selectedNode?.releasedAt ? 'unrelease' : 'release'" />{{ selectedNode?.releasedAt ? '撤销放行' : '放行' }}</button>
        <button class="secondary" :disabled="saving || selected.length !== 1" @click="openDelete"><AppIcon name="trash" />删除</button>
      </div>
      <div class="actions">
        <button class="secondary" :disabled="saving || selected.length !== 1" @click="openBranchAdd"><AppIcon name="branch" />建分支于所选</button>
      </div>
      <span role="status" class="selection-count">已选 {{ selected.length }} / {{ graph.nodes.length }} 个版本（Ctrl/Cmd 点击加选）</span>
    </div>

    <div v-if="graph" class="graph-layout">
      <svg
        ref="svgEl"
        class="graph-svg"
        role="application"
        aria-label="版本分支图画布"
        @wheel.prevent="onWheel"
        @pointerdown="onCanvasPointerDown"
        @pointermove="onCanvasPointerMove"
        @pointerup="onCanvasPointerUp"
        @pointercancel="onCanvasPointerUp"
      >
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10Z" fill="#6b84a1" />
          </marker>
        </defs>
        <g :transform="`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`">
          <g v-for="edge in graph.edges" :key="edge.id">
            <path :d="edgePath(edge.parentId, edge.childId)" class="graph-edge" :marker-end="'url(#graph-arrow)'" />
          </g>

          <g v-for="node in graph.nodes" :key="node.id">
            <!-- branch head labels -->
            <g v-for="(branch, index) in branchHeads.get(node.id) ?? []" :key="branch.id" class="graph-branch-label" :transform="`translate(${layout.positions.get(node.id)!.x + 8} ${layout.positions.get(node.id)!.y + branchLabelOffset(branch, index).y})`">
              <rect :width="Math.max(56, branch.name.length * 12 + 20)" height="18" rx="4" :fill="branch.color" />
              <text x="10" y="13" class="graph-branch-text">{{ branch.name }}</text>
            </g>

            <g
              class="graph-node"
              :class="{ selected: selectedSet.has(node.id), released: node.releasedAt }"
              :transform="`translate(${layout.positions.get(node.id)!.x} ${layout.positions.get(node.id)!.y})`"
              role="button"
              tabindex="0"
              :title="node.description || undefined"
              :aria-label="`版本 ${node.version}${node.releasedAt ? '，已放行' : '，未放行'}`"
              @click="selectNode(node.id, $event.ctrlKey || $event.metaKey)"
              @keydown.enter.prevent="selectNode(node.id, $event.ctrlKey || $event.metaKey)"
              @keydown.space.prevent="selectNode(node.id, $event.ctrlKey || $event.metaKey)"
              @contextmenu="openMenu($event, node.id)"
            >
              <rect width="200" height="56" rx="10" class="graph-node-box" />
              <text :x="LAYOUT.nodeWidth / 2" y="24" text-anchor="middle" class="graph-node-version">{{ node.version }}</text>
              <text :x="LAYOUT.nodeWidth / 2" y="43" text-anchor="middle" class="graph-node-state">{{ node.releasedAt ? '已放行' : '未放行' }}</text>
            </g>
          </g>
        </g>
      </svg>

      <div v-if="menu" class="graph-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu" :aria-label="`节点 ${menu.nodeId} 菜单`">
        <button role="menuitem" :disabled="saving" @click="selected = [menu.nodeId]; openNodeEdit(); menu = null"><AppIcon name="edit" />编辑节点</button>
        <button role="menuitem" :disabled="saving" @click="selected = [menu.nodeId]; openDelete(); menu = null"><AppIcon name="trash" />删除节点</button>
        <button role="menuitem" :disabled="saving" @click="selected = [menu.nodeId]; openBranchAdd(); menu = null"><AppIcon name="branch" />建分支于此</button>
      </div>

      <aside v-if="selectedNode" class="graph-detail" aria-label="节点详情">
        <p class="eyebrow">NODE DETAIL</p>
        <h3>{{ selectedNode.version }}</h3>
        <p class="form-help">{{ selectedNode.description || '（无改动说明）' }}</p>
        <p class="workspace-details">状态：{{ selectedNode.releasedAt ? '已放行' : '未放行' }}<span v-if="selectedNode.releasedAt"> · {{ formatReleasedAt(selectedNode.releasedAt) }}</span></p>
        <p class="workspace-details">父节点：{{ (parentIdsOf.get(selectedNode.id) ?? []).map(id => nodeById.get(id)?.version ?? id).join('、') || '无（根节点）' }}</p>
        <p class="workspace-details">子节点：{{ (childIdsOf.get(selectedNode.id) ?? []).map(id => nodeById.get(id)?.version ?? id).join('、') || '无' }}</p>
        <div v-if="(branchHeads.get(selectedNode.id) ?? []).length" class="workspace-details">
          <p>分支头：</p>
          <ul class="graph-branch-list">
            <li v-for="branch in branchHeads.get(selectedNode.id) ?? []" :key="branch.id">
              <span class="graph-branch-swatch" :style="{ background: branch.color }" aria-hidden="true"></span>
              <span>{{ branch.name }}</span>
              <button class="secondary icon-button" :disabled="saving" :aria-label="`编辑分支 ${branch.name}`" :title="`编辑分支 ${branch.name}`" @click="openBranchEdit(branch.id)"><AppIcon name="edit" /></button>
            </li>
          </ul>
        </div>
      </aside>

      <aside v-else-if="(graph.branches ?? []).length" class="graph-detail" aria-label="分支图例">
        <p class="eyebrow">BRANCHES</p>
        <ul class="graph-branch-list">
          <li v-for="branch in graph.branches" :key="branch.id">
            <span class="graph-branch-swatch" :style="{ background: branch.color }" aria-hidden="true"></span>
            <span>{{ branch.name }}<span class="form-help">（头：{{ nodeById.get(branch.headId)?.version ?? '未知' }}）</span></span>
            <button class="secondary icon-button" :disabled="saving" :aria-label="`编辑分支 ${branch.name}`" :title="`编辑分支 ${branch.name}`" @click="openBranchEdit(branch.id)"><AppIcon name="edit" /></button>
          </li>
        </ul>
      </aside>
    </div>

    <p v-else class="empty">正在读取版本图…</p>

    <!-- Node add/edit/merge form -->
    <div v-if="panel === 'node-add' || panel === 'node-edit' || panel === 'merge'" class="graph-form" role="dialog" aria-modal="false" :aria-label="panel === 'merge' ? '合并版本' : panel === 'node-add' ? (graph?.nodes.length ? '新增子版本' : '新增根版本') : '编辑节点'">
      <h3>{{ panel === 'merge' ? '合并版本' : panel === 'node-add' ? (graph?.nodes.length ? '新增子版本' : '新增根版本') : '编辑节点' }}</h3>
      <form @submit.prevent="submitNode">
        <label for="gf-version">版本号 <span>必填，含日期文本，连续空白归一且区分大小写唯一</span></label>
        <input id="gf-version" v-model="form.version" required :disabled="saving || (panel === 'node-edit' && !!selectedNode?.releasedAt)" placeholder="例如：1479-1 20260115" />
        <label for="gf-description">改动说明</label>
        <input id="gf-description" v-model="form.description" :disabled="saving" placeholder="本次版本改动说明" />
        <label>父节点 <span>{{ panel === 'merge' ? '合并需至少两个不同父节点' : '留空则创建根版本，可多选以创建合并节点' }}</span></label>
        <div class="graph-parent-picker">
          <label v-for="node in graph?.nodes ?? []" :key="node.id" class="graph-parent-option">
            <input v-model="form.parentIds" type="checkbox" :value="node.id" :disabled="saving" />{{ node.version }}
          </label>
        </div>
        <label for="gf-branch">推进目标分支 <span>可选；合并/推进时须包含目标分支当前头</span></label>
        <select id="gf-branch" v-model="form.targetBranchId" :disabled="saving">
          <option :value="null">不推进分支</option>
          <option v-for="branch in graph?.branches ?? []" :key="branch.id" :value="branch.id">{{ branch.name }}（头 {{ nodeById.get(branch.headId)?.version ?? '未知' }}）</option>
        </select>
        <div class="actions">
          <button type="submit" :disabled="saving"><AppIcon name="check" />{{ panel === 'merge' ? '创建合并版本' : '保存节点' }}</button>
          <button type="button" class="secondary" :disabled="saving" @click="panel = null"><AppIcon name="clear" />取消</button>
        </div>
      </form>
    </div>

    <!-- Branch form -->
    <div v-if="panel === 'branch-add' || panel === 'branch-edit'" class="graph-form" role="dialog" aria-modal="false" :aria-label="panel === 'branch-add' ? '创建分支' : '编辑分支'">
      <h3>{{ panel === 'branch-add' ? '创建分支' : '编辑分支' }}</h3>
      <form @submit.prevent="submitBranch">
        <label for="gb-name">分支名称 <span>必填</span></label>
        <input id="gb-name" v-model="form.branchName" required :disabled="saving" />
        <label for="gb-desc">分支说明</label>
        <input id="gb-desc" v-model="form.branchDescription" :disabled="saving" />
        <label for="gb-color">分支颜色 <span>六位十六进制，供图例与线条使用</span></label>
        <input id="gb-color" v-model="form.branchColor" type="color" :disabled="saving" />
        <div class="actions">
          <button type="submit" :disabled="saving || (panel === 'branch-add' && selected.length !== 1)"><AppIcon name="check" />{{ panel === 'branch-add' ? '创建分支' : '保存分支' }}</button>
          <button type="button" class="secondary" :disabled="saving" @click="panel = null"><AppIcon name="clear" />取消</button>
        </div>
      </form>
    </div>

    <!-- Deletion preview -->
    <div v-if="deletionPlan" class="graph-form" role="dialog" aria-modal="false" aria-label="删除预览">
      <h3>删除节点 · 预览重连</h3>
      <p class="form-help">删除后，每个直接子节点将以被删节点的全部父节点替换该父边并去重；已放行子节点不能被重连。</p>
      <p v-if="selectedNode?.releasedAt" class="form-help error">该节点已放行，需输入其版本号确认删除。</p>
      <label for="gd-version">确认版本号 <span v-if="selectedNode?.releasedAt">必填</span></label>
      <input id="gd-version" v-model="form.deleteConfirmedVersion" :required="!!selectedNode?.releasedAt" :disabled="saving" />
      <p v-if="(graph?.branches ?? []).some(branch => branch.headId === deletionNodeId)" class="form-help">受影响分支须明确设置新头或删除：</p>
      <div v-for="branch in (graph?.branches ?? []).filter(branch => branch.headId === deletionNodeId)" :key="branch.id" class="graph-parent-picker">
        <label :for="`gb-head-${branch.id}`">{{ branch.name }} 的新头</label>
        <select :id="`gb-head-${branch.id}`" v-model="deletionBranchTargets[branch.id]" :disabled="saving">
          <option :value="null">删除分支记录</option>
          <option v-for="node in graph?.nodes.filter(node => node.id !== deletionNodeId) ?? []" :key="node.id" :value="node.id">{{ node.version }}</option>
        </select>
      </div>
      <div class="actions">
        <button :disabled="saving" @click="confirmDelete"><AppIcon name="check" />确认删除并重连</button>
        <button class="secondary" :disabled="saving" @click="deletionPlan = null"><AppIcon name="clear" />取消</button>
      </div>
    </div>
  </section>
</template>
