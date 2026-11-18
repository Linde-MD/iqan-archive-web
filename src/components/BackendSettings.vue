<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import { buildStartBackendUri } from '../domain/iqan-protocol';
import { BACKEND_PROBE_TIMEOUT_MS, DEFAULT_BACKEND_HOSTS, backendAddress, parseBackendHosts } from '../local-backend';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; disabled?: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const dialog = ref<HTMLDialogElement>();
const noticeDialog = ref<HTMLDialogElement>();
const noticeHeading = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const hostInput = ref<HTMLInputElement>();
const testTrigger = ref<HTMLButtonElement>();
const errorHeading = ref<HTMLElement>();
const hosts = ref<string[]>([]);
const newHost = ref('');
const savedHosts = ref<string[]>([]);
const loading = ref(false);
const loadFailed = ref(false);
const saving = ref(false);
const testing = ref(false);
const fieldError = ref('');
const error = ref('');
const message = ref('');
const connection = props.repository.db.backendConnection.state;
const isTesting = computed(() => testing.value || connection.testing);
const busy = computed(() => loading.value || saving.value || isTesting.value);
const selectedAddress = computed(() => connection.host ? backendAddress(connection.host) : '');
const dirty = computed(() => hosts.value.join('\n') !== savedHosts.value.join('\n'));
const probes = computed(() => new Map(connection.results.map(result => [result.host, result])));
const completedCount = computed(() => hosts.value.filter(host => probes.value.has(host)).length);
const availableCount = computed(() => hosts.value.filter(host => probes.value.get(host)?.available).length);
let request: AbortController | undefined;
let loadAttempt = 0;
let noticeReturnTarget: HTMLElement | null = null;

watch(() => connection.notice, async notice => {
  await nextTick();
  if (notice !== connection.notice) return;
  if (notice && noticeDialog.value) {
    noticeReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!noticeDialog.value.open) noticeDialog.value.showModal();
    noticeHeading.value?.focus();
  } else if (noticeDialog.value?.open) {
    noticeDialog.value.close();
    if (noticeReturnTarget?.isConnected) noticeReturnTarget.focus();
  }
}, { flush: 'post' });

watch([hosts, newHost], () => { fieldError.value = ''; error.value = ''; message.value = ''; }, { flush: 'sync' });

function statusLabel(host: string) {
  const result = probes.value.get(host);
  if (!result) return isTesting.value ? '检测中' : '未测试';
  return result.available ? (result.initialized ? '可连接' : '可连接 · 待初始化') : '不可连接';
}

function addHosts(): boolean {
  try {
    const added = parseBackendHosts(newHost.value.split(/[\s,，]+/));
    if (!added.length) throw new Error('请先输入设备名。');
    const next = parseBackendHosts([...hosts.value, ...added]);
    const count = next.length - hosts.value.length;
    hosts.value = next;
    newHost.value = '';
    message.value = count ? `已添加 ${count} 台设备，请保存后测试。` : '设备已在列表中，无需重复添加。';
    hostInput.value?.focus();
    return true;
  } catch (cause) {
    fieldError.value = cause instanceof Error ? cause.message : '设备名无效。';
    hostInput.value?.focus();
    return false;
  }
}

async function removeHost(host: string) {
  hosts.value = hosts.value.filter(value => value !== host);
  message.value = '设备已从待保存列表移除，请保存更改。';
  await nextTick();
  hostInput.value?.focus();
}

async function useDefaults() {
  hosts.value = [...DEFAULT_BACKEND_HOSTS];
  newHost.value = '';
  message.value = '已填入四台默认设备，请保存后测试。';
  await nextTick();
  hostInput.value?.focus();
}

async function showError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : '后端主机设置操作失败，请重试。';
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
  newHost.value = '';
  try {
    const value = await props.repository.getBackendHosts();
    if (attempt !== loadAttempt) return;
    savedHosts.value = [...value];
    hosts.value = value;
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
    hostInput.value?.focus();
  }
}

function closed() {
  ++loadAttempt;
  request?.abort();
  trigger.value?.focus();
}

async function save() {
  if (newHost.value.trim() && !addHosts()) return;
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    await props.repository.setBackendHosts(hosts.value);
    savedHosts.value = [...hosts.value];
    emit('saved');
    message.value = '设备列表已保存，原连接已清除。请测试连接，再登录或重新连接。';
  } catch (cause) {
    await showError(cause);
  } finally {
    saving.value = false;
    await nextTick();
    if (dialog.value?.open && !error.value) hostInput.value?.focus();
  }
}

async function testConnection() {
  if (dirty.value || newHost.value.trim()) { await showError(new Error('请先保存设备列表，再测试连接。')); return; }
  const controller = new AbortController();
  request = controller;
  testing.value = true;
  error.value = '';
  message.value = '';
  try {
    const result = await props.repository.testBackendHosts(controller.signal);
    if (controller.signal.aborted) return;
    message.value = result.initialized
      ? '已选定唯一主机。请在账号入口登录或重新连接，共享项目不会自动同步。'
      : '已找到唯一主机，管理员尚未初始化，请在后端运行 init-admin。';
  } catch (cause) {
    if (!controller.signal.aborted) await showError(cause);
  } finally {
    if (request === controller) {
      testing.value = false;
      request = undefined;
      await nextTick();
      if (dialog.value?.open && !error.value) testTrigger.value?.focus();
    }
  }
}

function startBackend() {
  error.value = '';
  message.value = '已请求 Launcher 启动本机后端，请在 Launcher 确认。网页无法确认启动结果，请随后重新测试。';
  window.location.assign(buildStartBackendUri());
}

onUnmounted(() => { ++loadAttempt; request?.abort(); });
</script>

<template>
  <button ref="trigger" type="button" class="secondary" :disabled="disabled" @click="open"><AppIcon name="computer" />后端主机</button>
  <dialog ref="dialog" class="branch-move-dialog backend-settings" aria-labelledby="backend-settings-title" @close="closed" @cancel="saving && $event.preventDefault()">
    <header class="backend-settings-header">
      <div class="backend-heading">
        <span class="backend-heading-icon"><AppIcon name="computer" /></span>
        <div><h2 id="backend-settings-title">后端主机设置</h2><p>管理候选设备，自动发现唯一在线主机</p></div>
      </div>
      <button type="button" class="icon-button" aria-label="关闭后端主机设置" :disabled="saving" @click="dialog?.close()"><AppIcon name="clear" /></button>
    </header>
    <div class="backend-settings-content">
      <section class="backend-connection" :class="{ 'is-connected': !!connection.host }" aria-label="当前后端连接">
        <AppIcon :name="connection.host ? 'check' : isTesting ? 'scan' : 'computer'" />
        <div class="backend-connection-main">
          <span class="backend-eyebrow">当前后端地址</span>
          <code v-if="selectedAddress">{{ selectedAddress }}</code>
          <strong v-else>{{ isTesting ? '正在发现主机…' : '尚未选定主机' }}</strong>
          <span class="backend-connection-hint">{{ isTesting ? `已完成 ${completedCount} / ${hosts.length} 台检测` : '只有一台可连接时，才会启用该地址' }}</span>
        </div>
        <div class="backend-connection-tags"><span>HTTP 80</span><span>{{ BACKEND_PROBE_TIMEOUT_MS / 1000 }} 秒超时</span></div>
      </section>
      <div v-if="error" class="backend-feedback backend-feedback-error" role="alert">
        <AppIcon name="status-not-started" />
        <div><h3 ref="errorHeading" tabindex="-1">操作未完成</h3><p>{{ error }}</p></div>
      </div>
      <p v-if="loading" role="status">正在读取本机设置…</p>
      <button v-if="loadFailed" type="button" class="secondary" :disabled="busy" @click="restore">重试读取设置</button>
      <section aria-labelledby="backend-devices-title">
        <div class="backend-section-heading">
          <h3 id="backend-devices-title">候选设备 <span>{{ hosts.length }} 台</span></h3>
          <button type="button" class="backend-text-button" :disabled="busy || loadFailed" @click="useDefaults"><AppIcon name="undo" />恢复默认</button>
        </div>
        <form class="backend-add-form" @submit.prevent="addHosts">
          <label for="backend-host">添加设备</label>
          <div class="backend-add-row">
            <input id="backend-host" ref="hostInput" v-model="newHost" type="text" spellcheck="false" autocapitalize="off" autocomplete="off"
              placeholder="输入设备名或 DNS 主机名" :disabled="busy || loadFailed" :aria-invalid="!!fieldError" aria-describedby="backend-host-help backend-host-error">
            <button type="submit" class="secondary" :disabled="busy || loadFailed || !newHost.trim()"><AppIcon name="plus" />添加</button>
          </div>
          <p id="backend-host-error" class="backend-field-error" aria-live="polite">{{ fieldError }}</p>
          <p id="backend-host-help" class="backend-help-text">可用空格或逗号批量添加，不限数量；不填 IP、协议、端口或路径。</p>
        </form>
        <div class="backend-results-heading" role="status">
          <span>{{ isTesting ? '正在并行检测所有设备' : completedCount ? '最近检测结果' : '等待测试连接' }}</span>
          <span>{{ isTesting ? `${completedCount} / ${hosts.length} 已完成` : completedCount ? `${availableCount} 台可连接` : '每台最多 3 秒' }}</span>
        </div>
        <ul v-if="hosts.length" class="backend-device-grid" aria-label="候选设备与连接测试结果" :aria-busy="isTesting">
          <li v-for="host in hosts" :key="host" class="backend-device"
            :class="{ 'is-reachable': probes.get(host)?.available, 'is-unreachable': probes.has(host) && !probes.get(host)?.available, 'is-selected': connection.host === host }">
            <div class="backend-device-main">
              <span class="backend-device-icon"><AppIcon name="computer" /></span>
              <div class="backend-device-identity">
                <strong>{{ host.toUpperCase() }}</strong>
                <span class="backend-device-status">
                  <AppIcon :name="probes.get(host)?.available ? 'check' : probes.has(host) ? 'clear' : isTesting ? 'status-in-progress' : 'status-default'" />
                  {{ statusLabel(host) }}
                </span>
              </div>
              <button type="button" class="icon-button backend-device-remove" :aria-label="`移除设备 ${host.toUpperCase()}`" :disabled="busy || loadFailed" @click="removeHost(host)"><AppIcon name="trash" /></button>
            </div>
            <span v-if="connection.host === host" class="backend-selected-label">当前主机</span>
            <details v-if="probes.get(host)?.error" class="backend-device-error"><summary>查看失败原因</summary><p>{{ probes.get(host)?.error }}</p></details>
          </li>
        </ul>
        <p v-else-if="!loading" class="backend-empty">尚未添加设备，请输入设备名或恢复默认列表。</p>
      </section>
      <details class="backend-help">
        <summary>连接帮助与本机启动</summary>
        <p>请确认设备名能够解析、后端已运行且允许 80 端口入站；网页来源须列入 allowedOrigins。如浏览器询问本地网络权限，请按公司策略授权。探测不代表已登录。</p>
        <button type="button" class="secondary" :disabled="busy" @click="startBackend"><AppIcon name="computer" />启动本机后端</button>
        <p>Launcher 只能请求启动当前电脑的后端，不能启动远程设备；网页无法确认启动结果。</p>
      </details>
    </div>
    <footer class="backend-settings-footer">
      <p v-if="dirty || newHost.trim()" class="backend-unsaved">设备列表有未保存的更改，保存后需重新测试。</p>
      <p v-if="message" class="backend-message" role="status">{{ message }}</p>
      <div class="backend-footer-actions">
        <button type="button" class="secondary" :disabled="busy || loadFailed" @click="save">{{ saving ? '正在保存…' : '保存设备列表' }}</button>
        <button ref="testTrigger" type="button" :disabled="busy || loadFailed || dirty || !!newHost.trim()" @click="testConnection"><AppIcon name="scan" />{{ isTesting ? '正在测试…' : '测试连接' }}</button>
      </div>
      <p class="backend-safety">团队仅运行一台后端 · HTTP 不加密，仅用于获准的可信局域网</p>
    </footer>
  </dialog>
  <dialog ref="noticeDialog" class="branch-move-dialog backend-notice" aria-labelledby="backend-notice-title"
    @cancel.prevent="connection.notice = null">
    <h2 id="backend-notice-title" ref="noticeHeading" tabindex="-1">{{ connection.notice?.title }}</h2>
    <p>{{ connection.notice?.message }}</p>
    <p class="form-help">当前操作未自动重发；结果未确认时，请保留原请求，勿重复提交。</p>
    <button type="button" @click="connection.notice = null">我知道了</button>
  </dialog>
</template>

<style scoped>
.backend-notice p { overflow-wrap: anywhere; line-height: 1.7; }
.backend-notice h2 { font-size: 18px; }
.backend-settings { width: min(720px, calc(100% - 24px)); max-height: calc(min(100dvh, 100vh) - 24px); padding: 0; scroll-padding: 16px 0 200px; overscroll-behavior: contain; }
.backend-settings-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 24px 24px 20px; }
.backend-heading { display: flex; gap: 12px; align-items: center; min-width: 0; }
.backend-heading-icon, .backend-device-icon { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border-radius: 10px; background: var(--surface-raised); color: var(--accent); }
.backend-settings h2 { margin: 0; font-size: 20px; }
.backend-heading p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.backend-settings-header > button { margin: -4px -8px 0 0; }
.backend-settings-content { display: grid; gap: 20px; padding: 0 24px 20px; }
.backend-connection { display: flex; align-items: center; gap: 14px; padding: 18px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface-soft); }
.backend-connection > .app-icon { width: 24px; height: 24px; color: var(--accent); }
.backend-connection.is-connected { border-color: var(--success); }
.backend-connection.is-connected > .app-icon { color: var(--success); }
.backend-connection-main { display: grid; gap: 6px; flex: 1; min-width: 0; }
.backend-eyebrow, .backend-connection-hint { color: var(--muted); font-size: 12px; }
.backend-connection-main code, .backend-connection-main strong { color: var(--ink); font-size: 16px; overflow-wrap: anywhere; }
.backend-connection-tags { display: grid; gap: 6px; flex-shrink: 0; }
.backend-connection-tags span { padding: 4px 8px; border-radius: 5px; background: var(--canvas); color: var(--muted); font-size: 11px; text-align: center; }
.backend-section-heading, .backend-results-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.backend-section-heading h3 { margin: 0; font-size: 15px; }
.backend-section-heading h3 span { margin-left: 6px; color: var(--muted); font-size: 12px; font-weight: 400; }
.backend-text-button { padding: 8px; background: transparent; color: var(--accent); }
.backend-text-button:hover { background: var(--surface-raised); }
.backend-text-button .app-icon { width: 16px; height: 16px; }
.backend-add-form { margin-top: 8px; }
.backend-add-form label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
.backend-add-row { display: flex; gap: 8px; }
.backend-add-row input { flex: 1; min-width: 0; width: 100%; margin: 0; min-height: 44px; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--canvas); color: var(--ink); font-family: inherit; }
.backend-add-row input::placeholder { color: var(--muted); }
.backend-add-row button { flex-shrink: 0; width: auto; }
.backend-help-text { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.backend-field-error { margin: 8px 0 0; color: var(--danger); font-size: 13px; overflow-wrap: anywhere; }
.backend-field-error:empty { display: none; }
.backend-results-heading { margin: 20px 0 10px; color: var(--muted); font-size: 12px; }
.backend-device-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 0; margin: 0; list-style: none; }
.backend-device { min-width: 0; padding: 12px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface-soft); }
.backend-device.is-selected { border-color: var(--success); background: var(--surface-raised); }
.backend-device-main { display: flex; align-items: center; gap: 10px; }
.backend-device-icon { flex-basis: 34px; width: 34px; height: 34px; border-radius: 7px; background: var(--canvas); }
.backend-device-icon .app-icon { width: 18px; height: 18px; }
.backend-device-identity { flex: 1; min-width: 0; }
.backend-device-identity > strong { display: block; font-family: ui-monospace, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.backend-device-status { display: flex; align-items: center; gap: 5px; margin-top: 7px; color: var(--muted); font-size: 12px; }
.backend-device-status .app-icon { width: 14px; height: 14px; }
.is-reachable .backend-device-status { color: var(--success); }
.is-unreachable .backend-device-status { color: var(--danger); }
.backend-device-remove { color: var(--muted); margin-right: -6px; }
.backend-device-remove .app-icon { width: 16px; height: 16px; }
.backend-selected-label { display: inline-block; margin: 10px 0 0 44px; color: var(--success); font-size: 11px; }
.backend-device-error { margin: 8px 0 -4px; border-top: 1px solid var(--border); }
.backend-device-error summary, .backend-help summary { display: flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; color: var(--muted); font-size: 12px; list-style: none; }
.backend-device-error summary::before, .backend-help summary::before { content: ''; width: 6px; height: 6px; flex-shrink: 0; border-right: 1px solid var(--accent); border-bottom: 1px solid var(--accent); transform: rotate(-45deg); }
.backend-device-error[open] summary::before, .backend-help[open] summary::before { transform: rotate(45deg); }
.backend-device-error p, .backend-help p { margin: 0 0 10px; color: var(--muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.backend-empty { padding: 24px 12px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--muted); font-size: 13px; text-align: center; }
.backend-help { border-top: 1px solid var(--border); }
.backend-help button { margin-bottom: 10px; }
.backend-feedback { display: flex; align-items: flex-start; gap: 10px; padding: 14px; border: 1px solid var(--danger); border-radius: 8px; background: var(--canvas); }
.backend-feedback-error { color: var(--danger); }
.backend-feedback h3 { margin: 0; color: inherit; font-size: 14px; }
.backend-feedback p { margin: 6px 0 0; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.backend-settings-footer { display: block; position: sticky; bottom: 0; padding: 16px 24px; border-top: 1px solid var(--border); background: var(--surface); }
.backend-footer-actions { display: flex; justify-content: flex-end; gap: 10px; }
.backend-footer-actions button { min-width: 140px; }
.backend-unsaved, .backend-message { margin: 0 0 12px; font-size: 12px; line-height: 1.6; }
.backend-unsaved { color: var(--warning); }
.backend-message { color: var(--ink); }
.backend-safety { margin: 12px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; text-align: right; }
@media (max-width: 600px) {
  .backend-settings { scroll-padding-bottom: 16px; }
  .backend-settings-header { padding: 20px 16px 16px; }
  .backend-settings-content { padding: 0 16px 16px; gap: 16px; }
  .backend-settings h2 { font-size: 18px; }
  .backend-heading-icon { display: none; }
  .backend-connection { padding: 14px; gap: 10px; flex-wrap: wrap; }
  .backend-connection-tags { display: flex; margin-left: 34px; }
  .backend-device-grid { grid-template-columns: minmax(0, 1fr); }
  .backend-settings-footer { position: static; padding: 16px; }
  .backend-footer-actions button { flex: 1; min-width: 0; }
  .backend-safety { text-align: left; }
}
</style>
