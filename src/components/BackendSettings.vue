<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import { backendAddress, checkLocalBackend, DEFAULT_BACKEND_PORT, parseBackendPort } from '../local-backend';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository }>();
const dialog = ref<HTMLDialogElement>();
const trigger = ref<HTMLButtonElement>();
const portInput = ref<HTMLInputElement>();
const errorHeading = ref<HTMLElement>();
const port = ref(String(DEFAULT_BACKEND_PORT));
const savedPort = ref(DEFAULT_BACKEND_PORT);
const loading = ref(false);
const loadFailed = ref(false);
const saving = ref(false);
const testing = ref(false);
const fieldError = ref('');
const error = ref('');
const message = ref('');
const busy = computed(() => loading.value || saving.value || testing.value);
const savedAddress = computed(() => backendAddress(savedPort.value));
let request: AbortController | undefined;
let loadAttempt = 0;

watch(port, () => { fieldError.value = ''; error.value = ''; message.value = ''; });

function validate(): number | undefined {
  try {
    const value = parseBackendPort(port.value);
    fieldError.value = '';
    return value;
  } catch (cause) {
    fieldError.value = cause instanceof Error ? cause.message : '端口无效。';
    return undefined;
  }
}

async function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '本机后端设置操作失败，请重试。';
  message.value = '';
  await nextTick();
  errorHeading.value?.focus();
}

async function restore() {
  const attempt = ++loadAttempt;
  loading.value = true;
  loadFailed.value = false;
  error.value = '';
  message.value = '';
  try {
    const value = await props.repository.getBackendPort();
    if (attempt !== loadAttempt) return;
    savedPort.value = value;
    port.value = String(value);
  } catch (cause) {
    if (attempt !== loadAttempt) return;
    loadFailed.value = true;
    await showError(cause);
  } finally {
    if (attempt === loadAttempt) loading.value = false;
  }
}

async function open() {
  fieldError.value = '';
  dialog.value?.showModal();
  await restore();
  if (!loadFailed.value && dialog.value?.open) {
    await nextTick();
    portInput.value?.focus();
  }
}

function closed() {
  ++loadAttempt;
  request?.abort();
  trigger.value?.focus();
}

async function save() {
  const value = validate();
  if (value === undefined) { portInput.value?.focus(); return; }
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    await props.repository.setBackendPort(value);
    savedPort.value = value;
    message.value = '端口已保存到本机，尚未检测连接。项目存储未切换。';
  } catch (cause) {
    await showError(cause);
  } finally {
    saving.value = false;
  }
}

async function testConnection() {
  const value = validate();
  if (value === undefined) { portInput.value?.focus(); return; }
  const controller = new AbortController();
  request = controller;
  testing.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await checkLocalBackend(value, controller.signal);
    if (controller.signal.aborted) return;
    message.value = `检测时 ${backendAddress(value)} 服务可用，${result.initialized ? '管理员已初始化' : '管理员尚未初始化，请运行 init-admin'}。${value === savedPort.value ? '' : '此端口尚未保存。'}项目存储未切换。`;
  } catch (cause) {
    if (!controller.signal.aborted) await showError(cause);
  } finally {
    if (request === controller) {
      testing.value = false;
      request = undefined;
    }
  }
}

onUnmounted(() => { ++loadAttempt; request?.abort(); });
</script>

<template>
  <button ref="trigger" type="button" class="secondary" @click="open"><AppIcon name="computer" />本机后端</button>
  <dialog ref="dialog" class="branch-move-dialog backend-settings" aria-labelledby="backend-settings-title" @close="closed" @cancel="saving && $event.preventDefault()">
    <h2 id="backend-settings-title">本机后端设置</h2>
    <p class="form-help">仅配置此浏览器连接本机服务的端口，不修改后端配置或数据库位置。当前项目仍存于本机 IndexedDB。</p>
    <div v-if="error" class="backend-settings-error" role="alert">
      <h3 ref="errorHeading" tabindex="-1">操作未完成</h3>
      <p>{{ error }}</p>
    </div>
    <p v-if="loading" role="status">正在读取本机设置…</p>
    <button v-if="loadFailed" type="button" class="secondary" :disabled="busy" @click="restore">重试读取设置</button>
    <form @submit.prevent="save">
      <label for="backend-port">本机服务端口</label>
      <input id="backend-port" ref="portInput" v-model="port" type="text" inputmode="numeric" maxlength="5"
        :disabled="busy || loadFailed" :aria-invalid="!!fieldError" aria-describedby="backend-port-help backend-port-error" @blur="validate">
      <p id="backend-port-error" class="backend-settings-error" aria-live="polite">{{ fieldError }}</p>
      <p id="backend-port-help" class="form-help">1024–65535，默认 47831，须与服务 config.json 的 port 一致。地址固定为 127.0.0.1。</p>
      <p v-if="!loading && !loadFailed" class="form-help">当前配置地址：<code>{{ savedAddress }}</code></p>
      <p class="form-help">检测不会自动保存端口。若浏览器询问本地网络访问权限，请按公司策略授权；最长等待 65 秒。</p>
      <div class="backup-actions">
        <button type="submit" :disabled="busy || loadFailed">{{ saving ? '正在保存…' : '保存端口' }}</button>
        <button type="button" class="secondary" :disabled="busy || loadFailed" @click="testConnection">{{ testing ? '正在检测…' : '检测此端口' }}</button>
        <button type="button" class="secondary" :disabled="saving" @click="dialog?.close()">关闭</button>
      </div>
    </form>
    <p v-if="!message && !testing && !loading && !error" class="form-help">尚未检测连接；此处不提供登录或共享项目同步。</p>
    <p v-if="testing || message" class="form-help" role="status">{{ testing ? '正在检测本机服务与数据库，请稍候…' : message }}</p>
  </dialog>
</template>

<style scoped>
.backend-settings h2 { font-size: 18px; }
.backend-settings .backup-actions button { width: auto; min-width: 0; flex: 1 1 100px; }
.backend-settings-error { color: var(--danger); font-size: 13px; overflow-wrap: anywhere; }
.backend-settings-error h3 { color: inherit; }
.backend-settings-error:empty { display: none; }
.backend-settings input { margin-bottom: 6px; }
.backend-settings code { overflow-wrap: anywhere; }
</style>
