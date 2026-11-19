<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { liveQuery } from 'dexie';
import { ArchiveDatabase, ArchiveRepository, type SnapshotImportPlan } from './storage/database';
import type { Project, ProjectGraph } from './domain/model';
import { readProjectSnapshotFile, serializeProjectSnapshot } from './domain/project-snapshot';
import type { VersionOrder } from './domain/version-order';
import ProjectFiles from './components/ProjectFiles.vue';
const VersionGraph = defineAsyncComponent(() => import('./components/VersionGraph.vue'));
const ComparisonDocuments = defineAsyncComponent(() => import('./components/ComparisonDocuments.vue'));
const TaskBoard = defineAsyncComponent(() => import('./components/TaskBoard.vue'));
import ArchiveRootPanel from './components/ArchiveRootPanel.vue';
import BackendSettings from './components/BackendSettings.vue';
import CollaborationPanel from './components/CollaborationPanel.vue';
import { CollaborationRepository } from './storage/collaboration';
import { startProjectPolling } from './storage/project-polling';
import { projectWriteBlockedReason } from './storage/repository-sync';
import AppIcon from './components/AppIcon.vue';
import AppBrandMark from './components/AppBrandMark.vue';
import { checkPermission, sameDirectory, type ArchiveRoots, type DirectoryHandle, type FileHandle } from './files/directories';
import { deleteProjectBackups, JSON_BACKUP_LOCATION, jsonBackupFileName, listImportJsonBackups, listProjectBackups, writeJsonBackup, writeSelectedJsonFile, type ProjectBackupList } from './files/archive-json';
import { parseWorkspaceLocation, projectOverlayPath, projectPath, type ProjectView } from './workspace-routes';

const db = new ArchiveDatabase();
const collaboration = new CollaborationRepository(new ArchiveRepository(db));
const repository = new ArchiveRepository(db, collaboration);
const canWrite = computed(() => collaboration.permissions.sharedWritable);
const canImport = computed(() => canWrite.value && collaboration.state.user?.role === 'admin');
const taskAccountId = computed(() => {
  const { authenticated, restoring, user } = collaboration.state;
  return authenticated && !restoring && user && !user.mustChangePassword ? user.id : null;
});
const route = useRoute();
const router = useRouter();
const isAccountRoute = computed(() => /^\/account\/(login|profile|security|members|sync)$/.test(route.path));
const assigneeRefreshKey = ref(0);
let lastRouteFullPath = route.fullPath;
const projects = ref<Project[]>([]);
const name = ref('');
const partNumber = ref('');
const editingProject = ref<Project | null>(null);
const editedPartNumber = ref('');
const editInput = ref<HTMLInputElement>();
const deletion = ref<ProjectGraph | null>(null);
const confirmedProjectName = ref('');
const deleteInput = ref<HTMLInputElement>();
const loading = ref(true);
const readFailed = ref(false);
const saving = ref(false);
const error = ref('');
const status = ref('');
const submitted = ref(false);
const activeProjectId = ref('');
const sharedWriteBlockedReason = computed(() => projectWriteBlockedReason(repository.permissions, activeProjectId.value));
const activeProject = computed(() => projects.value.find(project => project.id === activeProjectId.value) ?? null);
const projectsCollapsed = ref(false);
const filesPanelBusy = ref(false);
const documentsBusy = ref(false);
const archiveRoots = shallowRef<ArchiveRoots>({});
const archiveRootRevision = ref(0);
const filesBusy = computed(() => filesPanelBusy.value || documentsBusy.value);
const graphBusy = ref(false);
const taskBoardBusy = ref(false);
const graphRefreshBlocked = ref(false);
const taskRefreshBlocked = ref(false);
const view = ref<'files' | 'graph' | 'documents' | 'tasks'>('files');
const taskBoardTargetId = ref('');
const taskBoardDetailId = ref('');
const taskBoardOptionsOpen = ref(false);
const focusNodeId = ref('');
const graphPanelRoute = ref<string[]>([]);
const versionOrder = ref<VersionOrder>('newest');
const backupMenu = ref<HTMLDetailsElement | null>(null);
const backupMenuTrigger = ref<HTMLElement | null>(null);
const importConfirmButton = ref<HTMLButtonElement | null>(null);
const importPreview = shallowRef<{ graph: ProjectGraph; fileName: string; plan: SnapshotImportPlan; currentProjectId: string } | null>(null);
const importFiles = ref<FileHandle[]>([]);
const importFileName = ref('');
const importPicker = ref<HTMLDialogElement>();
const manualImportInput = ref<HTMLInputElement>();
const supportsSaveFilePicker = typeof window.showSaveFilePicker === 'function';
let manualImportProjectId = '';
const exportPicker = ref<HTMLDialogElement>();
const exportProjectId = ref('');
const backupManager = ref<HTMLDialogElement>();
const backupList = shallowRef<ProjectBackupList>({ backups: [], unrecognized: [] });
const selectedBackups = ref<string[]>([]);
const backupDeleteConfirming = ref(false);
const backupDeleteCancel = ref<HTMLButtonElement>();
const backupProjectId = ref('');
const backupRoot = shallowRef<DirectoryHandle>();
const nameError = computed(() => submitted.value && !name.value.trim());
const partError = computed(() => submitted.value && !partNumber.value.trim());
const workspaceBusy = computed(() => filesBusy.value || graphBusy.value || taskBoardBusy.value);
const pollProjectId = computed(() => !isAccountRoute.value && canWrite.value && !saving.value && !workspaceBusy.value
  && !editingProject.value && !deletion.value && !importPreview.value
  && !(view.value === 'graph' && graphRefreshBlocked.value)
  && !(view.value === 'tasks' && (taskRefreshBlocked.value || taskBoardOptionsOpen.value))
  ? activeProjectId.value : '');
const pollError = shallowRef<{ id: string; message: string }>();
const errorHeading = ref<HTMLElement | null>(null);
let subscription: { unsubscribe(): void } | undefined;
let collaborationSubscription: { unsubscribe(): void } | undefined;
let loadAttempt = 0;
let stopProjectPolling: (() => void) | undefined;

watch([activeProjectId, () => collaboration.state.authenticated], () => { pollError.value = undefined; });

async function checkActiveProject(signal: AbortSignal) {
  const id = pollProjectId.value;
  if (!id) return;
  const stillActive = () => !signal.aborted && pollProjectId.value === id;
  try {
    await collaboration.pollProject(id, stillActive, signal);
    if (stillActive()) pollError.value = undefined;
  } catch (cause) {
    if (stillActive()) pollError.value = { id, message: cause instanceof Error ? cause.message : '无法检查项目更新。' };
  }
}

function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '本地存储操作失败，请重试。';
  status.value = '';
  loading.value = false;
  void nextTick(() => errorHeading.value?.focus());
}

function receiveArchiveRoots(roots: ArchiveRoots) {
  if (roots.shared || roots.local) {
    console.info(`[archive-root] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'app-roots-received',
      sharedConfigured: Boolean(roots.shared),
      localConfigured: Boolean(roots.local),
    })}`);
  }
  archiveRoots.value = roots;
  archiveRootRevision.value++;
}

function openTaskBoard(taskId = '') {
  if (!activeProjectId.value) return;
  void router.push(taskId
    ? { path: projectPath(activeProjectId.value, 'tasks'), query: { focus: taskId } }
    : projectPath(activeProjectId.value, 'tasks'));
}

function openVersionFromTaskBoard(nodeId: string) {
  if (!activeProjectId.value) return;
  void router.push(projectPath(activeProjectId.value, 'graph', 'node', nodeId));
}

function openProjectGraph(projectId: string) {
  void router.push(projectPath(projectId, 'graph'));
}

function navigateProject(projectId: string, nextView: ProjectView) {
  void router.push(projectPath(projectId, nextView));
}

function openProjectTaskBoard(projectId: string) {
  void router.push(projectPath(projectId, 'tasks'));
}

function navigateTaskBoardChild(child: string[], action: 'push' | 'replace' | 'back' = 'push') {
  if (!activeProjectId.value) return;
  if (action === 'back') {
    const previous = window.history.state?.back;
    const previousPath = typeof previous === 'string' ? previous.split('?')[0] : '';
    if (previousPath === projectPath(activeProjectId.value, 'tasks')) {
      void router.back();
    } else {
      void router.replace(projectPath(activeProjectId.value, 'tasks'));
    }
    return;
  }
  const target = projectPath(activeProjectId.value, 'tasks', ...child);
  void router[action](target);
}

function navigateGraphPanel(child: string[], action: 'push' | 'replace' | 'back' = 'push') {
  if (!activeProjectId.value) return;
  const basePath = projectPath(activeProjectId.value, 'graph');
  if (action === 'back') {
    const previous = window.history.state?.back;
    if (typeof previous === 'string' && previous.includes(`${basePath}/panel`)) void router.back();
    else void router.replace(basePath);
    return;
  }
  const target = projectPath(activeProjectId.value, 'graph', ...(child.length ? ['panel', ...child] : []));
  void router[action](target);
}

function closeProjectOverlay() {
  if (!activeProjectId.value) return;
  const parentPath = projectPath(activeProjectId.value, view.value);
  const previous = window.history.state?.back;
  if (typeof previous === 'string' && previous.includes(`/projects/${encodeURIComponent(activeProjectId.value)}/`)) void router.back();
  else void router.replace(parentPath);
}

watch([() => route.fullPath, projects, loading], async ([fullPath]) => {
  const location = parseWorkspaceLocation(route.path);
  if (fullPath !== lastRouteFullPath && editingProject.value
    && editedPartNumber.value !== editingProject.value.partNumber
    && !(location.projectId === editingProject.value.id && location.overlay === 'edit')
    && !window.confirm('零件号修改尚未保存。放弃修改并切换路由吗？')) {
    void router.replace(lastRouteFullPath);
    return;
  }
  lastRouteFullPath = fullPath;
  if (isAccountRoute.value) return;
  if (!location.projectId) {
    activeProjectId.value = '';
    view.value = 'files';
    taskBoardTargetId.value = '';
    taskBoardDetailId.value = '';
    taskBoardOptionsOpen.value = false;
    focusNodeId.value = '';
    graphPanelRoute.value = [];
    editingProject.value = null;
    deletion.value = null;
    return;
  }
  if (loading.value) return;
  const project = projects.value.find(item => item.id === location.projectId);
  if (!project) {
    void router.replace('/');
    return;
  }
  activeProjectId.value = project.id;
  view.value = location.view;
  taskBoardTargetId.value = location.view === 'tasks' && typeof route.query.focus === 'string' ? route.query.focus : '';
  taskBoardDetailId.value = location.view === 'tasks'
    ? location.child[0] === 'detail' ? location.child[1] ?? '' : location.child[0] === 'new' ? 'new' : ''
    : '';
  taskBoardOptionsOpen.value = location.view === 'tasks' && location.child[0] === 'options';
  focusNodeId.value = location.view === 'graph' && location.child[0] === 'node' ? location.child[1] ?? '' : '';
  graphPanelRoute.value = location.view === 'graph' && location.child[0] === 'panel' ? location.child.slice(1) : [];
  if (location.overlay === 'edit') {
    if (editingProject.value?.id !== project.id || editedPartNumber.value === editingProject.value.partNumber) {
      editingProject.value = { ...project };
      editedPartNumber.value = project.partNumber;
    }
    deletion.value = null;
  } else if (location.overlay === 'delete') {
    editingProject.value = null;
    if (deletion.value?.project.id !== project.id) {
      try {
        deletion.value = await repository.get(project.id);
        confirmedProjectName.value = '';
      } catch (cause) {
        showError(cause);
        void router.replace(projectPath(project.id, location.view));
      }
    }
  } else {
    editingProject.value = null;
    deletion.value = null;
  }
}, { immediate: true });

watch(isAccountRoute, (isAccount, wasAccount) => {
  if (wasAccount && !isAccount) assigneeRefreshKey.value += 1;
});

async function watchProjects() {
  const attempt = ++loadAttempt;
  subscription?.unsubscribe();
  loading.value = true;
  readFailed.value = false;
  error.value = '';
  try {
    // liveQuery does not emit an error when the IndexedDB API itself is absent.
    await db.open();
    if (attempt !== loadAttempt) return;
    subscription = liveQuery(() => repository.listProjects()).subscribe({
      next: value => {
        projects.value = value; loading.value = false;
        if (activeProjectId.value && !value.some(project => project.id === activeProjectId.value)) activeProjectId.value = '';
      },
      error: cause => { readFailed.value = true; showError(cause); },
    });
  } catch (cause) {
    if (attempt === loadAttempt) {
      readFailed.value = true;
      showError(cause);
    }
  }
}

async function addProject() {
  submitted.value = true;
  error.value = '';
  status.value = '';
  saving.value = true;
  try {
    await repository.create(name.value, partNumber.value);
    name.value = '';
    partNumber.value = '';
    status.value = '项目已保存到共享 Access 并同步当前浏览器副本。';
    submitted.value = false;
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function editPartNumber(project: Project) {
  void router.push(projectOverlayPath(project.id, view.value, 'edit'));
  error.value = ''; status.value = '';
  await nextTick();
  editInput.value?.focus();
  editInput.value?.select();
}

async function previewProjectDeletion() {
  const project = editingProject.value;
  if (!project) return;
  error.value = ''; status.value = '';
  void router.push(projectOverlayPath(project.id, view.value, 'delete'));
}

async function deleteProject() {
  const target = deletion.value;
  if (!target) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    await repository.deleteProject(target.project.id, target.project.revision, confirmedProjectName.value);
    if (activeProjectId.value === target.project.id) void router.replace('/');
    editingProject.value = null; deletion.value = null;
    status.value = `项目“${target.project.name}”及其浏览器配置已删除；磁盘文件未删除，其他项目未改变。`;
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
    if (!deletion.value) {
      await nextTick();
      document.getElementById('project-name')?.focus();
    }
  }
}

async function savePartNumber() {
  const project = editingProject.value;
  if (!project) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    await repository.setPartNumber(project.id, project.revision, editedPartNumber.value);
    editingProject.value = null;
    closeProjectOverlay();
    status.value = '零件号已保存，版本图与统一归档根目录授权未改变。请重新扫描工程子目录；原磁盘文件未改名。';
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function exportProject(project: Project) {
  saving.value = true; error.value = ''; status.value = '';
  try {
    const draft = collaboration.state.draftCount;
    if (draft && !window.confirm(`本机共有 ${draft} 个待同步版本。导出的当前项目 JSON 将包含其待同步版本；这些版本尚未全部进入共享库，管理员恢复此文件会将其作为正式版本恢复到 Access。继续导出吗？`)) return;
    const root = archiveRoots.value[JSON_BACKUP_LOCATION];
    if (root) {
      if (!await checkPermission(root, false, 'readwrite')) throw new Error('请先授权共享根目录的读写权限。');
      const snapshot = await repository.snapshot(project.id);
      const fileName = await writeJsonBackup(root, snapshot.graph.project.name, serializeProjectSnapshot(snapshot));
      status.value = `“${snapshot.graph.project.name}”配置已导出到共享根目录：${fileName}`;
    } else if (window.showSaveFilePicker) {
      let handle: FileHandle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: jsonBackupFileName(project.name),
          types: [{ description: 'JSON 配置备份', accept: { 'application/json': ['.json'] } }],
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          status.value = '已取消导出。';
          return;
        }
        throw cause;
      }
      const snapshot = await repository.snapshot(project.id);
      await writeSelectedJsonFile(handle, serializeProjectSnapshot(snapshot));
      status.value = `“${snapshot.graph.project.name}”配置已保存：${handle.name}`;
    } else {
      const snapshot = await repository.snapshot(project.id);
      const blob = new Blob([serializeProjectSnapshot(snapshot)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = jsonBackupFileName(snapshot.graph.project.name);
      try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      status.value = '已请求浏览器下载 JSON；保存位置由浏览器下载设置决定，请检查下载结果。';
    }
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function exportProjectFromMenu() {
  if (backupMenu.value) backupMenu.value.open = false;
  backupMenuTrigger.value?.focus();
  if (activeProject.value) {
    await exportProject(activeProject.value);
    return;
  }
  exportProjectId.value = projects.value[0]?.id ?? '';
  exportPicker.value?.showModal();
}

function exportSelectedProject() {
  const project = projects.value.find(item => item.id === exportProjectId.value);
  if (!project) {
    showError(new Error('所选项目已不存在，请重新选择。'));
    exportPicker.value?.close();
    return;
  }
  exportPicker.value?.close();
  void exportProject(project);
}

async function importProjectFromMenu() {
  if (!canImport.value) { showError(new Error('仅已连接并登录的管理员可以恢复 JSON。')); return; }
  if (backupMenu.value) backupMenu.value.open = false;
  backupMenuTrigger.value?.focus();
  if (!archiveRoots.value[JSON_BACKUP_LOCATION]) {
    manualImportProjectId = activeProjectId.value;
    manualImportInput.value?.click();
    return;
  }
  await chooseImportFromRoot();
}

async function openBackupManager() {
  if (backupMenu.value) backupMenu.value.open = false;
  const projectId = activeProjectId.value;
  const root = archiveRoots.value[JSON_BACKUP_LOCATION];
  if (!projectId || !root) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    const currentRoot = await repository.getArchiveRoot(JSON_BACKUP_LOCATION);
    if (!currentRoot || !(await sameDirectory(root, currentRoot))) throw new Error('共享根目录已更改，请重新打开备份管理。');
    const result = await listProjectBackups(root, projectId);
    if (activeProjectId.value !== projectId) throw new Error('当前项目已更改，请重新打开备份管理。');
    backupProjectId.value = projectId;
    backupRoot.value = root;
    backupList.value = result;
    selectedBackups.value = [];
    backupDeleteConfirming.value = false;
    await nextTick();
    backupManager.value?.showModal();
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function prepareBackupDeletion(selectOlder = false) {
  if (selectOlder) selectedBackups.value = backupList.value.backups.slice(1).map(item => item.name);
  if (!selectedBackups.value.length) return;
  backupDeleteConfirming.value = true;
  await nextTick();
  backupDeleteCancel.value?.focus();
}

async function removeSelectedBackups() {
  const selected = backupList.value.backups.filter(item => selectedBackups.value.includes(item.name));
  if (!selected.length) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    const root = backupRoot.value;
    const currentRoot = await repository.getArchiveRoot(JSON_BACKUP_LOCATION);
    if (!root || !currentRoot || !(await sameDirectory(root, currentRoot))) throw new Error('共享根目录已更改，请重新打开备份管理。');
    if (activeProjectId.value !== backupProjectId.value) throw new Error('当前项目已更改，请重新打开备份管理。');
    const refreshed = await listProjectBackups(root, backupProjectId.value);
    if (JSON.stringify(refreshed) !== JSON.stringify(backupList.value)) throw new Error('备份列表已发生变化，请重新打开备份管理并确认。');
    const count = await deleteProjectBackups(root, backupProjectId.value, selected);
    selectedBackups.value = [];
    backupDeleteConfirming.value = false;
    status.value = `已删除 ${count} 个 JSON 备份。`;
    try {
      backupList.value = await listProjectBackups(root, backupProjectId.value);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : '未知错误';
      throw new Error(`已删除 ${count} 个备份，但刷新列表失败：${detail}`);
    }
  } catch (cause) {
    backupManager.value?.close();
    showError(cause);
  } finally {
    saving.value = false;
  }
}

function closeBackupMenu() {
  if (backupMenu.value) backupMenu.value.open = false;
  backupMenuTrigger.value?.focus();
}

function onBackupMenuOutsidePointerDown(event: PointerEvent) {
  if (backupMenu.value?.open && !event.composedPath().includes(backupMenu.value)) backupMenu.value.open = false;
}

async function chooseImportFromRoot() {
  saving.value = true; error.value = ''; status.value = '';
  try {
    const root = archiveRoots.value[JSON_BACKUP_LOCATION];
    const projectId = activeProjectId.value;
    const projectName = activeProject.value?.name ?? '';
    if (!root) throw new Error('请先选择共享根目录。');
    if (!await checkPermission(root, false, 'readwrite')) throw new Error('共享根目录读写授权已失效，请重新授权。');
    const files = await listImportJsonBackups(root, projectName);
    const currentRoot = await repository.getArchiveRoot(JSON_BACKUP_LOCATION);
    if (!currentRoot || !(await sameDirectory(root, currentRoot))) throw new Error('共享根目录已更改，请重新选择 JSON 备份。');
    if (activeProjectId.value !== projectId || (activeProject.value?.name ?? '') !== projectName)
      throw new Error('当前项目已更改，请重新选择 JSON 备份。');
    importFiles.value = files;
    if (!files.length) { status.value = '共享根目录中没有 JSON 备份。'; return; }
    importFileName.value = files[0]!.name;
    await nextTick();
    importPicker.value?.showModal();
  } catch (cause) { showError(cause); }
  finally { saving.value = false; }
}

async function readImportFileFromRoot() {
  const fileName = importFileName.value;
  const fileHandle = importFiles.value.find(file => file.name === fileName);
  if (!fileHandle) return;
  const projectId = activeProjectId.value;
  importPreview.value = null;
  saving.value = true; error.value = ''; status.value = '';
  try {
    const rootAtRead = archiveRoots.value[JSON_BACKUP_LOCATION];
    const currentRoot = await repository.getArchiveRoot(JSON_BACKUP_LOCATION);
    if (!rootAtRead || !currentRoot || !(await sameDirectory(rootAtRead, currentRoot)))
      throw new Error('共享根目录已更改，请重新选择 JSON 备份。');
    if (!await checkPermission(rootAtRead, false, 'readwrite')) throw new Error('共享根目录读写授权已失效，请重新授权。');
    const file = await fileHandle.getFile();
    await prepareImportPreview(file, projectId);
    importPicker.value?.close();
    await focusImportPreview();
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function prepareImportPreview(file: File, currentProjectId: string) {
  if (!/\.json$/i.test(file.name)) throw new Error('请选择扩展名为 .json 的备份文件。');
  const graph = await readProjectSnapshotFile(file);
  const plan = await repository.previewSnapshotRestore(graph, currentProjectId);
  if (activeProjectId.value !== currentProjectId) throw new Error('当前项目已更改，请重新选择 JSON 备份。');
  importPreview.value = { graph, fileName: file.name, plan, currentProjectId };
}

async function focusImportPreview() {
  await nextTick();
  if (importPreview.value?.plan.blockedReason) document.getElementById('import-preview-title')?.focus();
  else importConfirmButton.value?.focus();
}

async function readManualImport(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  importPreview.value = null;
  saving.value = true; error.value = ''; status.value = '';
  try {
    if (activeProjectId.value !== manualImportProjectId) throw new Error('当前项目已更改，请重新选择 JSON 备份。');
    await prepareImportPreview(file, manualImportProjectId);
    await focusImportPreview();
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function confirmImport() {
  const pending = importPreview.value;
  if (!pending) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    if (activeProjectId.value !== pending.currentProjectId) throw new Error('当前项目已更改，请重新预览导入。');
    const result = await repository.restoreSnapshot(pending.graph, pending.currentProjectId, pending.plan);
    importPreview.value = null;
    projectsCollapsed.value = false;
    editingProject.value = null;
    archiveRootRevision.value++;
    void router.push(projectPath(result.project.id, 'files'));
    status.value = pending.plan.target
      ? `项目“${result.project.name}”已覆盖恢复，请从当前归档根目录扫描项目子目录。`
      : `项目“${result.project.name}”已新增，请从当前归档根目录扫描项目子目录。`;
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
    if (!importPreview.value) {
      await nextTick();
      backupMenuTrigger.value?.focus();
    }
  }
}

async function cancelImport() {
  importPreview.value = null;
  await nextTick();
  backupMenuTrigger.value?.focus();
}

onMounted(() => {
  stopProjectPolling = startProjectPolling(document, checkActiveProject);
  window.addEventListener('pointerdown', onBackupMenuOutsidePointerDown, true);
  void watchProjects();
  void collaboration.initialize().catch(showError);
  collaborationSubscription = liveQuery(() => collaboration.updateCounts()).subscribe({ error: showError });
});
onUnmounted(() => {
  stopProjectPolling?.();
  window.removeEventListener('pointerdown', onBackupMenuOutsidePointerDown, true);
  ++loadAttempt;
  subscription?.unsubscribe();
  collaborationSubscription?.unsubscribe();
  db.close();
  collaboration.cache.close();
});
</script>

<template>
  <a class="skip-link" href="#workspace">跳至工作区</a>
  <header class="topbar">
    <a class="brand" href="#" aria-label="IQAN Archive 首页" @click.prevent="router.push('/')">
      <AppBrandMark />
      <span>IQAN <strong>Archive</strong></span>
    </a>
    <div class="topbar-actions">
      <details ref="backupMenu" class="topbar-menu" @keydown.esc.prevent="closeBackupMenu">
        <summary ref="backupMenuTrigger" class="topbar-menu-trigger"><AppIcon name="folder" />JSON 备份</summary>
        <div class="topbar-menu-items">
          <button type="button" :disabled="loading || !projects.length || saving || workspaceBusy" @click="exportProjectFromMenu"><AppIcon name="download" />{{ archiveRoots.shared ? '导出 JSON' : supportsSaveFilePicker ? '选择位置导出 JSON' : '下载 JSON' }}</button>
          <button type="button" :disabled="saving || workspaceBusy || !canImport" @click="importProjectFromMenu"><AppIcon name="upload" />管理员恢复 JSON</button>
          <button v-if="activeProject" type="button" :disabled="saving || workspaceBusy || !archiveRoots.shared" @click="openBackupManager"><AppIcon name="folder" />管理备份</button>
        </div>
      </details>
      <input id="manual-import-file" name="manualImportFile" ref="manualImportInput" type="file" accept=".json,application/json" hidden @change="readManualImport">
      <ArchiveRootPanel :repository="repository" :disabled="saving || documentsBusy || graphBusy" @roots="receiveArchiveRoots" @error="showError" />
      <BackendSettings :repository="repository" :disabled="saving || workspaceBusy || collaboration.state.busy || collaboration.state.restoring" @saved="collaboration.disconnect()" />
      <CollaborationPanel :client="collaboration" :project-id="activeProjectId" :disabled="saving || workspaceBusy" />
    </div>
  </header>

  <main id="workspace" v-show="!isAccountRoute" :class="{ 'projects-collapsed': activeProjectId && projectsCollapsed }">
    <section class="notice" aria-label="共享连接与副本状态">
      <div>
        <h2>{{ collaboration.state.restoring ? '正在检测后端并恢复登录…' : collaboration.state.connected ? (collaboration.state.authenticated ? (collaboration.state.pending ? '共享协作已连接 · 提交待确认' : '共享协作已连接') : '后端可达 · 需要登录或重新验证') : collaboration.state.source ? '本机缓存视图 · 未连接后端' : '历史单人数据 · 只读' }}</h2>
        <p v-if="!collaboration.state.restoring">{{ collaboration.state.message || '请点击顶栏右上角账户头像登录；无共享副本时，历史 IndexedDB 数据保留为只读，可先导出 JSON 再由管理员恢复到共享库。' }}</p>
        <p v-if="collaboration.state.source">待同步版本 {{ collaboration.state.draftCount }} 个{{ collaboration.state.pending ? ' · 存在未确认提交，请在账号入口用原请求重试' : '' }}。{{ activeProjectId && canWrite ? '当前项目在前台每 15 秒检查更新，编辑或拖拽时暂停。' : '可在账号入口手动刷新共享数据。' }}{{ collaboration.state.updatedAt ? `副本读取时间：${new Date(collaboration.state.updatedAt).toLocaleString()}` : '显示上次持久副本。' }}</p>
        <p v-if="pollError && pollError.id === activeProjectId" role="status">自动刷新未完成，仍显示本机副本：{{ pollError.message }}</p>
        <p v-if="collaboration.state.conflictMessage" role="alert">草稿冲突已保留，请在账号入口检查 / 修复：{{ collaboration.state.conflictMessage }}</p>
        <p v-if="sharedWriteBlockedReason" role="status">{{ sharedWriteBlockedReason }}</p>
        <button v-if="collaboration.state.pending" type="button" class="secondary" :disabled="saving || workspaceBusy" @click="router.push({ path: '/account/sync', query: { from: route.fullPath } })">前往处理未确认提交</button>
      </div>
    </section>
    <Transition name="surface">
      <div v-if="error" class="error" role="alert">
        <h2 ref="errorHeading" tabindex="-1">操作未完成</h2>
        <p>{{ error }}</p>
        <ul v-if="nameError || partError">
          <li v-if="nameError"><a href="#project-name">检查项目名称</a></li>
          <li v-if="partError"><a href="#part-number">检查软件零件号</a></li>
        </ul>
        <button type="button" class="secondary" :disabled="saving" @click="watchProjects">重新连接存储</button>
      </div>
    </Transition>
    <Transition name="feedback" mode="out-in">
      <p v-if="status" :key="status" role="status" class="status">{{ status }}</p>
    </Transition>

    <section v-if="importPreview" class="panel import-preview" aria-labelledby="import-preview-title">
        <h3 id="import-preview-title" tabindex="-1">导入预览</h3>
        <p><strong>{{ importPreview.graph.project.name }}</strong> · 零件号 {{ importPreview.graph.project.partNumber }}</p>
        <p>文件：{{ importPreview.fileName }} · {{ importPreview.graph.nodes.length }} 个版本 · {{ importPreview.graph.edges.length }} 条父边 · {{ importPreview.graph.branches.length }} 个分支 · {{ importPreview.graph.tasks.length }} 个任务</p>
        <p v-if="importPreview.plan.nameMatches.length" class="form-help">同名项目：{{ importPreview.plan.nameMatches.map(project => `${project.name}（${project.partNumber}）`).join('、') }}。</p>
        <p v-if="importPreview.plan.partMatches.length" class="form-help">零件号匹配：{{ importPreview.plan.partMatches.map(project => `${project.name}（${project.partNumber}）`).join('、') }}。</p>
        <p v-if="importPreview.plan.blockedReason" role="alert">{{ importPreview.plan.blockedReason }}</p>
        <p v-else-if="importPreview.plan.target" class="form-help">确认后将覆盖项目“{{ importPreview.plan.target.name }}”（零件号 {{ importPreview.plan.target.partNumber }}）的全部配置，未保存的编辑草稿也会丢失。其他项目和磁盘工程文件不变。</p>
        <p v-else class="form-help">未匹配到已有零件号，确认后生成新的共享项目 ID 并新增项目，图内引用保持一致；不会复活已删除的项目身份。</p>
        <p class="form-help">仅管理员可执行：先恢复共享 Access，再更新本机副本。备份包含的离线新版本也会恢复为共享版本。JSON 不含账号、本地文件或目录授权；沿用当前归档根目录，缺失子目录不会自动创建。</p>
        <div class="backup-actions">
          <button ref="importConfirmButton" type="button" :disabled="saving || workspaceBusy || !canImport || !!importPreview.plan.blockedReason" @click="confirmImport"><AppIcon name="check" />{{ saving ? '正在导入…' : importPreview.plan.target ? '确认覆盖共享项目' : '确认新增共享项目' }}</button>
          <button type="button" class="secondary" :disabled="saving" @click="cancelImport">取消</button>
        </div>
    </section>
    <dialog ref="exportPicker" class="branch-move-dialog" aria-labelledby="export-picker-title">
      <h3 id="export-picker-title">选择要导出的项目</h3>
      <label for="export-project-choice">项目</label>
      <select id="export-project-choice" v-model="exportProjectId">
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.partNumber }}）</option>
      </select>
      <div class="actions">
        <button type="button" :disabled="saving || !exportProjectId" @click="exportSelectedProject">导出 JSON</button>
        <button type="button" class="secondary" :disabled="saving" @click="exportPicker?.close()">取消</button>
      </div>
    </dialog>
    <dialog ref="importPicker" class="branch-move-dialog" aria-labelledby="import-picker-title" @close="importFiles = []; importFileName = ''">
      <h3 id="import-picker-title">从归档根目录导入</h3>
      <p>选择保存在归档根目录中的项目 JSON 备份。</p>
      <label for="archive-root-json-choice">JSON 备份</label>
      <select id="archive-root-json-choice" v-model="importFileName">
        <option v-for="file in importFiles" :key="file.name" :value="file.name">{{ file.name }}</option>
      </select>
      <div class="actions">
        <button type="button" :disabled="saving || !importFileName" @click="readImportFileFromRoot">预览导入</button>
        <button type="button" class="secondary" :disabled="saving" @click="importPicker?.close()">取消</button>
      </div>
    </dialog>
    <dialog ref="backupManager" class="branch-move-dialog backup-manager" aria-labelledby="backup-manager-title" @close="backupDeleteConfirming = false; backupMenuTrigger?.focus()">
      <h3 id="backup-manager-title">管理项目备份</h3>
      <p>按文件修改时间排序，最新备份位于首位。一键清除会先选中其余备份，确认后永久删除。</p>
      <p v-if="status" role="status">{{ status }}</p>
      <p v-if="backupList.unrecognized.length" class="form-help">有 {{ backupList.unrecognized.length }} 个 JSON 无法识别，未列入备份或清理；其中可能包含当前项目的备份。</p>
      <details v-if="backupList.unrecognized.length">
        <summary>查看无法识别的 JSON</summary>
        <ul><li v-for="item in backupList.unrecognized" :key="item.name">{{ item.name }}：{{ item.reason }}</li></ul>
      </details>
      <p v-if="!backupList.backups.length">没有可识别的当前项目备份。</p>
      <ul v-else class="backup-list">
        <li v-for="(backup, index) in backupList.backups" :key="backup.name" :class="{ 'is-selected': selectedBackups.includes(backup.name) }">
          <label><input v-model="selectedBackups" type="checkbox" :value="backup.name" :disabled="saving"><span>{{ backup.name }}<small>{{ new Date(backup.lastModified).toLocaleString() }}{{ index === 0 ? ' · 最新' : '' }}{{ selectedBackups.includes(backup.name) ? ' · 已选中' : '' }}</small></span></label>
        </li>
      </ul>
      <div v-if="backupDeleteConfirming" class="backup-delete-confirm" role="group" aria-labelledby="backup-delete-title">
        <p id="backup-delete-title">确定永久删除上方选中的 {{ selectedBackups.length }} 个 JSON 备份吗？此操作无法撤销。</p>
        <div class="actions">
          <button ref="backupDeleteCancel" type="button" class="secondary" :disabled="saving" @click="backupDeleteConfirming = false">取消删除</button>
          <button type="button" :disabled="saving || !selectedBackups.length" @click="removeSelectedBackups">{{ saving ? '正在删除…' : '确认删除' }}</button>
        </div>
      </div>
      <div v-else class="actions">
        <button type="button" :disabled="saving || backupList.backups.length < 2" @click="prepareBackupDeletion(true)">一键清除旧备份</button>
        <button type="button" class="secondary" :disabled="saving || !selectedBackups.length" @click="prepareBackupDeletion()">删除选中（{{ selectedBackups.length }}）</button>
        <button type="button" class="secondary" :disabled="saving" @click="backupManager?.close()">关闭</button>
      </div>
    </dialog>
    <div :class="['app-workspace', { 'has-project': activeProjectId, 'projects-collapsed': activeProjectId && projectsCollapsed }]">
    <div id="project-rail" class="workspace-grid project-rail-region" :class="{ 'is-collapsed': activeProjectId && projectsCollapsed }">
      <template v-if="!activeProjectId || !projectsCollapsed">
      <section class="panel projects" aria-labelledby="projects-title" :aria-busy="loading">
        <div class="section-heading">
          <div><p class="eyebrow">PROJECTS</p><h2 id="projects-title">项目档案</h2></div>
          <div class="project-list-heading-actions">
            <span class="count">{{ projects.length }} 个项目</span>
            <button
              v-if="activeProjectId" type="button" class="icon-button project-rail-toggle"
              aria-label="折叠项目区域" title="折叠项目区域" :aria-expanded="!projectsCollapsed"
              aria-controls="project-rail" @click="projectsCollapsed = true"
            ><AppIcon name="chevron-left" /></button>
          </div>
        </div>
        <p v-if="loading" role="status">正在读取本机项目…</p>
        <div v-else-if="projects.length === 0" class="empty">
          <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
            <path d="M12 18h16l6 7h18v27H12zM12 18v-6h17l6 6h17v7" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
          <h3>{{ readFailed ? '项目暂时无法读取' : '还没有项目档案' }}</h3>
          <p>{{ readFailed ? '请处理上方错误，再重新连接存储。' : canWrite ? '共享副本暂无项目，可建立第一份工程档案。' : '没有可用离线项目，请连接后端并登录获取共享副本。' }}</p>
        </div>
        <TransitionGroup v-else name="list" tag="ul" class="project-list">
          <li v-for="project in projects" :key="project.id">
            <div class="project-info">
              <div class="project-title-line">
                <h3>{{ project.name }}</h3>
                <span class="project-state">{{ collaboration.state.deletedProjectIds.includes(project.id) ? '共享已删除 · 仅本机草稿' : collaboration.state.source ? '共享副本' : '历史本机数据' }}</span>
              </div>
              <button class="project-part-number" :disabled="saving || workspaceBusy || !canWrite" :aria-label="`修改 ${project.name} 的零件号`" :title="`修改零件号 ${project.partNumber}`" @click="editPartNumber(project)"><code>{{ project.partNumber }}</code></button>
            </div>
            <div class="project-actions">
              <button class="secondary icon-button compact-project-action" :disabled="workspaceBusy" :aria-label="`管理 ${project.name} 文件`" :title="`管理 ${project.name} 文件`" :aria-pressed="activeProjectId === project.id && view === 'files'" @click="navigateProject(project.id, 'files')"><AppIcon name="file" /></button>
              <button class="secondary icon-button compact-project-action" :disabled="workspaceBusy" :aria-label="`查看 ${project.name} 版本图`" :title="`查看 ${project.name} 版本图`" :aria-pressed="activeProjectId === project.id && view === 'graph'" @click="openProjectGraph(project.id)"><AppIcon name="branch" /></button>
              <button class="secondary icon-button compact-project-action" :disabled="workspaceBusy" :aria-label="`查看 ${project.name} 软件对比文档`" :title="`查看 ${project.name} 软件对比文档`" :aria-pressed="activeProjectId === project.id && view === 'documents'" @click="navigateProject(project.id, 'documents')"><AppIcon name="documents" /></button>
              <button class="secondary icon-button compact-project-action" :disabled="workspaceBusy" :aria-label="`打开 ${project.name} 任务看板`" :title="`任务看板：${project.name}`" :aria-pressed="activeProjectId === project.id && view === 'tasks'" @click="openProjectTaskBoard(project.id)"><AppIcon name="tasks" /></button>
            </div>
          </li>
        </TransitionGroup>
        <p class="boundary">选择项目进入文件工作区或版本图，点击零件号可修改。文件按扫描结果自动关联，不写入版本图配置。</p>
      </section>

      <section class="panel" aria-labelledby="create-title">
        <template v-if="deletion">
          <p class="eyebrow">DELETE PROJECT</p>
          <h2 id="create-title">确认删除项目</h2>
          <p class="form-help">将永久删除“{{ deletion.project.name }}”（{{ deletion.project.partNumber }}）的 {{ deletion.nodes.length }} 个版本、{{ deletion.edges.length }} 条父边、{{ deletion.branches.length }} 个分支、{{ deletion.tasks.length }} 个任务及旧项目级目录绑定，包括已放行版本。</p>
          <p class="form-help">不会删除磁盘上的工程、软件对比文档或全局归档根目录授权，不影响其他项目。本操作不可撤销。</p>
          <form @submit.prevent="deleteProject">
            <label for="delete-project-name">输入完整项目名称确认</label>
            <input id="delete-project-name" ref="deleteInput" v-model="confirmedProjectName" :disabled="saving" autocomplete="off" required />
            <button class="danger" :disabled="saving || workspaceBusy || confirmedProjectName !== deletion.project.name"><AppIcon name="trash" />{{ saving ? '正在删除…' : '永久删除项目' }}</button>
            <button type="button" class="secondary" :disabled="saving" @click="closeProjectOverlay">取消删除</button>
          </form>
        </template>
        <template v-else-if="editingProject">
          <p class="eyebrow">EDIT PROJECT</p>
          <h2 id="create-title">修改项目零件号</h2>
          <p class="form-help">{{ editingProject.name }} · 不改变版本图或统一根目录授权，不重命名磁盘文件。保存后请重新扫描。</p>
          <form @submit.prevent="savePartNumber">
            <label for="edit-part-number">零件号 <span>必填</span></label>
            <input id="edit-part-number" ref="editInput" v-model="editedPartNumber" required :disabled="saving || workspaceBusy" :aria-invalid="!editedPartNumber.trim()" :aria-describedby="!editedPartNumber.trim() ? 'edit-part-error' : undefined" />
            <p v-if="!editedPartNumber.trim()" id="edit-part-error" class="field-error">请输入非空零件号。</p>
            <button :disabled="saving || workspaceBusy || !editedPartNumber.trim()"><AppIcon name="check" />{{ saving ? '正在保存…' : '保存零件号' }}</button>
            <button type="button" class="secondary" :disabled="saving" @click="closeProjectOverlay">取消修改</button>
            <button type="button" class="secondary" :disabled="saving || workspaceBusy" @click="previewProjectDeletion"><AppIcon name="trash" />删除此项目…</button>
          </form>
        </template>
        <template v-else>
        <p class="eyebrow">NEW PROJECT</p>
        <h2 id="create-title">建立项目</h2>
        <form @submit.prevent="addProject">
          <label for="project-name">项目名称 <span>必填</span></label>
          <input id="project-name" v-model="name" name="projectName" required :disabled="saving" :aria-invalid="nameError" :aria-describedby="nameError ? 'name-error' : undefined" placeholder="例如：转向控制系统" />
          <p v-if="nameError" id="name-error" class="field-error">请输入项目名称，不能仅包含空白。</p>
          <label for="part-number">软件零件号 <span>必填</span></label>
          <input id="part-number" v-model="partNumber" name="partNumber" required :disabled="saving" :aria-invalid="partError" :aria-describedby="partError ? 'part-error' : undefined" placeholder="例如：14798046801" />
          <p v-if="partError" id="part-error" class="field-error">请输入软件零件号，不能仅包含空白。</p>
          <button type="submit" :disabled="saving || loading || !canWrite"><AppIcon name="plus" />{{ saving ? '正在保存…' : '创建共享项目' }}</button>
        </form>
        </template>
      </section>
      </template>
      <button
        v-else type="button" class="icon-button project-rail-expand"
        aria-label="展开项目区域" title="展开项目区域" :aria-expanded="false" aria-controls="project-rail"
        @click="projectsCollapsed = false"
      ><AppIcon name="chevron-right" /></button>
    </div>

    <ProjectFiles v-if="activeProjectId && activeProject" v-show="view === 'files'" :key="`files-${activeProjectId}-${archiveRootRevision}`" v-model:version-order="versionOrder" :repository="repository" :project-id="activeProjectId" :project-name="activeProject.name" :archive-roots="archiveRoots" @busy="filesPanelBusy = $event" />
    <VersionGraph v-if="activeProjectId && view === 'graph'" :key="`graph-${activeProjectId}-${archiveRootRevision}`" v-model:version-order="versionOrder" :repository="repository" :project-id="activeProjectId" :archive-roots="archiveRoots" :focus-node-id="focusNodeId" :panel-route="graphPanelRoute" @busy="graphBusy = $event" @refresh-blocked="graphRefreshBlocked = $event" @navigate-panel="navigateGraphPanel" @documents="navigateProject(activeProjectId, 'documents')" @task-board="openTaskBoard" />
    <ComparisonDocuments v-if="activeProjectId && activeProject" v-show="view === 'documents'" :key="`documents-${activeProjectId}-${archiveRootRevision}`" v-model:version-order="versionOrder" :repository="repository" :project-id="activeProjectId" :project-name="activeProject.name" :archive-roots="archiveRoots" @busy="documentsBusy = $event" @graph="openProjectGraph(activeProjectId)" />
    <TaskBoard v-if="activeProjectId && activeProject && view === 'tasks'" :key="`tasks-${activeProjectId}`" :repository="repository" :project-id="activeProjectId" :project-name="activeProject.name" :focus-task-id="taskBoardTargetId" :detail-task-id="taskBoardDetailId" :options-open="taskBoardOptionsOpen" :assignee-refresh-key="assigneeRefreshKey" :current-account-id="taskAccountId" @busy="taskBoardBusy = $event" @refresh-blocked="taskRefreshBlocked = $event" @navigate-child="navigateTaskBoardChild" @graph="openVersionFromTaskBoard" />
    </div>

    <section class="notice" aria-labelledby="storage-title">
      <div class="notice-mark" aria-hidden="true">i</div>
      <div>
        <h2 id="storage-title">共享 Access + 当前浏览器持久副本</h2>
        <p>未同步版本仅保存在当前浏览器，清除浏览器数据可能丢失草稿和会话；迁移前请导出 JSON。后端断开不代表网页资源支持完全断网加载。</p>
      </div>
    </section>
    <footer><span>IQAN Archive</span><span>可信团队协作 · 本机服务 + 共享 Access · 文件操作独立</span></footer>
  </main>
</template>
