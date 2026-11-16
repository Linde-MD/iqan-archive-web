<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import type { CollaborationRepository, CollaborationUser } from '../storage/collaboration';
import type { ProjectGraph } from '../domain/model';
import AppIcon from './AppIcon.vue';
import ParentVersionPicker from './ParentVersionPicker.vue';
import TaskPicker from './TaskPicker.vue';
import { recommendedParentNodes } from '../domain/git-graph';

const props = defineProps<{ client: CollaborationRepository; projectId: string; disabled: boolean }>();
const state = props.client.state;
const dialog = ref<HTMLDialogElement>();
const trigger = ref<HTMLButtonElement>();
const heading = ref<HTMLElement>();
const usernameInput = ref<HTMLInputElement>();
const busy = ref(false);
const error = ref('');
const message = ref('');
const username = ref('');
const password = ref('');
const remember = ref(true);
const currentPassword = ref('');
const newPassword = ref('');
const displayName = ref('');
const email = ref('');
const avatar = ref<string | null>(null);
const members = ref<CollaborationUser[]>([]);
const memberName = ref('');
const memberUsername = ref('');
const memberEmail = ref('');
const memberPassword = ref('');
const resetUsername = ref('');
const resetPassword = ref('');
const preview = shallowRef<{ graph: ProjectGraph; nodes: ProjectGraph['nodes'] } | null>(null);
const drafts = shallowRef<Awaited<ReturnType<CollaborationRepository['draftDetails']>>>();
const editingDraftId = ref('');
const draftVersion = ref('');
const draftDescription = ref('');
const draftTaskId = ref('');
const draftParents = ref<string[]>([]);
const draftEditable = computed(() => drafts.value?.owner === state.user?.id && !state.pending && !!state.user && !state.user.mustChangePassword);
const draftParentOptions = computed(() => {
  const graph = drafts.value?.graph;
  if (!graph) return [];
  const ids = new Set(graph.nodes.map(node => node.id));
  const validEdges = graph.edges.filter(edge => ids.has(edge.parentId) && ids.has(edge.childId));
  return recommendedParentNodes({ ...graph, edges: validEdges }, draftVersion.value, editingDraftId.value)
    .filter(node => !draftParents.value.includes(node.id));
});
const isAdmin = computed(() => state.authenticated && state.user?.role === 'admin' && !state.user.mustChangePassword);
const label = computed(() => state.authenticated && state.connected ? state.user?.displayName || state.user?.username : state.user ? '离线账号 / 登录' : '登录协作');

watch(() => state.user, value => {
  displayName.value = value?.displayName ?? ''; email.value = value?.email ?? ''; avatar.value = value?.avatar ?? null;
}, { immediate: true });

async function run(action: () => Promise<unknown>) {
  busy.value = true; state.busy = true; error.value = ''; message.value = '';
  try { await action(); }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '协作操作失败，请重试。';
    await nextTick(); heading.value?.focus();
  } finally { busy.value = false; state.busy = false; }
}
async function open() {
  dialog.value?.showModal();
  await nextTick(); usernameInput.value?.focus();
}
async function login() {
  await run(async () => {
    await props.client.login(username.value, password.value, remember.value);
    password.value = '';
    message.value = state.user?.mustChangePassword ? '首次登录，请先修改初始密码。' : '已登录并更新共享副本。';
  });
}
async function changePassword() {
  await run(async () => {
    await props.client.changePassword(currentPassword.value, newPassword.value);
    currentPassword.value = ''; newPassword.value = ''; message.value = state.message;
  });
}
async function selectAvatar(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  await run(async () => {
    if (file.type !== 'image/png' || file.size > 65536) throw new Error('请选择不超过 64 KiB 的 PNG 图片。');
    const image = await createImageBitmap(file);
    try { if (image.width > 512 || image.height > 512) throw new Error('头像不得超过 512×512。'); }
    finally { image.close(); }
    avatar.value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('头像读取失败，请重试。'));
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('头像内容无效。'));
      reader.readAsDataURL(file);
    });
    message.value = '头像已选取，请保存资料。';
  });
}
async function createMember() {
  await run(async () => {
    await props.client.createUser({ username: memberUsername.value, password: memberPassword.value, displayName: memberName.value, email: memberEmail.value });
    memberPassword.value = ''; members.value = await props.client.listUsers();
    message.value = '成员已创建，首次登录需修改初始密码。';
  });
}
async function previewSync() {
  await run(async () => { preview.value = await props.client.previewDrafts(props.projectId); });
}
async function confirmSync() {
  const value = preview.value;
  if (!value) return;
  await run(async () => {
    await props.client.syncDrafts(value.graph.project.id, value.graph.project.revision);
    preview.value = null; message.value = '待同步版本已发布，共享库及本机副本已更新。';
  });
}
async function loadDrafts() {
  await run(async () => { drafts.value = await props.client.draftDetails(props.projectId); editingDraftId.value = ''; });
}
function editDraft(id: string) {
  const node = drafts.value?.nodes.find(item => item.id === id);
  if (!node || !drafts.value) return;
  editingDraftId.value = id; draftVersion.value = node.version; draftDescription.value = node.description;
  draftTaskId.value = node.taskId ?? '';
  draftParents.value = drafts.value.graph.edges.filter(edge => edge.childId === id).map(edge => edge.parentId);
}
async function saveDraft() {
  const detail = drafts.value;
  if (!detail) return;
  await run(async () => {
    await props.client.editDraft(detail.graph.project.id, detail.graph.project.revision, editingDraftId.value,
      { version: draftVersion.value, description: draftDescription.value, taskId: draftTaskId.value || null }, draftParents.value);
    drafts.value = await props.client.draftDetails(detail.graph.project.id);
    editingDraftId.value = ''; preview.value = null; message.value = '草稿修正已保存到本机，尚未同步；请重新预览同步。';
  });
}
</script>

<template>
  <button ref="trigger" class="secondary" type="button" :disabled="disabled || state.busy" @click="open"><AppIcon name="user" />{{ label }}</button>
  <dialog ref="dialog" class="branch-move-dialog collaboration-dialog" aria-labelledby="collaboration-title"
    @cancel="busy && $event.preventDefault()" @close="password = ''; currentPassword = ''; newPassword = ''; memberPassword = ''; resetPassword = ''; preview = null; drafts = undefined; trigger?.focus()">
    <h2 id="collaboration-title">团队协作与账号</h2>
    <p class="form-help">Access 是共享权威数据；本机 IndexedDB 保留副本和离线草稿。仅可信小团队使用，不是公司级权限隔离。</p>
    <div v-if="error" role="alert" class="collaboration-error"><h3 ref="heading" tabindex="-1">操作未完成</h3><p>{{ error }}</p></div>
    <p v-if="message" role="status">{{ message }}</p>
    <form v-if="!state.authenticated" @submit.prevent="login">
      <label for="collab-username">账号</label>
      <input id="collab-username" ref="usernameInput" v-model="username" autocomplete="username" required :disabled="busy">
      <label for="collab-password">密码</label>
      <input id="collab-password" v-model="password" type="password" autocomplete="current-password" required :disabled="busy">
      <label class="remember-login"><input v-model="remember" type="checkbox" :disabled="busy">记住登录（此设备，最多 30 天）</label>
      <p class="form-help">只保存会话，不保存密码。可读取此浏览器数据的人可能使用会话，请仅在自己的电脑勾选。</p>
      <button type="submit" :disabled="busy">{{ busy ? '请稍候…' : '登录' }}</button>
    </form>
    <template v-if="state.user">
      <p>账号：{{ state.user.username }} · {{ state.user.role === 'admin' ? '管理员' : '成员' }} · {{ state.authenticated ? '已认证' : '缓存身份，未验证' }}</p>
      <p class="form-help">邮箱：{{ state.user.email }}。退出保留只读副本与草稿；草稿只能由原账号同步。</p>
      <form v-if="state.authenticated" @submit.prevent="changePassword">
        <h3>{{ state.user.mustChangePassword ? '必须修改初始密码' : '修改密码' }}</h3>
        <label for="collab-current-password">当前密码</label>
        <input id="collab-current-password" v-model="currentPassword" type="password" autocomplete="current-password" required :disabled="busy">
        <label for="collab-new-password">新密码（12–128 个字符）</label>
        <input id="collab-new-password" v-model="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required :disabled="busy">
        <button type="submit" :disabled="busy">修改密码并退出</button>
      </form>
      <form v-if="state.authenticated && !state.user.mustChangePassword" @submit.prevent="run(async () => { await client.saveProfile({ displayName, email, avatar }); message = '资料已保存。'; })">
        <h3>个人资料</h3>
        <label for="collab-display-name">显示名称</label><input id="collab-display-name" v-model="displayName" required maxlength="80" :disabled="busy">
        <label for="collab-email">邮箱</label><input id="collab-email" v-model="email" type="email" required maxlength="254" :disabled="busy">
        <img v-if="avatar" :src="avatar" alt="已选择的头像" width="64" height="64">
        <label for="collab-avatar">头像（PNG，64 KiB 内，最大 512×512）</label><input id="collab-avatar" type="file" accept="image/png" :disabled="busy" @change="selectAvatar">
        <div class="actions"><button type="submit" :disabled="busy">保存资料</button><button type="button" class="secondary" :disabled="busy" @click="avatar = null">移除头像</button></div>
      </form>
      <div class="actions">
        <button type="button" class="secondary" :disabled="busy" @click="run(() => client.reconnect())">重新连接 / 刷新共享数据</button>
        <button type="button" class="secondary" :disabled="busy" @click="run(async () => { await client.logout(); message = '已退出，本机只读副本与草稿保留。'; })">退出登录</button>
      </div>
    </template>
    <section v-if="isAdmin" aria-labelledby="member-management-title">
      <h3 id="member-management-title">成员管理</h3>
      <form @submit.prevent="createMember">
        <label for="member-username">成员账号（3–32 位小写字母、数字、点、横线或下划线，以字母开头）</label><input id="member-username" v-model="memberUsername" autocomplete="off" pattern="[a-z][a-z0-9._\-]{2,31}" required :disabled="busy">
        <label for="member-name">显示名称</label><input id="member-name" v-model="memberName" required maxlength="80" :disabled="busy">
        <label for="member-email">邮箱</label><input id="member-email" v-model="memberEmail" type="email" required :disabled="busy">
        <label for="member-password">初始密码（12–128 个字符）</label><input id="member-password" v-model="memberPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128" :disabled="busy">
        <div class="actions"><button type="submit" :disabled="busy">创建成员</button><button type="button" class="secondary" :disabled="busy" @click="run(async () => { members = await client.listUsers(); })">刷新成员</button></div>
      </form>
      <ul class="collaboration-members"><li v-for="member in members" :key="member.id">
        <span>{{ member.username }} · {{ member.displayName }} · {{ member.disabled ? '已停用' : '启用' }}</span>
        <button type="button" class="secondary" :disabled="busy || member.username === 'admin'" @click="run(async () => { await client.manageUser(member.username, !member.disabled); members = await client.listUsers(); })">{{ member.disabled ? '启用' : '停用' }}</button>
      </li></ul>
      <form @submit.prevent="run(async () => { await client.manageUser(resetUsername, false, resetPassword); resetPassword = ''; message = '已重置并启用此成员，旧会话失效，首次登录须改密。'; })">
        <label for="reset-username">重置成员账号</label><input id="reset-username" v-model="resetUsername" autocomplete="off" required :disabled="busy">
        <label for="reset-password">新的初始密码（12–128 个字符）</label><input id="reset-password" v-model="resetPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="128" :disabled="busy">
        <button type="submit" class="secondary" :disabled="busy || resetUsername === 'admin'">重置并启用成员</button>
      </form>
    </section>
    <section aria-labelledby="collab-sync-title">
      <h3 id="collab-sync-title">待同步版本：{{ state.draftCount }}</h3>
      <p class="form-help">仅当前选择项目的草稿作为一次原子提交。先刷新和预览，不自动上传；父版本或任务失效时保留草稿，请先修正。</p>
      <button type="button" class="secondary" :disabled="busy || !projectId || !state.draftCount" @click="loadDrafts">检查 / 修复当前项目草稿</button>
      <template v-if="drafts">
        <p v-if="drafts.deleted" role="alert">共享项目已删除，不能自动重建或同步；草稿仍保留。</p>
        <p v-if="drafts.owner !== state.user?.id" class="form-help">此草稿属于其他账号，仅原账号可以修改或同步。</p>
        <ul><li v-for="node in drafts.nodes" :key="node.id"><code>{{ node.version }}</code> · 待同步 <button type="button" class="secondary" :disabled="busy || !draftEditable || drafts.deleted" @click="editDraft(node.id)">修正此版本</button></li></ul>
        <form v-if="editingDraftId" @submit.prevent="saveDraft">
          <label for="draft-version">草稿版本号</label><input id="draft-version" v-model="draftVersion" required :disabled="busy || !draftEditable">
          <label for="draft-description">改动说明</label><textarea id="draft-description" v-model="draftDescription" rows="4" :disabled="busy || !draftEditable"></textarea>
          <TaskPicker v-model="draftTaskId" :tasks="drafts.graph.tasks" :disabled="busy || !draftEditable" />
          <ParentVersionPicker :options="draftParentOptions" :disabled="busy || !draftEditable" @add="draftParents.push($event)" />
          <ul><li v-for="id in draftParents" :key="id">{{ drafts.graph.nodes.find(node => node.id === id)?.version ?? `失效父版本 ${id}` }} <button type="button" class="secondary" :disabled="busy || !draftEditable" @click="draftParents = draftParents.filter(parent => parent !== id)">移除父引用</button></li></ul>
          <div class="actions"><button type="submit" :disabled="busy || !draftEditable">保存本机草稿修正</button><button type="button" class="secondary" :disabled="busy" @click="editingDraftId = ''">取消修正</button></div>
        </form>
      </template>
      <button type="button" class="secondary" :disabled="busy || !state.authenticated || !state.connected || !projectId || !state.draftCount || state.pending" @click="previewSync">预览当前项目同步</button>
      <div v-if="preview">
        <p>将向共享项目“{{ preview.graph.project.name }}”发布 {{ preview.nodes.length }} 个未放行版本，不操作工程文件：</p>
        <ul><li v-for="node in preview.nodes" :key="node.id"><code>{{ node.version }}</code> · 父版本：{{ preview.graph.edges.filter(edge => edge.childId === node.id).map(edge => preview?.graph.nodes.find(item => item.id === edge.parentId)?.version ?? edge.parentId).join('、') || '无' }}</li></ul>
        <div class="actions"><button type="button" :disabled="busy" @click="confirmSync">确认发布这些版本</button><button type="button" class="secondary" :disabled="busy" @click="preview = null">取消</button></div>
      </div>
      <p v-if="state.pending" role="status">存在结果未确认的提交。内容已锁定，请用原请求重试，勿重复创建或恢复。</p>
      <button v-if="state.pending" type="button" :disabled="busy || !state.connected || !state.authenticated" @click="run(() => client.retryPending())">重试未确认提交</button>
    </section>
    <button type="button" class="secondary" :disabled="busy" @click="dialog?.close()">关闭</button>
  </dialog>
</template>

<style scoped>
.collaboration-dialog { width: min(620px, calc(100vw - 32px)); }
.collaboration-dialog h2 { font-size: 18px; }
.collaboration-dialog h3 { margin-top: 20px; }
.collaboration-dialog form, .collaboration-dialog section { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
.collaboration-dialog .actions { display: flex; flex-wrap: wrap; gap: 8px; }
.collaboration-dialog .actions button { width: auto; flex: 1 1 140px; }
.collaboration-dialog p, .collaboration-dialog li { overflow-wrap: anywhere; }
.remember-login { display: flex; align-items: center; min-height: 44px; gap: 8px; }
.remember-login input { width: 20px; margin: 0; }
.collaboration-error { color: var(--danger); }
.collaboration-members { padding: 0; list-style: none; }
.collaboration-members li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.collaboration-members button { width: auto; }
</style>
