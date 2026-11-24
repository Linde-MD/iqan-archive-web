<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { CommentNotification, InboxSummary } from '../domain/comment-inbox';
import type { TaskAssignee } from '../domain/model';
import { CollaborationError, type CollaborationRepository } from '../storage/collaboration';
import { startProjectPolling } from '../storage/project-polling';

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

function decodeSummary(value: unknown): InboxSummary {
  if (!value || typeof value !== 'object' || !('revision' in value) || !('unreadCount' in value)
    || typeof value.revision !== 'number' || typeof value.unreadCount !== 'number'
    || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.unreadCount)
    || value.revision < 0 || value.unreadCount < 0) throw new Error('消息摘要格式无效。');
  return { revision: value.revision, unreadCount: value.unreadCount };
}

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
    const meta = decodeSummary(await props.client.request('/inbox/summary', 'GET', undefined, undefined, requestSignal));
    if (!current()) return;
    supported.value = true;
    summary.value = meta;
    if (opened.value && listRevision.value !== meta.revision) {
      const result = await props.client.request('/inbox/list', 'GET', undefined, undefined, requestSignal);
      if (!current()) return;
      const state = decodeSummary(result);
      const list = result as { items?: CommentNotification[] };
      if (!Array.isArray(list.items)) throw new Error('消息列表格式无效。');
      summary.value = state;
      items.value = list.items;
      listRevision.value = state.revision;
    }
    if (props.directoryActive && loadedDirectoryKey !== props.directoryKey) {
      const directoryKey = props.directoryKey;
      const result = await props.client.request('/comment-directory', 'GET', undefined, undefined, requestSignal) as { users?: TaskAssignee[] };
      if (!current()) return;
      if (!Array.isArray(result.users)) throw new Error('评论成员目录格式无效。');
      loadedDirectoryKey = directoryKey;
      emit('directory', result.users);
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

watch([error, loading, () => props.scope], () => {
  emit('status', !props.scope ? '请先连接后端并登录。' : error.value
    || (loading.value ? '正在检测协作评论功能…' : '协作评论功能尚未确认，请重新检测。'));
}, { immediate: true });

async function read(id?: string) {
  const scope = props.scope;
  const next = decodeSummary(await props.client.request('/inbox/read', 'POST', id ? { id } : {}, undefined, new AbortController().signal));
  if (props.scope !== scope) return;
  summary.value = next;
  items.value = items.value.map(item => !id || item.id === id ? { ...item, read: true } : item);
  listRevision.value = undefined;
}

async function act(action: () => Promise<void>) {
  if (busy.value) return;
  controller?.abort();
  busy.value = true;
  error.value = '';
  try { await action(); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '消息操作失败。'; }
  finally { busy.value = false; }
  if (opened.value && !error.value) void check(undefined, true);
}

function visit(item: CommentNotification) {
  void act(async () => {
    const scope = props.scope;
    await props.openTarget(item);
    if (props.scope !== scope) return;
    if (!item.read) await read(item.id);
    dialog.value?.close();
  });
}

function closed() {
  opened.value = false;
  trigger.value?.focus();
}

function onVisibility() {
  if (document.visibilityState !== 'visible') controller?.abort();
}

watch(() => props.scope, () => {
  controller?.abort();
  dialog.value?.close();
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
  <dialog ref="dialog" class="inbox-panel" aria-labelledby="inbox-title" @close="closed">
    <header class="inbox-header">
      <h2 id="inbox-title">消息中心</h2>
      <button class="secondary" type="button" autofocus @click="dialog?.close()">关闭</button>
    </header>
    <div class="inbox-tabs" aria-label="消息筛选">
      <button class="secondary" type="button" :aria-pressed="filter === 'latest'" @click="filter = 'latest'">最新<span v-if="summary?.unreadCount"> {{ summary.unreadCount }}</span></button>
      <button class="secondary" type="button" :aria-pressed="filter === 'mentions'" @click="filter = 'mentions'">@我的</button>
      <button class="secondary inbox-all" type="button" :disabled="busy || !summary?.unreadCount" @click="act(() => read())">全部已读</button>
    </div>
    <p v-if="error" class="inbox-status" role="status">{{ error }} <button class="secondary" type="button" @click="check(undefined, true)">重试</button></p>
    <p v-if="loading && listRevision === undefined" class="inbox-status" role="status">正在读取消息…</p>
    <p v-else-if="!visibleItems.length && !error" class="inbox-status">暂无{{ unreadOnly ? '未读' : '' }}消息</p>
    <ul class="inbox-list">
      <li v-for="item in visibleItems" :key="item.id">
        <button class="secondary inbox-entry" type="button" :disabled="busy" @click="visit(item)">
          <span class="inbox-avatar" aria-hidden="true">{{ Array.from(item.actorName).slice(-2).join('') }}</span>
          <span><strong>{{ item.actorName }}</strong> {{ item.reply ? '回复了你的评论' : '在评论中提到了你' }}<br>
            <strong>{{ item.taskName }}</strong><br>
            <small>{{ item.projectName }} · {{ formatter.format(new Date(item.createdAt)) }}</small>
          </span>
          <small v-if="!item.read" class="inbox-unread">未读</small>
        </button>
        <button v-if="!item.read" class="secondary inbox-read" type="button" :disabled="busy" @click="act(() => read(item.id))">标为已读</button>
      </li>
    </ul>
    <footer><label><input v-model="unreadOnly" type="checkbox"> 仅看未读</label></footer>
  </dialog>
</template>

<style scoped>
.inbox-trigger { position: relative; display: inline-grid; place-items: center; width: 44px; min-height: 44px; padding: 0; }
.inbox-trigger svg { width: 19px; height: 19px; }
.inbox-badge, .inbox-unread { background: #792d49; color: #fff3f6; border-radius: 12px; padding: 2px 6px; font-size: 11px; }
.inbox-badge { position: absolute; top: 0; right: 0; }
.inbox-panel { position: fixed; inset: 12px 12px 12px auto; width: min(390px, calc(100vw - 24px)); max-width: none; max-height: none; height: auto; margin: 0; padding: 0; background: #121c2d; color: #eef4ff; border: 1px solid #35445c; border-radius: 10px; }
.inbox-panel[open] { display: flex; flex-direction: column; }
.inbox-panel::backdrop { background: #070d1866; }
.inbox-header, .inbox-tabs, footer { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid #35445c; }
.inbox-header { justify-content: space-between; }
.inbox-header h2 { margin: 0; font-size: 16px; }
.inbox-panel button { width: auto; min-height: 44px; }
.inbox-tabs button { border-color: transparent; background: transparent; }
.inbox-tabs button[aria-pressed='true'] { border-bottom-color: #60a5fa; color: #93c5fd; }
.inbox-all { margin-left: auto; }
.inbox-status { margin: 10px 12px; color: #afbdd2; }
.inbox-list { flex: 1; min-height: 0; overflow: auto; list-style: none; margin: 0; padding: 10px 12px; }
.inbox-list li { margin-bottom: 8px; border: 1px solid #35445c; border-radius: 6px; background: #18253a; }
.inbox-list .inbox-entry { display: grid; width: 100%; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 10px; text-align: left; background: transparent; border: 0; white-space: normal; overflow-wrap: anywhere; }
.inbox-avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 100%; background: #284570; color: #eef4ff; font-size: 11px; }
.inbox-entry small:not(.inbox-unread) { color: #afbdd2; }
.inbox-read { margin: 0 8px 4px; background: transparent; border: 0; }
footer { border-bottom: 0; border-top: 1px solid #35445c; }
footer label { min-height: 44px; display: flex; align-items: center; gap: 6px; }
</style>
