<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { liveQuery } from 'dexie';
import { ArchiveDatabase, ArchiveRepository } from './storage/database';
import type { Project, ProjectGraph } from './domain/model';
import { readProjectSnapshotFile, serializeProjectSnapshot } from './domain/project-snapshot';
import type { VersionOrder } from './domain/version-order';
import ProjectFiles from './components/ProjectFiles.vue';
const VersionGraph = defineAsyncComponent(() => import('./components/VersionGraph.vue'));
const ComparisonDocuments = defineAsyncComponent(() => import('./components/ComparisonDocuments.vue'));
import ArchiveRootPanel from './components/ArchiveRootPanel.vue';
import AppIcon from './components/AppIcon.vue';
import { checkPermission, sameDirectory, type ArchiveRoots, type DirectoryHandle, type FileHandle } from './files/directories';
import { JSON_BACKUP_LOCATION, listJsonBackups, writeJsonBackup } from './files/archive-json';

const db = new ArchiveDatabase();
const repository = new ArchiveRepository(db);
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
const activeProject = computed(() => projects.value.find(project => project.id === activeProjectId.value) ?? null);
const projectsCollapsed = ref(false);
const filesPanelBusy = ref(false);
const documentsBusy = ref(false);
const rootBusy = ref(false);
const archiveRoots = shallowRef<ArchiveRoots>({});
const archiveRootRevision = ref(0);
const filesBusy = computed(() => filesPanelBusy.value || documentsBusy.value || rootBusy.value);
const graphBusy = ref(false);
const view = ref<'files' | 'graph' | 'documents'>('files');
const versionOrder = ref<VersionOrder>('newest');
const importButton = ref<HTMLButtonElement | null>(null);
const importConfirmButton = ref<HTMLButtonElement | null>(null);
const importPreview = ref<{ graph: ProjectGraph; fileName: string; conflict: boolean } | null>(null);
const importFiles = ref<FileHandle[]>([]);
const importFileName = ref('');
const importPicker = ref<HTMLDialogElement>();
const nameError = computed(() => submitted.value && !name.value.trim());
const partError = computed(() => submitted.value && !partNumber.value.trim());
const errorHeading = ref<HTMLElement | null>(null);
let subscription: { unsubscribe(): void } | undefined;
let loadAttempt = 0;

function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '本地存储操作失败，请重试。';
  status.value = '';
  loading.value = false;
  void nextTick(() => errorHeading.value?.focus());
}

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
    status.value = '项目已保存到当前浏览器。';
    submitted.value = false;
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function editPartNumber(project: Project) {
  deletion.value = null;
  editingProject.value = { ...project };
  editedPartNumber.value = project.partNumber;
  error.value = ''; status.value = '';
  await nextTick();
  editInput.value?.focus();
  editInput.value?.select();
}

async function previewProjectDeletion() {
  const project = editingProject.value;
  if (!project) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    deletion.value = await repository.get(project.id);
    confirmedProjectName.value = '';
    saving.value = false;
    await nextTick();
    deleteInput.value?.focus();
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function deleteProject() {
  const target = deletion.value;
  if (!target) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    await repository.deleteProject(target.project.id, target.project.revision, confirmedProjectName.value);
    if (activeProjectId.value === target.project.id) activeProjectId.value = '';
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
    status.value = '零件号已保存，版本图与统一归档根目录授权未改变。请重新扫描工程子目录；原磁盘文件未改名。';
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function exportProject() {
  if (!activeProjectId.value) return;
  saving.value = true; error.value = ''; status.value = '';
  try {
    const root = archiveRoots.value[JSON_BACKUP_LOCATION];
    if (!root || !await checkPermission(root, false, 'readwrite')) throw new Error('请先授权共享根目录的读写权限。');
    const snapshot = await repository.snapshot(activeProjectId.value);
    const fileName = await writeJsonBackup(root, snapshot.graph.project.name, serializeProjectSnapshot(snapshot));
    status.value = `“${snapshot.graph.project.name}”配置已导出到共享根目录：${fileName}`;
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
}

async function chooseImportFromRoot() {
  error.value = ''; status.value = '';
  try {
    const root = archiveRoots.value[JSON_BACKUP_LOCATION];
    if (!root) throw new Error('请先选择共享根目录。');
    if (!await checkPermission(root, false, 'readwrite')) throw new Error('共享根目录读写授权已失效，请重新授权。');
    const files = await listJsonBackups(root);
    importFiles.value = files;
    if (!files.length) { status.value = '共享根目录中没有 JSON 备份。'; return; }
    importFileName.value = files[0]!.name;
    await nextTick();
    importPicker.value?.showModal();
  } catch (cause) { showError(cause); }
}

async function readImportFileFromRoot() {
  const fileName = importFileName.value;
  const fileHandle = importFiles.value.find(file => file.name === fileName);
  if (!fileHandle) return;
  importPreview.value = null;
  saving.value = true; error.value = ''; status.value = '';
  try {
    const rootAtRead = archiveRoots.value[JSON_BACKUP_LOCATION];
    const currentRoot = await repository.getArchiveRoot(JSON_BACKUP_LOCATION);
    if (!rootAtRead || !currentRoot || !(await sameDirectory(rootAtRead, currentRoot)))
      throw new Error('共享根目录已更改，请重新选择 JSON 备份。');
    if (!await checkPermission(rootAtRead, false, 'readwrite')) throw new Error('共享根目录读写授权已失效，请重新授权。');
    const file = await fileHandle.getFile();
    const graph = await readProjectSnapshotFile(file);
    const conflict = await repository.inspectSnapshotImport(graph);
    importPreview.value = { graph, fileName: file.name, conflict };
    importPicker.value?.close();
    await nextTick();
    importConfirmButton.value?.focus();
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
    const result = await repository.importSnapshot(pending.graph);
    importPreview.value = null;
    projectsCollapsed.value = false;
    if (!activeProjectId.value) {
      activeProjectId.value = result.graph.project.id;
      view.value = 'files';
    }
    status.value = result.copied
      ? `配置已作为“${result.graph.project.name}”的独立副本导入；内部身份已重新生成。请从当前归档根目录扫描项目子目录。`
      : `项目“${result.graph.project.name}”已恢复，请从当前归档根目录扫描项目子目录。`;
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
    if (!importPreview.value) {
      await nextTick();
      importButton.value?.focus();
    }
  }
}

async function cancelImport() {
  importPreview.value = null;
  await nextTick();
  importButton.value?.focus();
}

onMounted(watchProjects);
onUnmounted(() => { ++loadAttempt; subscription?.unsubscribe(); db.close(); });
</script>

<template>
  <a class="skip-link" href="#workspace">跳至工作区</a>
  <header class="topbar">
    <a class="brand" href="#" aria-label="IQAN Archive 首页">
      <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
        <path d="M8 5v22M8 10h10a6 6 0 0 1 6 6v11" fill="none" stroke="currentColor" stroke-width="2" />
        <circle cx="8" cy="7" r="3" fill="currentColor" />
        <circle cx="8" cy="25" r="3" fill="currentColor" />
        <circle cx="24" cy="25" r="3" fill="currentColor" />
      </svg>
      <span>IQAN <strong>Archive</strong></span>
    </a>
    <span class="local-label"><AppIcon name="shield" /> 本地优先 <span aria-hidden="true">/</span> 工程版本工作台</span>
  </header>

  <main id="workspace">
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

    <button v-if="activeProjectId" class="secondary project-rail-toggle" :aria-expanded="!projectsCollapsed" aria-controls="project-rail" @click="projectsCollapsed = !projectsCollapsed">
      <AppIcon name="folder" />{{ projectsCollapsed ? '展开项目区域' : '折叠项目区域' }}
    </button>
    <section v-if="activeProject || !loading" class="panel project-backup" aria-labelledby="backup-title">
      <div class="section-heading">
        <div><h2 id="backup-title">{{ activeProject ? `项目备份 · ${activeProject.name}` : '项目备份' }}</h2><p class="backup-scope">只包含图与任务配置，不含文件或目录授权。</p></div>
        <div class="backup-actions">
          <button v-if="activeProject" type="button" class="secondary" :disabled="saving || filesBusy || graphBusy || !archiveRoots.shared" @click="exportProject"><AppIcon name="download" />导出 JSON</button>
          <button ref="importButton" type="button" class="secondary" :disabled="saving || filesBusy || graphBusy || !archiveRoots.shared" @click="chooseImportFromRoot"><AppIcon name="upload" />导入恢复</button>
        </div>
      </div>
      <div v-if="importPreview" class="import-preview" aria-labelledby="import-preview-title">
        <h3 id="import-preview-title" tabindex="-1">导入预览</h3>
        <p><strong>{{ importPreview.graph.project.name }}</strong> · 零件号 {{ importPreview.graph.project.partNumber }}</p>
        <p>文件：{{ importPreview.fileName }} · {{ importPreview.graph.nodes.length }} 个版本 · {{ importPreview.graph.edges.length }} 条父边 · {{ importPreview.graph.branches.length }} 个分支 · {{ importPreview.graph.tasks.length }} 个任务</p>
        <p v-if="importPreview.conflict" class="form-help">检测到项目或内部 ID 冲突。确认后将作为独立副本导入并重新生成全部内部 ID，不覆盖现有项目。</p>
        <p v-else class="form-help">未发现 ID 冲突；恢复时保留项目身份。若确认前出现冲突，系统会自动改为副本导入。</p>
        <p class="form-help">JSON 不含本地文件或目录授权；导入后沿用当前归档根目录，按项目名称定位两个子目录并分别扫描。缺失子目录不会自动创建。</p>
        <div class="backup-actions">
          <button ref="importConfirmButton" type="button" :disabled="saving || filesBusy || graphBusy" @click="confirmImport"><AppIcon name="check" />{{ saving ? '正在导入…' : importPreview.conflict ? '导入为副本' : '恢复此项目' }}</button>
          <button type="button" class="secondary" :disabled="saving" @click="cancelImport">取消</button>
        </div>
      </div>
    </section>
    <ArchiveRootPanel :repository="repository" :disabled="saving || filesBusy || graphBusy" @roots="archiveRoots = $event; archiveRootRevision++" @busy="rootBusy = $event" @error="showError" />
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
    <div :class="['app-workspace', { 'has-project': activeProjectId, 'projects-collapsed': activeProjectId && projectsCollapsed }]">
    <div id="project-rail" v-show="!activeProjectId || !projectsCollapsed" class="workspace-grid">
      <section class="panel projects" aria-labelledby="projects-title" :aria-busy="loading">
        <div class="section-heading">
          <div><p class="eyebrow">PROJECTS</p><h2 id="projects-title">项目档案</h2></div>
          <span class="count">{{ projects.length }} 个项目</span>
        </div>
        <p v-if="loading" role="status">正在读取本机项目…</p>
        <div v-else-if="projects.length === 0" class="empty">
          <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
            <path d="M12 18h16l6 7h18v27H12zM12 18v-6h17l6 6h17v7" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
          <h3>{{ readFailed ? '项目暂时无法读取' : '还没有项目档案' }}</h3>
          <p>{{ readFailed ? '请处理上方错误，再重新连接存储。' : '填写项目名称与软件零件号，建立第一份工程档案。' }}</p>
        </div>
        <TransitionGroup v-else name="list" tag="ul" class="project-list">
          <li v-for="project in projects" :key="project.id">
            <div class="project-info">
              <div class="project-title-line">
                <h3>{{ project.name }}</h3>
                <span class="project-state">已保存</span>
              </div>
              <button class="project-part-number" :disabled="saving || filesBusy || graphBusy" :aria-label="`修改 ${project.name} 的零件号`" :title="`修改零件号 ${project.partNumber}`" @click="editPartNumber(project)"><code>{{ project.partNumber }}</code></button>
            </div>
            <div class="project-actions">
              <button class="secondary icon-button compact-project-action" :disabled="filesBusy || graphBusy" :aria-label="`管理 ${project.name} 文件`" :title="`管理 ${project.name} 文件`" :aria-pressed="activeProjectId === project.id && view === 'files'" @click="activeProjectId = project.id; view = 'files'"><AppIcon name="file" /></button>
              <button class="secondary icon-button compact-project-action" :disabled="filesBusy || graphBusy" :aria-label="`查看 ${project.name} 版本图`" :title="`查看 ${project.name} 版本图`" :aria-pressed="activeProjectId === project.id && view === 'graph'" @click="activeProjectId = project.id; view = 'graph'"><AppIcon name="branch" /></button>
              <button class="secondary icon-button compact-project-action" :disabled="filesBusy || graphBusy" :aria-label="`查看 ${project.name} 软件对比文档`" :title="`查看 ${project.name} 软件对比文档`" :aria-pressed="activeProjectId === project.id && view === 'documents'" @click="activeProjectId = project.id; view = 'documents'"><AppIcon name="documents" /></button>
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
            <button class="danger" :disabled="saving || filesBusy || graphBusy || confirmedProjectName !== deletion.project.name"><AppIcon name="trash" />{{ saving ? '正在删除…' : '永久删除项目' }}</button>
            <button type="button" class="secondary" :disabled="saving" @click="deletion = null">取消删除</button>
          </form>
        </template>
        <template v-else-if="editingProject">
          <p class="eyebrow">EDIT PROJECT</p>
          <h2 id="create-title">修改项目零件号</h2>
          <p class="form-help">{{ editingProject.name }} · 不改变版本图或统一根目录授权，不重命名磁盘文件。保存后请重新扫描。</p>
          <form @submit.prevent="savePartNumber">
            <label for="edit-part-number">零件号 <span>必填</span></label>
            <input id="edit-part-number" ref="editInput" v-model="editedPartNumber" required :disabled="saving || filesBusy || graphBusy" :aria-invalid="!editedPartNumber.trim()" :aria-describedby="!editedPartNumber.trim() ? 'edit-part-error' : undefined" />
            <p v-if="!editedPartNumber.trim()" id="edit-part-error" class="field-error">请输入非空零件号。</p>
            <button :disabled="saving || filesBusy || graphBusy || !editedPartNumber.trim()"><AppIcon name="check" />{{ saving ? '正在保存…' : '保存零件号' }}</button>
            <button type="button" class="secondary" :disabled="saving" @click="editingProject = null">取消修改</button>
            <button type="button" class="secondary" :disabled="saving || filesBusy || graphBusy" @click="previewProjectDeletion"><AppIcon name="trash" />删除此项目…</button>
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
          <button type="submit" :disabled="saving || loading"><AppIcon name="plus" />{{ saving ? '正在保存…' : '创建项目' }}</button>
        </form>
        </template>
      </section>
    </div>

    <ProjectFiles v-if="activeProjectId && activeProject" v-show="view === 'files'" :key="`files-${activeProjectId}-${archiveRootRevision}`" v-model:version-order="versionOrder" :repository="repository" :project-id="activeProjectId" :project-name="activeProject.name" :archive-roots="archiveRoots" @busy="filesPanelBusy = $event" />
    <VersionGraph v-if="activeProjectId && view === 'graph'" :key="`graph-${activeProjectId}-${archiveRootRevision}`" v-model:version-order="versionOrder" :repository="repository" :project-id="activeProjectId" :archive-roots="archiveRoots" @busy="graphBusy = $event" @documents="view = 'documents'" />
    <ComparisonDocuments v-if="activeProjectId && activeProject" v-show="view === 'documents'" :key="`documents-${activeProjectId}-${archiveRootRevision}`" :repository="repository" :project-id="activeProjectId" :project-name="activeProject.name" :archive-roots="archiveRoots" @busy="documentsBusy = $event" @graph="view = 'graph'" />
    </div>

    <section class="notice" aria-labelledby="storage-title">
      <div class="notice-mark" aria-hidden="true">i</div>
      <div>
        <h2 id="storage-title">配置保存在当前浏览器</h2>
        <p>清除浏览器数据可能丢失配置；迁移前请导出 JSON。</p>
      </div>
    </section>
    <footer><span>IQAN Archive</span><span>静态前端 · 无需登录 · 不依赖启动器</span></footer>
  </main>
</template>
