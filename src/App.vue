<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { liveQuery } from 'dexie';
import { ArchiveDatabase, ArchiveRepository } from './storage/database';
import type { Project, ProjectGraph } from './domain/model';
import ProjectFiles from './components/ProjectFiles.vue';
import VersionGraph from './components/VersionGraph.vue';
import AppIcon from './components/AppIcon.vue';

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
const filesBusy = ref(false);
const graphBusy = ref(false);
const view = ref<'files' | 'graph'>('files');
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
    status.value = '零件号已保存，版本图与本机目录绑定未改变。请重新扫描工程目录；原磁盘文件未改名。';
  } catch (cause) {
    showError(cause);
  } finally {
    saving.value = false;
  }
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
    <section class="intro" aria-labelledby="page-title">
      <div>
        <p class="eyebrow">ENGINEERING WORKSPACE</p>
        <h1 id="page-title">工程版本工作台<span class="title-accent">.</span></h1>
        <p class="lead">为 IQAN 工程建立清晰的项目边界。配置留在本机，原始文件留在原目录。</p>
      </div>
      <span class="stage">SPEC-02 · 项目与版本图</span>
    </section>

    <div v-if="error" class="error" role="alert">
      <h2 ref="errorHeading" tabindex="-1">操作未完成</h2>
      <p>{{ error }}</p>
      <ul v-if="nameError || partError">
        <li v-if="nameError"><a href="#project-name">检查项目名称</a></li>
        <li v-if="partError"><a href="#part-number">检查软件零件号</a></li>
      </ul>
      <button type="button" class="secondary" :disabled="saving" @click="watchProjects">重新连接存储</button>
    </div>
    <p role="status" class="status">{{ status }}</p>

    <div :class="['app-workspace', { 'has-project': activeProjectId }]">
    <div class="workspace-grid">
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
        <ul v-else class="project-list">
          <li v-for="project in projects" :key="project.id">
            <div class="project-symbol"><AppIcon name="folder" /></div>
            <div class="project-info">
              <div class="project-title-line">
                <h3>{{ project.name }}</h3>
                <span class="project-state">已保存</span>
              </div>
              <button class="project-part-number" :disabled="saving || filesBusy || graphBusy" :aria-label="`修改 ${project.name} 的零件号`" :title="`修改零件号 ${project.partNumber}`" @click="editPartNumber(project)"><code>{{ project.partNumber }}</code></button>
            </div>
            <div class="project-actions">
              <button class="secondary icon-button" :disabled="filesBusy || graphBusy" :aria-label="`管理 ${project.name} 文件`" :title="`管理 ${project.name} 文件`" :aria-pressed="activeProjectId === project.id && view === 'files'" @click="activeProjectId = project.id; view = 'files'"><AppIcon name="file" /></button>
              <button class="secondary icon-button" :disabled="filesBusy || graphBusy" :aria-label="`查看 ${project.name} 版本图`" :title="`查看 ${project.name} 版本图`" :aria-pressed="activeProjectId === project.id && view === 'graph'" @click="activeProjectId = project.id; view = 'graph'"><AppIcon name="branch" /></button>
            </div>
          </li>
        </ul>
        <p class="boundary">选择项目进入文件工作区或版本图，点击零件号可修改。文件按扫描结果自动关联，不写入版本图配置。</p>
      </section>

      <section class="panel" aria-labelledby="create-title">
        <template v-if="deletion">
          <p class="eyebrow">DELETE PROJECT</p>
          <h2 id="create-title">确认删除项目</h2>
          <p class="form-help">将永久删除“{{ deletion.project.name }}”（{{ deletion.project.partNumber }}）的 {{ deletion.nodes.length }} 个版本、{{ deletion.edges.length }} 条父边、{{ deletion.branches.length }} 个分支、{{ deletion.tasks.length }} 个任务及浏览器目录绑定，包括已放行版本。</p>
          <p class="form-help">不会删除磁盘上的工程或软件对比文档，不影响其他项目。本操作不可撤销，当前尚无 JSON 备份界面。</p>
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
          <p class="form-help">{{ editingProject.name }} · 不改变版本图或目录绑定，不重命名磁盘文件。保存后请重新扫描。</p>
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
        <p class="form-help">相同零件号可以用于不同项目，内部身份独立保存。</p>
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

    <ProjectFiles v-if="activeProjectId" v-show="view === 'files'" :key="`files-${activeProjectId}`" :repository="repository" :project-id="activeProjectId" @busy="filesBusy = $event" />
    <VersionGraph v-if="activeProjectId && view === 'graph'" :key="`graph-${activeProjectId}`" :repository="repository" :project-id="activeProjectId" @busy="graphBusy = $event" />
    </div>

    <section class="notice" aria-labelledby="storage-title">
      <div class="notice-mark" aria-hidden="true">i</div>
      <div>
        <h2 id="storage-title">本地存储，不等于永久备份</h2>
        <p>项目配置保存在当前站点的浏览器 IndexedDB 中，不上传云端。清除浏览器数据可能导致配置丢失。工程和软件对比文档原文件不存入数据库；JSON 备份与恢复将在 SPEC-03 提供，当前尚不可用。</p>
      </div>
    </section>
    <footer><span>IQAN Archive</span><span>静态前端 · 无需登录 · 不依赖启动器</span></footer>
  </main>
</template>
