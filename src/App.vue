<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { liveQuery } from 'dexie';
import { ArchiveDatabase, ArchiveRepository } from './storage/database';
import type { Project } from './domain/model';
import ProjectFiles from './components/ProjectFiles.vue';
import VersionGraph from './components/VersionGraph.vue';
import AppIcon from './components/AppIcon.vue';

const db = new ArchiveDatabase();
const repository = new ArchiveRepository(db);
const projects = ref<Project[]>([]);
const name = ref('');
const partNumber = ref('');
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
      next: value => { projects.value = value; loading.value = false; },
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
              <p><code>{{ project.partNumber }}</code></p>
            </div>
            <div class="project-actions">
              <button class="secondary icon-button" :disabled="filesBusy || graphBusy" :aria-label="`管理 ${project.name} 文件`" :title="`管理 ${project.name} 文件`" :aria-pressed="activeProjectId === project.id && view === 'files'" @click="activeProjectId = project.id; view = 'files'"><AppIcon name="file" /></button>
              <button class="secondary icon-button" :disabled="filesBusy || graphBusy" :aria-label="`查看 ${project.name} 版本图`" :title="`查看 ${project.name} 版本图`" :aria-pressed="activeProjectId === project.id && view === 'graph'" @click="activeProjectId = project.id; view = 'graph'"><AppIcon name="branch" /></button>
            </div>
          </li>
        </ul>
        <p class="boundary">选择项目进入文件工作区或版本图。文件与图共享同一项目配置。</p>
      </section>

      <section class="panel" aria-labelledby="create-title">
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
      </section>
    </div>

    <ProjectFiles v-if="activeProjectId && view === 'files'" :key="`files-${activeProjectId}`" :repository="repository" :project-id="activeProjectId" @busy="filesBusy = $event" />
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
