<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { parseInboxList, parseInboxSummary, type CommentNotification, type InboxSummary } from '../domain/comment-inbox';
import type { TaskAssignee } from '../domain/model';
import { CollaborationError, type CollaborationRepository } from '../storage/collaboration';
import { startProjectPolling } from '../storage/project-polling';
import { accountAvatarTheme, accountInitials } from '../domain/account';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  client: CollaborationRepository;
  scope: string;
  directoryKey: number;
  directoryActive: boolean;
  openTarget: (notice: CommentNotification) => Promise<void>;
}>();
const emit = defineEmits<{ capability: [supported: boolean]; directory: [users: TaskAssignee[]]; status: [message: string] }>();
const trigger = ref<HTMLButtonElement>();
const dialog = ref<HTMLDialogElement>();
const opened = ref(false);
const summary = shallowRef<InboxSummary>();
const items = shallowRef<CommentNotification[]>([]);
const listRevision = ref<number>();
const filter = ref<'latest' | 'mentions'>('latest');
const unreadOnly = ref(false);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const supported = ref<boolean>();
const visibleItems = computed(() => items.value.filter(item =>
  (filter.value === 'latest' || item.mention) && (!unreadOnly.value || !item.read)));
const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
let stop: (() => void) | undefined;
let controller: AbortController | undefined;
let loadedDirectoryKey: number | undefined;
let actionController: AbortController | undefined;
let actionGeneration = 0;

async function check(signal?: AbortSignal, replace = false) {
  if (!props.scope || document.visibilityState !== 'visible' || signal?.aborted || busy.value) return;
  if (controller && !replace) return;
  controller?.abort();
  const active = new AbortController();
  controller = active;
  const scope = props.scope;
  const requestSignal = signal ? AbortSignal.any([signal, active.signal]) : active.signal;
  const current = () => !requestSignal.aborted && props.scope === scope;
  loading.value = true;
  try {
    const meta = parseInboxSummary(await props.client.request('/inbox/summary', 'GET', undefined, undefined, requestSignal));
    if (!current()) return;
    supported.value = true;
    summary.value = meta;
    if (opened.value && listRevision.value !== meta.revision) {
      const result = await props.client.request('/inbox/list', 'GET', undefined, undefined, requestSignal);
      if (!current()) return;
      const state = parseInboxList(result);
      summary.value = { revision: state.revision, unreadCount: state.unreadCount };
      items.value = state.items;
      listRevision.value = state.revision;
    }
    if (props.directoryActive && loadedDirectoryKey !== props.directoryKey) {
      const directoryKey = props.directoryKey;
      const users = await props.client.commentDirectory(requestSignal);
      if (!current() || props.directoryKey !== directoryKey || !props.directoryActive) return;
      loadedDirectoryKey = directoryKey;
      emit('directory', users);
    }
    emit('capability', true);
    error.value = '';
  } catch (cause) {
    if (!current()) return;
    if (cause instanceof CollaborationError && cause.status === 404 && cause.code === 'NOT_FOUND' && supported.value !== true) {
      supported.value = false;
      emit('capability', false);
      error.value = '当前后端版本不支持评论消息，请升级后端。';
    } else error.value = cause instanceof Error ? cause.message : '无法刷新消息。';
  } finally {
    if (controller === active) { controller = undefined; loading.value = false; }
  }
}

function open() {
  dialog.value?.showModal();
  opened.value = true;
  void check(undefined, true);
}

function retry() { void check(undefined, true); }
defineExpose({ retry });

watch([error, loading, supported, () => props.scope], () => {
  emit('status', !props.scope ? '请先连接后端并登录。' : error.value
    || (loading.value ? '正在检测协作评论功能…' : supported.value === true ? '' : '协作评论功能尚未确认，请重新检测。'));
}, { immediate: true });

async function read(id: string | undefined, signal: AbortSignal) {
  const scope = props.scope;
  const next = parseInboxSummary(await props.client.request('/inbox/read', 'POST', id ? { id } : {}, undefined, signal));
  if (props.scope !== scope || signal.aborted) return;
  summary.value = next;
  items.value = items.value.map(item => !id || item.id === id ? { ...item, read: true } : item);
  listRevision.value = undefined;
}

async function act(action: (signal: AbortSignal) => Promise<void>, reopenOnFailure = false) {
  if (busy.value || !props.scope) return;
  controller?.abort();
  const active = new AbortController();
  actionController = active;
  const generation = ++actionGeneration;
  const scope = props.scope;
  const current = () => !active.signal.aborted && generation === actionGeneration && props.scope === scope;
  busy.value = true;
  error.value = '';
  try { await action(active.signal); }
  catch (cause) {
    if (!current()) return;
    error.value = cause instanceof Error ? cause.message : '消息操作失败。';
    if (reopenOnFailure) {
      dialog.value?.showModal();
      opened.value = true;
    }
  } finally {
    if (generation === actionGeneration) { busy.value = false; actionController = undefined; }
  }
  if (current() && opened.value && !error.value) void check(undefined, true);
}

function visit(item: CommentNotification) {
  void act(async signal => {
    const scope = props.scope;
    dialog.value?.close();
    opened.value = false;
    await props.openTarget(item);
    if (props.scope !== scope || signal.aborted) return;
    if (!item.read) await read(item.id, signal);
  }, true);
}

function closed() {
  if (!dialog.value?.open) opened.value = false;
}

function dismiss() {
  actionController?.abort();
  actionGeneration++;
  busy.value = false;
  dialog.value?.close();
  opened.value = false;
  trigger.value?.focus();
}

function onVisibility() {
  if (document.visibilityState !== 'visible') controller?.abort();
}

watch(() => props.scope, () => {
  controller?.abort();
  actionController?.abort();
  actionGeneration++;
  busy.value = false;
  dialog.value?.close();
  opened.value = false;
  summary.value = undefined;
  items.value = [];
  listRevision.value = undefined;
  loadedDirectoryKey = undefined;
  supported.value = undefined;
  error.value = '';
  filter.value = 'latest';
  unreadOnly.value = false;
  emit('capability', false);
  emit('directory', []);
  if (stop) void check(undefined, true);
});
watch([() => props.directoryKey, () => props.directoryActive], () => {
  if (stop && props.directoryActive) void check(undefined, true);
});
onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  stop = startProjectPolling(document, signal => check(signal), 300_000);
  void check();
});
onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  stop?.();
  controller?.abort();
  actionController?.abort();
  actionGeneration++;
});
</script>

<template>
  <button v-if="scope" ref="trigger" class="secondary inbox-trigger" type="button" aria-haspopup="dialog"
    :aria-label="summary?.unreadCount ? `消息中心，${summary.unreadCount} 条未读` : '消息中心'" @click="open">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0" />
    </svg>
    <span v-if="summary?.unreadCount" class="inbox-badge" aria-hidden="true">{{ summary.unreadCount > 99 ? '99+' : summary.unreadCount }}</span>
  </button>
  <dialog ref="dialog" class="inbox-panel" aria-labelledby="inbox-title" @close="closed" @cancel.prevent="dismiss">
    <header class="inbox-header">
      <div>
        <h2 id="inbox-title">消息中心 <span v-if="summary?.unreadCount" class="inbox-count">{{ summary.unreadCount }} 未读</span></h2>
        <p>评论回复与 @ 提及</p>
      </div>
      <button class="secondary" type="button" autofocus @click="dismiss">关闭</button>
    </header>
    <div class="inbox-tabs" aria-label="消息筛选">
      <button class="secondary" type="button" :aria-pressed="filter === 'latest'" @click="filter = 'latest'">全部</button>
      <button class="secondary" type="button" :aria-pressed="filter === 'mentions'" @click="filter = 'mentions'">@我的</button>
      <button class="secondary inbox-refresh" type="button" :disabled="busy || loading" @click="retry"><AppIcon name="refresh" />刷新</button>
    </div>
    <div class="inbox-body" :aria-busy="loading">
      <div v-if="error" class="inbox-status inbox-error" role="alert">
        <strong>{{ listRevision === undefined ? '暂时无法读取消息' : '消息操作未完成' }}</strong>
        <p>{{ error }}</p>
        <button class="secondary" type="button" :disabled="busy || loading" @click="retry"><AppIcon name="refresh" />重试</button>
      </div>
      <div v-if="loading && listRevision === undefined" class="inbox-state" role="status">
        <AppIcon name="refresh" /><strong>正在读取消息…</strong><p>正在获取当前账号的评论通知</p>
      </div>
      <div v-else-if="!visibleItems.length && !error && listRevision !== undefined" class="inbox-state" role="status">
        <AppIcon name="reply" /><strong>{{ unreadOnly ? '没有未读消息' : filter === 'mentions' ? '暂无 @ 提及' : '暂无消息' }}</strong>
        <p>{{ unreadOnly ? '取消“仅看未读”可查看已读消息' : '新的评论回复和 @ 提及会显示在这里' }}</p>
      </div>
      <ul v-if="visibleItems.length" class="inbox-list">
      <li v-for="item in visibleItems" :key="item.id">
        <button class="secondary inbox-entry" type="button" :disabled="busy" @click="visit(item)">
          <span class="inbox-avatar" :style="{ background: accountAvatarTheme(item.actorId).background, color: accountAvatarTheme(item.actorId).foreground }" aria-hidden="true">{{ accountInitials(item.actorName) }}</span>
          <span class="inbox-content">
            <span><strong>{{ item.actorName }}</strong> <small>{{ item.reply && item.mention ? '回复并提到了你' : item.reply ? '回复了你的评论' : '在评论中提到了你' }}</small></span>
            <strong class="inbox-task">{{ item.taskName }}</strong>
            <small class="inbox-project">{{ item.projectName }}</small>
            <time :datetime="item.createdAt">{{ formatter.format(new Date(item.createdAt)) }}</time>
          </span>
          <small v-if="!item.read" class="inbox-unread">未读</small>
        </button>
        <button v-if="!item.read" class="secondary inbox-read" type="button" :disabled="busy" @click="act(signal => read(item.id, signal))">标为已读</button>
      </li>
      </ul>
    </div>
    <footer>
      <label><input v-model="unreadOnly" type="checkbox">仅看未读</label>
      <button class="secondary inbox-all" type="button" :disabled="busy || loading || !summary?.unreadCount" @click="act(signal => read(undefined, signal))"><AppIcon name="check" />全部已读</button>
    </footer>
  </dialog>
</template>

<style scoped>
.inbox-trigger { position: relative; display: inline-grid; place-items: center; width: 44px; min-height: 44px; padding: 0; }
.inbox-trigger svg { width: 19px; height: 19px; }
.inbox-badge { background: #792d49; color: #fff3f6; border-radius: 12px; padding: 2px 6px; font-size: 11px; }
.inbox-badge { position: absolute; top: 0; right: 0; }
.inbox-panel { position: fixed; inset: 12px 12px 12px auto; width: min(440px, calc(100% - 24px)); max-width: none; max-height: none; height: auto; margin: 0; padding: 0; background: var(--surface); color: var(--ink); border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: 0 16px 48px #0006; }
.inbox-panel[open] { display: flex; flex-direction: column; }
.inbox-panel::backdrop { background: #070d1866; }
.inbox-header, .inbox-tabs, footer { flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
.inbox-header { justify-content: space-between; }
.inbox-header h2 { margin: 0; font-size: 17px; }
.inbox-header p { margin: 6px 0 0; color: var(--muted); font-size: 12px; }
.inbox-count, .inbox-unread { display: inline-block; padding: 3px 6px; border-radius: 6px; background: #284570; color: var(--ink); font-size: 11px; white-space: nowrap; }
.inbox-count { margin-left: 4px; vertical-align: middle; }
.inbox-panel button { width: auto; min-height: 44px; }
.inbox-tabs button { border-color: transparent; background: transparent; }
.inbox-tabs button[aria-pressed='true'] { border-bottom-color: var(--accent); color: var(--focus); border-radius: 0; }
.inbox-refresh, .inbox-all { margin-left: auto; }
.inbox-body { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.inbox-status { color: var(--muted); overflow-wrap: anywhere; }
.inbox-error { padding: 16px; border: 1px solid var(--danger); border-radius: 8px; background: var(--surface-soft); }
.inbox-error strong { color: var(--danger); }
.inbox-error p { margin: 8px 0 12px; line-height: 1.6; font-size: 13px; }
.inbox-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 12px; text-align: center; }
.inbox-state > svg { width: 32px; height: 32px; color: var(--accent); }
.inbox-state p { margin: 0; line-height: 1.6; color: var(--muted); font-size: 13px; }
.inbox-list { list-style: none; margin: 0; padding: 0; }
.inbox-list li { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-soft); }
.inbox-list .inbox-entry { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 10px; text-align: left; background: transparent; border: 0; white-space: normal; overflow-wrap: anywhere; }
.inbox-entry:hover { background: var(--surface-raised); }
.inbox-avatar { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 100%; font-size: 12px; }
.inbox-content { display: grid; gap: 6px; min-width: 0; }
.inbox-task { font-size: 14px; line-height: 1.5; }
.inbox-entry small:not(.inbox-unread), .inbox-entry time { color: var(--muted); font-weight: 400; font-size: 12px; }
.inbox-project { overflow-wrap: anywhere; }
.inbox-read { display: flex; margin: 0 8px 4px auto; background: transparent; border: 0; color: var(--focus); }
footer { border-bottom: 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
footer label { width: auto; margin: 0; min-height: 44px; display: flex; align-items: center; gap: 8px; white-space: nowrap; cursor: pointer; }
footer input[type='checkbox'] { width: 18px; height: 18px; min-height: 0; margin: 0; padding: 0; flex: 0 0 18px; accent-color: var(--accent); }
@media (max-width: 480px) {
  .inbox-header, .inbox-tabs, footer { padding-inline: 12px; }
  .inbox-body { padding: 12px; }
  .inbox-panel button { padding-inline: 12px; }
}
</style>
