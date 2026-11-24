<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { CollaborationRepository, CollaborationUser } from '../storage/collaboration';
import type { ProjectGraph } from '../domain/model';
import { accountAvatarTheme, accountInitials } from '../domain/account';
import AppIcon from './AppIcon.vue';
import AppBrandMark from './AppBrandMark.vue';
import ParentVersionPicker from './ParentVersionPicker.vue';
import TaskPicker from './TaskPicker.vue';
import { recommendedParentNodes } from '../domain/git-graph';

const MarkdownEditor = defineAsyncComponent(() => import('./MarkdownEditor.vue'));
const props = defineProps<{ client: CollaborationRepository; projectId: string; disabled: boolean }>();
const state = props.client.state;
const dialog = ref<HTMLDialogElement>();
const route = useRoute();
const router = useRouter();
const menuRoot = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const heading = ref<HTMLElement>();
const errorHeading = ref<HTMLElement>();
const menuOpen = ref(false);
const busy = ref(false);
const error = ref('');
const message = ref('');
const recoveryRequestId = ref('');
const recoveryChecked = ref(false);
const username = ref('');
const password = ref('');
const remember = ref(true);
const currentPassword = ref('');
const newPassword = ref('');
const displayName = ref('');
const email = ref('');
const avatar = ref<string | null>(null);
const members = ref<CollaborationUser[]>([]);
const membersLoaded = ref(false);
const memberSearch = ref('');
const memberForm = ref<'create' | 'reset' | null>(null);
const memberFormHeading = ref<HTMLElement>();
let memberFormTrigger: HTMLElement | null = null;
const memberName = ref('');
const memberUsername = ref('');
const memberEmail = ref('');
const memberPassword = ref('');
const resetUsername = ref('');
const resetPassword = ref('');
const deletingMember = ref<CollaborationUser | null>(null);
const deleteHeading = ref<HTMLElement>();
const filteredMembers = computed(() => {
  const query = memberSearch.value.trim().toLocaleLowerCase();
  return query ? members.value.filter(member =>
    [member.displayName, member.username, member.email].some(value => value.toLocaleLowerCase().includes(query))) : members.value;
});
const passwordReuse = computed(() => currentPassword.value.length > 0 && currentPassword.value === newPassword.value);
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
const isAdmin = computed(() => !state.restoring && state.authenticated && state.user?.role === 'admin' && !state.user.mustChangePassword);
const accountSection = computed(() => route.path.match(/^\/account\/(login|profile|security|members|sync)$/)?.[1] ?? '');
const accountPage = computed(() => accountSection.value !== '');
const avatarInitials = computed(() => accountInitials(state.user?.displayName, state.user?.username));
const avatarThemeStyle = computed(() => {
  return memberAvatarStyle(state.user?.id ?? state.user?.username);
});
function memberAvatarStyle(id: string | undefined) {
  const theme = accountAvatarTheme(id);
  return {
    '--avatar-background': theme.background,
    '--avatar-foreground': theme.foreground,
    '--avatar-border': theme.border,
  };
}
const pageTitle = computed(() => ({
  login: '登录协作',
  profile: '个人资料',
  security: '密码与安全',
  members: '团队成员',
  sync: '协作与同步',
}[accountSection.value] ?? '账户'));

function returnToPath() {
  const from = route.query.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/account/')
    ? from
    : '/';
}

function accountLocation(section: 'login' | 'profile' | 'security' | 'members' | 'sync') {
  const from = accountPage.value
    ? returnToPath()
    : route.fullPath.startsWith('/') && !route.fullPath.startsWith('//') ? route.fullPath : '/';
  return { path: `/account/${section}`, query: { from } };
}

function closeMenu() {
  menuOpen.value = false;
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function onMenuOutsidePointerDown(event: PointerEvent) {
  if (menuOpen.value && menuRoot.value && !event.composedPath().includes(menuRoot.value)) closeMenu();
}

function onMenuKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (menuOpen.value) {
    event.preventDefault();
    closeMenu();
    trigger.value?.focus();
  }
}

async function closeAccountPage() {
  closeMenu();
  await router.push(returnToPath());
}

watch(accountSection, async section => {
  closeMenu();
  if (!section) return;
  await nextTick();
  if (dialog.value && !dialog.value.open) dialog.value.showModal();
  heading.value?.focus({ preventScroll: true });
}, { immediate: true });

watch(accountPage, async open => {
  await nextTick();
  if (!dialog.value) return;
  if (open && !dialog.value.open) dialog.value.showModal();
  if (!open && dialog.value.open) dialog.value.close();
}, { immediate: true });

onMounted(() => {
  window.addEventListener('pointerdown', onMenuOutsidePointerDown, true);
  window.addEventListener('keydown', onMenuKeyDown);
  if (accountPage.value && dialog.value && !dialog.value.open) dialog.value.showModal();
});
onUnmounted(() => {
  window.removeEventListener('pointerdown', onMenuOutsidePointerDown, true);
  window.removeEventListener('keydown', onMenuKeyDown);
});

watch(() => state.user, value => {
  displayName.value = value?.displayName ?? ''; email.value = value?.email ?? ''; avatar.value = value?.avatar ?? null;
}, { immediate: true });

async function run(action: () => Promise<unknown>) {
  busy.value = true; state.busy = true; error.value = ''; message.value = '';
  try { await action(); }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '协作操作失败，请重试。';
    await nextTick(); errorHeading.value?.focus();
  } finally { busy.value = false; state.busy = false; }
}
async function exportPending() {
  await run(async () => {
    const text = await props.client.exportPending();
    const request = JSON.parse(text) as { requestId: string };
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    try {
      const link = document.createElement('a');
      link.href = url; link.download = 'iqan-pending-recovery.json'; link.click();
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    recoveryRequestId.value = request.requestId;
    recoveryChecked.value = false;
    message.value = '已请求导出原始提交。请确认文件已保存，并核对共享项目的实际结果。';
  });
}
watch(() => [state.source, state.user?.id, state.pending], () => {
  recoveryRequestId.value = ''; recoveryChecked.value = false;
});
async function login() {
  await run(async () => {
    await props.client.login(username.value, password.value, remember.value);
    password.value = '';
    message.value = state.user?.mustChangePassword ? '首次登录，请先修改初始密码。' : '已登录并更新共享副本。';
  });
  if (state.authenticated) {
    await router.replace(accountLocation(state.user?.mustChangePassword ? 'security' : 'profile'));
  }
}
async function logout() {
  const target = accountLocation('login');
  await run(async () => {
    await props.client.logout();
    message.value = '已退出登录，本机只读副本与草稿保留。';
    closeMenu();
    await router.push(target);
  });
}
async function changePassword() {
  await run(async () => {
    const name = state.user?.username ?? '';
    await props.client.changePassword(currentPassword.value, newPassword.value);
    username.value = name;
    currentPassword.value = ''; newPassword.value = ''; message.value = state.message;
  });
}
async function loadMembers() {
  await run(async () => { members.value = await props.client.listUsers(); membersLoaded.value = true; });
}
watch([accountSection, isAdmin], async ([section, admin]) => {
  deletingMember.value = null;
  memberForm.value = null;
  membersLoaded.value = false;
  if (section === 'members' && admin) await loadMembers();
}, { immediate: true });

async function openMemberForm(form: 'create' | 'reset', event: MouseEvent, member?: CollaborationUser) {
  memberFormTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (member && resetUsername.value !== member.username) {
    if (resetPassword.value) {
      message.value = '保留了尚未提交的重置密码和账号，请先处理该草稿。';
    } else {
      resetUsername.value = member.username;
    }
  }
  memberForm.value = form;
  await nextTick();
  memberFormHeading.value?.focus();
}
async function closeMemberForm() {
  memberForm.value = null;
  await nextTick();
  memberFormTrigger?.focus();
}
async function resetMember() {
  await run(async () => {
    const updated = await props.client.manageUser(resetUsername.value, false, resetPassword.value);
    resetUsername.value = updated.username;
    resetPassword.value = '';
    members.value = members.value.map(member => member.id === updated.id ? updated : member);
    message.value = '已重置并启用此成员，旧会话失效，首次登录须改密。';
    await closeMemberForm();
  });
  if (!memberForm.value) { await nextTick(); memberFormTrigger?.focus(); }
}
async function confirmMemberDeletion(member: CollaborationUser) {
  deletingMember.value = member;
  await nextTick();
  deleteHeading.value?.focus();
}
async function deleteMember() {
  const member = deletingMember.value;
  if (!member) return;
  await run(async () => {
    await props.client.deleteUser(member.username);
    members.value = members.value.filter(item => item.id !== member.id);
    deletingMember.value = null;
    if (resetUsername.value.trim().toLowerCase() === member.username) {
      resetUsername.value = ''; resetPassword.value = '';
    }
    message.value = `成员 ${member.username} 已删除，旧会话已撤销；项目、任务和本机草稿未删除。`;
    await nextTick(); heading.value?.focus();
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
    const created = await props.client.createUser({ username: memberUsername.value, password: memberPassword.value, displayName: memberName.value, email: memberEmail.value });
    members.value = [...members.value.filter(member => member.id !== created.id), created];
    memberUsername.value = ''; memberName.value = ''; memberEmail.value = ''; memberPassword.value = '';
    message.value = '成员已创建，首次登录需修改初始密码。';
    await closeMemberForm();
  });
  if (!memberForm.value) { await nextTick(); memberFormTrigger?.focus(); }
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
  <div ref="menuRoot" class="account-menu-root">
    <button ref="trigger" class="account-avatar-trigger" type="button" :disabled="disabled || state.busy"
      :aria-expanded="menuOpen" :aria-controls="menuOpen ? 'account-menu' : undefined"
      :aria-label="`打开账户菜单，${state.restoring ? '正在恢复连接' : state.authenticated ? (state.connected ? (state.pending ? '已连接，提交待确认' : '共享协作已连接') : '缓存账号，未连接') : '需要登录或重新验证'}`" @click="toggleMenu">
      <span class="account-avatar account-avatar-small" :style="avatarThemeStyle" aria-hidden="true">
        <img v-if="state.user?.avatar" :src="state.user.avatar" alt="">
        <span v-else>{{ avatarInitials }}</span>
      </span>
      <span class="account-trigger-label">
        <strong>{{ state.user?.displayName || state.user?.username || '登录协作' }}</strong>
        <small>{{ state.restoring ? '正在恢复连接…' : state.authenticated ? (state.connected ? (state.pending ? '已连接 · 提交待确认' : '共享协作已连接') : '缓存账号 · 未连接') : '需要登录或重新验证' }}</small>
      </span>
      <AppIcon name="chevron-right" />
    </button>
    <section v-if="menuOpen" id="account-menu" class="account-menu-popover" aria-label="账户管理菜单">
        <div class="account-menu-identity">
          <span class="account-avatar account-avatar-menu" :style="avatarThemeStyle" aria-hidden="true">
            <img v-if="state.user?.avatar" :src="state.user.avatar" alt="">
            <span v-else>{{ avatarInitials }}</span>
          </span>
          <div>
            <strong>{{ state.user?.displayName || '访客' }}</strong>
            <span>{{ state.user ? `@${state.user.username}` : '登录后管理个人资料与协作' }}</span>
          </div>
        </div>
        <nav v-if="state.user" class="account-menu-links" aria-label="账户页面">
          <RouterLink :to="accountLocation('profile')" @click="closeMenu"><AppIcon name="user" />个人资料</RouterLink>
          <RouterLink :to="accountLocation('security')" @click="closeMenu"><AppIcon name="shield" />密码与安全</RouterLink>
          <RouterLink v-if="isAdmin" :to="accountLocation('members')" @click="closeMenu"><AppIcon name="tasks" />团队成员</RouterLink>
          <RouterLink :to="accountLocation('sync')" @click="closeMenu"><AppIcon name="cloud" />协作与同步</RouterLink>
        </nav>
        <div class="account-menu-actions">
          <RouterLink v-if="!state.authenticated" class="account-login-link" :to="accountLocation('login')" @click="closeMenu">
            <AppIcon name="user" />{{ state.user ? '重新登录' : '登录协作' }}
          </RouterLink>
          <button v-if="state.user" type="button" class="account-logout" :disabled="busy" @click="logout">退出登录</button>
        </div>
    </section>
  </div>
  <dialog ref="dialog" class="account-page-dialog" aria-labelledby="collaboration-title"
    @cancel.prevent="closeAccountPage"
    @close="password = ''; currentPassword = ''; newPassword = ''; memberPassword = ''; resetPassword = ''; preview = null; drafts = undefined; trigger?.focus()">
    <header class="account-page-header">
      <a class="account-page-brand" href="#" @click.prevent="closeAccountPage">
        <AppBrandMark class="account-brand-mark" />
        <span class="account-brand-copy">
          <span class="account-brand-title">IQAN <strong>Archive</strong></span>
          <small>协作账户中心</small>
        </span>
      </a>
      <button type="button" class="secondary account-return" @click="closeAccountPage"><AppIcon name="arrow" />返回工作台</button>
    </header>
    <div class="account-page-content" :class="{ 'account-page-content-members': accountSection === 'members' && isAdmin }">
      <div class="account-page-heading">
        <div><p class="eyebrow">ACCOUNT CONTROL</p><h1 id="collaboration-title">个人账户</h1></div>
        <span class="account-session-chip" :class="{ 'is-connected': state.authenticated && state.connected }">
          <span class="account-session-dot" aria-hidden="true"></span>
          {{ state.restoring ? '正在恢复连接…' : state.authenticated ? (state.connected ? '共享服务在线' : '离线缓存模式') : state.connected ? '后端可达 · 需登录' : '未登录' }}
        </span>
      </div>
      <section v-if="accountSection !== 'members'" class="account-profile-banner" aria-label="账户摘要">
        <span class="account-avatar account-avatar-large" :style="avatarThemeStyle" aria-hidden="true">
          <img v-if="state.user?.avatar" :src="state.user.avatar" alt="">
          <span v-else>{{ avatarInitials }}</span>
        </span>
        <div class="account-profile-identity">
          <p class="eyebrow">SIGNED-IN IDENTITY</p>
          <h2>{{ state.user?.displayName || '访客' }}</h2>
          <p>{{ state.user ? `@${state.user.username} · ${state.user.email}` : '登录后访问团队账户与共享数据' }}</p>
        </div>
        <div class="account-profile-metrics">
          <span class="account-role-chip">{{ state.user?.role === 'admin' ? '管理员' : state.user ? '团队成员' : '访客' }}</span>
          <span class="account-pending-count"><strong>{{ state.draftCount }}</strong><small>待同步版本</small></span>
        </div>
      </section>
      <nav class="account-section-nav" aria-label="账户管理分区">
        <RouterLink v-if="!state.authenticated" :to="accountLocation('login')"><AppIcon name="user" />登录协作</RouterLink>
        <template v-else>
          <RouterLink :to="accountLocation('profile')"><AppIcon name="user" />个人资料</RouterLink>
          <RouterLink :to="accountLocation('security')"><AppIcon name="shield" />密码与安全</RouterLink>
          <RouterLink v-if="isAdmin" :to="accountLocation('members')"><AppIcon name="tasks" />团队成员</RouterLink>
          <RouterLink :to="accountLocation('sync')"><AppIcon name="cloud" />协作与同步<span v-if="state.draftCount" class="account-nav-count">{{ state.draftCount }}</span></RouterLink>
        </template>
      </nav>
      <section class="account-content" :aria-labelledby="`account-page-title-${accountSection}`">
        <header class="account-content-heading">
          <div><p class="eyebrow">ACCOUNT / {{ accountSection.toUpperCase() }}</p><h2 :id="`account-page-title-${accountSection}`" ref="heading" tabindex="-1">{{ pageTitle }}</h2></div>
          <span v-if="state.user" class="account-identity-compact"><AppIcon name="user" />{{ state.user.username }}</span>
        </header>
    <template v-if="accountSection !== 'members'">
      <p class="form-help">Access 是共享权威数据；本机 IndexedDB 保留副本和离线草稿。仅可信小团队使用，不是公司级权限隔离。</p>
      <p class="form-help">未同步版本仅保存在当前浏览器，清除浏览器数据可能丢失草稿和会话；迁移前请导出 JSON。后端断开不代表网页资源支持完全断网加载。</p>
    </template>
    <div v-if="error" role="alert" class="collaboration-error"><h3 ref="errorHeading" tabindex="-1">操作未完成</h3><p>{{ error }}</p></div>
    <p v-if="state.restoring" role="status">正在检测后端并恢复登录…</p>
    <template v-else>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-else-if="state.message && (accountSection === 'sync' || !state.authenticated)" role="status">{{ state.message }}</p>
    <form v-if="accountSection === 'login' && !state.authenticated" @submit.prevent="login">
      <label for="collab-username">账号</label>
      <input id="collab-username" v-model="username" autocomplete="username" required :disabled="busy">
      <label for="collab-password">密码</label>
      <input id="collab-password" v-model="password" type="password" autocomplete="current-password" required :disabled="busy">
      <label class="remember-login"><input v-model="remember" type="checkbox" :disabled="busy">记住登录（此设备，最多 30 天）</label>
      <p class="form-help">只保存会话，不保存密码。可读取此浏览器数据的人可能使用会话，请仅在自己的电脑勾选。</p>
      <button type="submit" :disabled="busy">{{ busy ? '请稍候…' : '登录' }}</button>
    </form>
    <div v-if="accountSection === 'login' && state.authenticated" class="account-callout">
      <h3>当前已登录</h3><p>账户 {{ state.user?.username }} 已{{ state.connected ? '连接共享服务' : '进入离线缓存模式' }}。</p>
      <RouterLink class="account-inline-link" :to="accountLocation('profile')">前往个人资料 <AppIcon name="arrow" /></RouterLink>
    </div>
    <div v-if="accountSection === 'profile' && (!state.authenticated || state.user?.mustChangePassword)" class="account-callout">
      <h3>{{ state.user?.mustChangePassword ? '请先修改初始密码' : '需要登录后管理资料' }}</h3>
      <p>{{ state.user?.mustChangePassword ? '完成密码修改后即可更新个人资料。' : '登录协作账户后可以编辑显示名称、邮箱和头像。' }}</p>
      <RouterLink class="account-inline-link" :to="accountLocation(state.user?.mustChangePassword ? 'security' : 'login')">
        {{ state.user?.mustChangePassword ? '前往密码与安全' : '前往登录' }} <AppIcon name="arrow" />
      </RouterLink>
    </div>
    <div v-if="accountSection === 'security' && !state.authenticated" class="account-callout">
      <h3>需要登录后管理密码</h3><p>登录后可修改密码；密码修改成功会使当前会话退出。</p>
      <RouterLink class="account-inline-link" :to="accountLocation('login')">前往登录 <AppIcon name="arrow" /></RouterLink>
    </div>
    <div v-if="accountSection === 'members' && !isAdmin" class="account-callout" role="alert">
      <h3>无成员管理权限</h3><p>此页面仅向已完成初始密码修改的管理员开放。</p>
    </div>
    <template v-if="state.user">
      <p v-if="accountSection === 'sync'">账号：{{ state.user.username }} · {{ state.user.role === 'admin' ? '管理员' : '成员' }} · {{ state.authenticated ? '已认证' : '缓存身份，未验证' }}</p>
      <p v-if="accountSection === 'sync'" class="form-help">邮箱：{{ state.user.email }}。退出保留只读副本与草稿；草稿只能由原账号同步。</p>
      <form v-if="state.authenticated && accountSection === 'security'" @submit.prevent="changePassword">
        <h3>{{ state.user.mustChangePassword ? '必须修改初始密码' : '修改密码' }}</h3>
        <label for="collab-current-password">当前密码</label>
        <input id="collab-current-password" v-model="currentPassword" type="password" autocomplete="current-password" required :disabled="busy">
        <label for="collab-new-password">新密码（6–128 个字符，无需复杂组合）</label>
        <input id="collab-new-password" v-model="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required :disabled="busy"
          :aria-invalid="passwordReuse || undefined" aria-describedby="collab-password-help">
        <p id="collab-password-help" :class="passwordReuse ? 'account-field-error' : 'form-help'" :role="passwordReuse ? 'alert' : undefined">{{ passwordReuse ? '新密码必须与当前密码不同；尚未修改密码。' : '新密码不得与当前密码相同；修改成功后须重新登录。' }}</p>
        <button type="submit" :disabled="busy">修改密码并退出</button>
      </form>
      <form v-if="state.authenticated && !state.user.mustChangePassword && accountSection === 'profile'" @submit.prevent="run(async () => { await client.saveProfile({ displayName, email, avatar }); message = '资料已保存。'; })">
        <h3>个人资料</h3>
        <label for="collab-display-name">显示名称</label><input id="collab-display-name" v-model="displayName" required maxlength="80" :disabled="busy">
        <label for="collab-email">邮箱</label><input id="collab-email" v-model="email" type="email" required maxlength="254" :disabled="busy">
        <img v-if="avatar" :src="avatar" alt="已选择的头像" width="64" height="64">
        <label for="collab-avatar">头像（PNG，64 KiB 内，最大 512×512）</label><input id="collab-avatar" type="file" accept="image/png" :disabled="busy" @change="selectAvatar">
        <div class="actions"><button type="submit" :disabled="busy">保存资料</button><button type="button" class="secondary" :disabled="busy" @click="avatar = null">移除头像</button></div>
      </form>
      <div v-if="accountSection === 'sync'" class="actions">
        <button type="button" class="secondary" :disabled="busy" @click="run(() => client.reconnect())">重新连接 / 刷新共享数据</button>
      </div>
    </template>
    <section v-if="accountSection === 'members' && isAdmin" class="member-management" aria-labelledby="member-management-title">
      <div class="member-toolbar">
        <div class="member-toolbar-title">
          <h3 id="member-management-title">全部成员 <span v-if="membersLoaded">{{ members.length }}</span></h3>
          <p>管理团队账号与访问状态</p>
        </div>
        <div class="member-toolbar-actions">
          <label class="member-search"><span>搜索</span><input v-model="memberSearch" type="search" placeholder="名称、账号或邮箱"></label>
          <button type="button" class="secondary member-refresh" :disabled="busy" @click="loadMembers"><AppIcon name="refresh" />刷新</button>
          <button type="button" :disabled="busy" :aria-expanded="memberForm === 'create'" @click="openMemberForm('create', $event)"><AppIcon name="plus" />添加成员</button>
        </div>
      </div>
      <div v-if="memberForm" class="member-form-panel">
        <div class="member-form-heading">
          <div><h3 ref="memberFormHeading" tabindex="-1">{{ memberForm === 'create' ? '添加成员' : '重置成员密码' }}</h3>
            <p>{{ memberForm === 'create' ? '创建后成员首次登录须修改初始密码。' : '重置后账号将启用，旧会话失效，首次登录须改密。' }}</p></div>
          <button type="button" class="secondary member-form-close" :disabled="busy" aria-label="收起表单，保留草稿" @click="closeMemberForm"><AppIcon name="clear" /></button>
        </div>
        <form v-if="memberForm === 'create'" class="member-form" @submit.prevent="createMember">
          <div><label for="member-username">成员账号（3–32 位，以字母开头）</label><input id="member-username" v-model="memberUsername" autocomplete="off" pattern="[a-z][a-z0-9._\-]{2,31}" required :disabled="busy"><p class="form-help">小写字母、数字、点、横线或下划线</p></div>
          <div><label for="member-name">显示名称</label><input id="member-name" v-model="memberName" required maxlength="80" :disabled="busy"></div>
          <div><label for="member-email">邮箱</label><input id="member-email" v-model="memberEmail" type="email" required :disabled="busy"></div>
          <div><label for="member-password">初始密码（6–128 个字符）</label><input id="member-password" v-model="memberPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="128" :disabled="busy"></div>
          <div class="member-form-actions"><button type="button" class="secondary" :disabled="busy" @click="closeMemberForm">收起</button><button type="submit" :disabled="busy">创建成员</button></div>
        </form>
        <form v-else class="member-form" @submit.prevent="resetMember">
          <div><label for="reset-username">重置成员账号</label><input id="reset-username" v-model="resetUsername" list="reset-member-options" autocomplete="off" required :disabled="busy">
            <datalist id="reset-member-options"><option v-for="member in members.filter(item => item.role === 'member')" :key="member.id" :value="member.username">{{ member.displayName }}</option></datalist></div>
          <div><label for="reset-password">新的初始密码（6–128 个字符）</label><input id="reset-password" v-model="resetPassword" type="password" autocomplete="new-password" required minlength="6" maxlength="128" :disabled="busy"></div>
          <div class="member-form-actions"><button type="button" class="secondary" :disabled="busy" @click="closeMemberForm">收起</button><button type="submit" :disabled="busy || resetUsername.trim().toLowerCase() === 'admin'">重置并启用成员</button></div>
        </form>
      </div>
      <section v-if="deletingMember" class="account-delete-confirmation" aria-labelledby="delete-member-title">
        <h3 id="delete-member-title" ref="deleteHeading" tabindex="-1">确认删除成员 {{ deletingMember.username }}？</h3>
        <p>该账号将无法登录，所有旧会话会撤销。项目、任务和评论不会删除，既有负责人引用保留为账号信息不可用。</p>
        <p>该账号的本机未同步草稿将无法再由它同步；重建同名账号也不会继承旧账号身份。此操作不可撤销。</p>
        <div class="actions"><button type="button" class="secondary" :disabled="busy" @click="deletingMember = null; heading?.focus()">取消删除</button><button type="button" class="danger" :disabled="busy" @click="deleteMember">确认删除此成员</button></div>
      </section>
      <p v-if="!membersLoaded" class="member-empty" role="status">{{ busy ? '正在加载成员…' : '成员列表尚未加载，请刷新重试。' }}</p>
      <div v-else class="member-table-scroll" tabindex="0" role="region" aria-label="成员列表，可横向滚动">
        <table class="member-table">
          <thead><tr><th scope="col">成员</th><th scope="col">账号</th><th scope="col">邮箱</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
          <tbody><tr v-for="member in filteredMembers" :key="member.id">
            <td><div class="member-name-cell"><span class="account-avatar account-avatar-small" :style="memberAvatarStyle(member.id)" aria-hidden="true"><img v-if="member.avatar" :src="member.avatar" alt=""><span v-else>{{ accountInitials(member.displayName, member.username) }}</span></span><span><strong>{{ member.displayName }}</strong><small v-if="member.role === 'admin'">管理员</small></span></div></td>
            <td><code>{{ member.username }}</code></td><td>{{ member.email }}</td>
            <td><span class="account-member-status" :class="{ 'is-disabled': member.disabled }">{{ member.disabled ? '已停用' : '已启用' }}</span></td>
            <td><div v-if="member.role === 'member'" class="account-member-actions">
              <button type="button" class="secondary" :disabled="busy" :aria-label="`重置成员 ${member.username} 的密码`" @click="openMemberForm('reset', $event, member)">重置密码</button>
              <button type="button" class="secondary" :disabled="busy" @click="run(async () => { const updated = await client.manageUser(member.username, !member.disabled); members = members.map(item => item.id === updated.id ? updated : item); message = `成员 ${updated.username} 已${updated.disabled ? '停用' : '启用'}。`; })">{{ member.disabled ? '启用' : '停用' }}</button>
              <button type="button" class="secondary account-member-delete" :disabled="busy" :aria-label="`删除成员 ${member.username}`" @click="confirmMemberDeletion(member)">删除</button>
            </div><span v-else class="member-admin-note">管理员账号</span></td>
          </tr></tbody>
        </table>
        <p v-if="!filteredMembers.length" class="member-empty" role="status">{{ memberSearch.trim() ? '没有匹配的成员，请尝试其他关键词。' : '暂无成员。' }}</p>
      </div>
      <button type="button" class="secondary member-reset-link" :disabled="busy" :aria-expanded="memberForm === 'reset'" @click="openMemberForm('reset', $event)">重置成员密码</button>
    </section>
    </template>
    <section v-if="accountSection === 'sync' && !state.restoring" aria-labelledby="collab-sync-title">
      <h3 id="collab-sync-title">待同步版本：{{ state.draftCount }}</h3>
      <p class="form-help">{{ projectId && state.authenticated && state.connected ? '前台每 2 分钟检查更新；编辑时距上次检查满 20 秒即检查，草稿不会被覆盖。' : '连接并登录后可手动刷新共享数据。' }}{{ state.updatedAt ? `副本读取时间：${new Date(state.updatedAt).toLocaleString()}` : '显示上次持久副本。' }}</p>
      <p v-if="state.conflictMessage" role="alert">草稿冲突已保留：{{ state.conflictMessage }}</p>
      <p class="form-help">仅当前选择项目的草稿作为一次原子提交。先刷新和预览，不自动上传；父版本或任务失效时保留草稿，请先修正。</p>
      <button type="button" class="secondary" :disabled="busy || !projectId || !state.draftCount" @click="loadDrafts">检查 / 修复当前项目草稿</button>
      <template v-if="drafts">
        <p v-if="drafts.deleted" role="alert">共享项目已删除，不能自动重建或同步；草稿仍保留。</p>
        <p v-if="drafts.owner !== state.user?.id" class="form-help">此草稿属于其他账号，仅原账号可以修改或同步。</p>
        <ul><li v-for="node in drafts.nodes" :key="node.id"><code>{{ node.version }}</code> · 待同步 <button type="button" class="secondary" :disabled="busy || !draftEditable || drafts.deleted" @click="editDraft(node.id)">修正此版本</button></li></ul>
        <form v-if="editingDraftId" @submit.prevent="saveDraft">
          <label for="draft-version">草稿版本号</label><input id="draft-version" v-model="draftVersion" required :disabled="busy || !draftEditable">
          <MarkdownEditor v-model="draftDescription" textarea-id="draft-description" label="改动说明" :rows="4" :disabled="busy || !draftEditable" />
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
      <section v-if="state.pending && state.pendingRecovery" aria-label="过期提交恢复">
        <h3>原请求需要人工核对</h3>
        <p role="alert">旧版或已过期的请求不会重新执行，原账号、数据库和内容均保留。请先导出备份，再刷新并核对共享项目；放弃只解除本机锁定，不撤销已提交的共享修改。</p>
        <button type="button" class="secondary" :disabled="busy" @click="exportPending">导出原始提交</button>
        <template v-if="recoveryRequestId">
          <label><input v-model="recoveryChecked" type="checkbox" :disabled="busy">我已保存导出文件、核对共享结果，并确认放弃此原请求（不自动重做）</label>
          <button type="button" class="danger" :disabled="busy || !recoveryChecked"
            @click="run(async () => { await client.discardPending(recoveryRequestId, recoveryChecked); message = state.message; })">确认放弃原请求</button>
        </template>
      </section>
    </section>
      </section>
    </div>
  </dialog>
</template>

<style scoped>
.account-field-error { color: var(--danger); font-size: 13px; }
.account-delete-confirmation { margin: 16px 0; padding: 16px; border: 1px solid var(--danger); border-radius: 8px; background: var(--surface-soft); }
.account-delete-confirmation p { overflow-wrap: anywhere; }
.account-avatar-trigger {
  min-width: 44px; min-height: 44px; display: flex; align-items: center; gap: 8px;
  padding: 3px 10px 3px 5px; border: 1px solid #35445c; border-radius: 9px;
  background: #111d30; color: var(--ink); text-align: left;
}
.account-avatar-trigger:hover { border-color: var(--accent); background: #17263d; }
.account-avatar-trigger:disabled { opacity: .65; }
.account-avatar-trigger > .app-icon { width: 16px; height: 16px; transform: rotate(90deg); color: #a7bdd8; }
.account-trigger-label { display: grid; min-width: 90px; line-height: 1.3; }
.account-trigger-label strong { max-width: 140px; overflow: hidden; color: #f0f5ff; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.account-trigger-label small { color: #c1d0e4; font-size: 10px; white-space: nowrap; }
.account-avatar {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; overflow: hidden;
  border: 1px solid var(--avatar-border); border-radius: 50%; background: var(--avatar-background);
  color: var(--avatar-foreground); font-weight: 700; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
}
.account-avatar img { width: 100%; height: 100%; object-fit: cover; }
.account-avatar-small { width: 34px; height: 34px; font-size: 12px; }
.account-avatar-menu { width: 44px; height: 44px; font-size: 14px; }
.account-menu-root { position: relative; }
.account-menu-popover {
  position: absolute; z-index: 70; top: calc(100% + 8px); right: 0; width: min(320px, calc(100vw - 24px));
  padding: 12px; border: 1px solid #52647e; border-radius: 10px; background: #121e31;
  box-shadow: 0 18px 48px #020617bb;
}
.account-menu-identity { display: flex; align-items: center; gap: 10px; padding: 4px 4px 12px; border-bottom: 1px solid var(--border); }
.account-menu-identity > div { display: grid; min-width: 0; gap: 4px; }
.account-menu-identity strong { overflow: hidden; color: #f2f7ff; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.account-menu-identity div > span { overflow: hidden; color: #c1d0e4; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.account-menu-links { display: grid; gap: 3px; padding: 8px 0; }
.account-menu-links a, .account-login-link {
  display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 10px;
  border-radius: 6px; color: #e8f0fc; font-size: 12px; text-decoration: none;
}
.account-menu-links a:hover, .account-login-link:hover { background: #21334e; color: #fff; }
.account-menu-links a .app-icon, .account-login-link .app-icon { width: 18px; height: 18px; color: #8fc2ff; }
.account-menu-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
.account-logout { min-height: 44px; padding: 8px 10px; background: transparent; color: #ffc0c0; font-size: 12px; }
.account-logout:hover { background: #3a202c; }
.account-page-dialog {
  position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none;
  margin: 0; padding: 0; overflow: auto; overscroll-behavior: contain; border: 0; border-radius: 0;
  background: radial-gradient(ellipse at 68% 0, #152742 0, #0b1120 52%); color: var(--ink);
}
.account-page-dialog::backdrop { background: #070d18; }
.account-page-header {
  position: sticky; z-index: 2; top: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px;
  min-height: 68px; padding: 10px 32px; border-bottom: 1px solid #2b3c55;
  background: #0d1728ee; backdrop-filter: blur(12px);
}
.account-page-brand { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 44px; color: var(--ink); font-size: 20px; text-decoration: none; }
.account-brand-copy { display: grid; gap: 2px; }
.account-brand-title { line-height: 1.2; letter-spacing: -.03em; white-space: nowrap; }
.account-page-brand strong { color: #c1d0e4; font-weight: 400; }
.account-page-brand small { color: var(--muted); font-size: 11px; line-height: 1.3; white-space: nowrap; }
.account-brand-mark { flex: 0 0 32px; width: 32px; height: 32px; color: #7db8ff; }
.account-return { flex: 0 0 auto; min-height: 44px; padding: 8px 12px; font-size: 12px; white-space: nowrap; }
.account-return .app-icon { transform: rotate(180deg); width: 17px; height: 17px; }
.account-page-content { width: min(1040px, calc(100% - 40px)); margin: 0 auto; padding: 30px 0 24px; }
.account-page-content-members { width: min(1380px, calc(100% - 40px)); }
.account-page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.account-page-heading .eyebrow { margin-bottom: 6px; color: #9fc2e8; }
.account-page-heading h1 { margin: 0; font-size: clamp(24px, 3vw, 31px); letter-spacing: -.03em; }
.account-session-chip, .account-role-chip {
  display: inline-flex; align-items: center; gap: 8px; min-height: 34px; padding: 7px 11px;
  border: 1px solid #52647e; border-radius: 999px; background: #15243a; color: #d7e5f8; font-size: 11px; white-space: nowrap;
}
.account-session-chip.is-connected { border-color: #3d806c; background: #102b2b; color: #b7f4df; }
.account-session-dot { width: 8px; height: 8px; border-radius: 50%; background: #a9bad0; }
.account-session-chip.is-connected .account-session-dot { background: #6ee7b7; box-shadow: 0 0 0 3px #6ee7b722; }
.account-profile-banner {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px;
  margin-bottom: 18px; padding: 20px; border: 1px solid #3b5270; border-radius: 12px;
  background: linear-gradient(110deg, #172b45, #121e31 72%); box-shadow: 0 12px 30px #02061738;
}
.account-avatar-large { width: 72px; height: 72px; border-width: 2px; box-shadow: 0 0 0 5px #7db8ff13; font-size: 22px; }
.account-profile-identity { min-width: 0; }
.account-profile-identity .eyebrow { margin-bottom: 5px; color: #9fc2e8; }
.account-profile-identity h2 { overflow-wrap: anywhere; }
.account-profile-identity p:last-child { margin: 5px 0 0; color: #c1d0e4; font-size: 12px; overflow-wrap: anywhere; }
.account-profile-metrics { display: flex; align-items: center; gap: 14px; }
.account-pending-count { display: grid; min-width: 76px; gap: 2px; padding-left: 14px; border-left: 1px solid var(--border); }
.account-pending-count strong { color: #f2f7ff; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 18px; }
.account-pending-count small { color: #c1d0e4; font-size: 10px; white-space: nowrap; }
.account-section-nav {
  display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 16px; padding: 6px;
  border: 1px solid #2e405b; border-radius: 10px; background: #111b2b;
}
.account-section-nav a {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 12px;
  border: 1px solid transparent; border-radius: 7px; color: #d7e5f8; font-size: 12px; text-decoration: none;
}
.account-section-nav a:hover { background: #1d2e47; color: #fff; }
.account-section-nav a.router-link-active { border-color: #42638a; background: #19304d; color: #fff; }
.account-section-nav .app-icon { width: 18px; height: 18px; color: #9fcaff; }
.account-nav-count { margin-left: 2px; min-width: 22px; padding: 3px 5px; border: 1px solid #456b91; border-radius: 10px; background: #1b3858; color: #e5f2ff; text-align: center; font: 11px ui-monospace, "Cascadia Mono", Consolas, monospace; }
.account-content {
  min-width: 0; padding: 20px; border: 1px solid #2e405b; border-radius: 11px;
  background: linear-gradient(155deg, #141f32, #111a2a 70%); box-shadow: 0 12px 30px #02061730;
}
.account-content-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 15px; border-bottom: 1px solid var(--border); }
.account-content-heading .eyebrow { margin-bottom: 4px; }
.account-content-heading h2 { outline-offset: 5px; }
.account-identity-compact { display: inline-flex; align-items: center; gap: 6px; color: #c1d0e4; font: 11px ui-monospace, "Cascadia Mono", Consolas, monospace; }
.account-identity-compact .app-icon { width: 16px; height: 16px; }
.account-content > .form-help { margin-top: 14px; }
.account-feedback { margin: 14px 0 0; padding: 12px 14px; border: 1px solid #405672; border-radius: 8px; background: #142137; color: #eaf1fc; font-size: 12px; line-height: 1.6; }
.account-feedback h3 { margin: 0 0 4px; }
.account-feedback p { margin: 0; overflow-wrap: anywhere; }
.account-feedback-error { border-color: #8d4651; background: #321d29; color: #ffe3e5; }
.account-feedback-status { border-color: #3b806c; background: #102b2b; color: #c7f5e5; }
.account-callout { margin-top: 16px; padding: 16px; border: 1px solid #405672; border-radius: 8px; background: #142137; }
.account-callout h3 { margin: 0 0 6px; }
.account-callout p { margin: 7px 0 12px; color: #c1d0e4; font-size: 12px; line-height: 1.6; }
.account-inline-link { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; color: #a9d2ff; font-size: 12px; font-weight: 600; }
.account-inline-link .app-icon { width: 16px; height: 16px; }
.account-content form, .account-content section { border-top: 1px solid var(--border); padding-top: 14px; margin-top: 14px; }
.account-content h3 { margin-top: 0; }
.account-content .actions { display: flex; flex-wrap: wrap; gap: 8px; }
.account-content .actions button { width: auto; flex: 1 1 150px; }
.account-content p, .account-content li { overflow-wrap: anywhere; }
.remember-login { display: flex; align-items: center; min-height: 44px; gap: 8px; }
.remember-login input { width: 20px; margin: 0; }
.collaboration-error {
  margin-top: 14px; padding: 12px 14px; border: 1px solid #8d4651; border-radius: 8px;
  background: #321d29; color: #ffe3e5;
}
.collaboration-error h3 { margin: 0 0 4px; }
.collaboration-error p { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.account-content .member-management { margin-top: 0; padding-top: 18px; border: 0; }
.member-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.member-toolbar-title h3 { margin: 0; font-size: 15px; }
.member-toolbar-title h3 span { margin-left: 5px; color: var(--muted); font-size: 12px; font-weight: 400; }
.member-toolbar-title p, .member-form-heading p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.member-toolbar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.member-toolbar-actions button { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
.member-toolbar-actions .app-icon { width: 16px; height: 16px; }
.member-search { display: flex; align-items: center; gap: 8px; min-width: 250px; margin: 0; color: #d7e5f8; font-size: 12px; }
.member-search span { white-space: nowrap; }
.member-search input { width: 100%; min-height: 44px; margin: 0; }
.member-form-panel { margin-top: 18px; padding: 16px; border: 1px solid #405672; border-radius: 8px; background: #18253a; }
.member-form-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.member-form-heading h3 { margin: 0; font-size: 14px; outline-offset: 4px; }
.member-form-close { flex: 0 0 44px; width: 44px; height: 44px; padding: 10px; }
.member-form-close .app-icon { width: 18px; height: 18px; }
.account-content .member-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; border: 0; padding: 0; margin-top: 16px; }
.member-form label { display: block; }
.member-form input { width: 100%; margin-bottom: 0; }
.member-form .form-help { margin: 4px 0 0; }
.member-form-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
.member-form-actions button { width: auto; min-width: 100px; min-height: 44px; }
.member-table-scroll { max-width: 100%; overflow-x: auto; margin-top: 20px; border-top: 1px solid var(--border); }
.member-table { width: 100%; min-width: 820px; border-collapse: collapse; text-align: left; font-size: 12px; }
.member-table th { padding: 13px 12px; color: #c1d0e4; font-weight: 600; white-space: nowrap; }
.member-table td { padding: 12px; border-top: 1px solid var(--border); color: #d7e5f8; overflow-wrap: anywhere; }
.member-table tbody tr:hover { background: #1a2a41; }
.member-table code { color: #c1d0e4; }
.member-name-cell { display: flex; align-items: center; gap: 10px; min-width: 150px; }
.member-name-cell > span:last-child { display: grid; gap: 3px; }
.member-name-cell strong { color: var(--ink); font-size: 13px; }
.member-name-cell small, .member-admin-note { color: #c1d0e4; font-size: 11px; }
.account-member-status { display: inline-block; padding: 4px 8px; border: 1px solid #3d806c; border-radius: 5px; background: #102b2b; color: #b7f4df; font-size: 11px; white-space: nowrap; }
.account-member-status.is-disabled { border-color: var(--border-strong); background: var(--surface-soft); color: #d7e5f8; }
.account-member-actions { display: flex; flex-shrink: 0; gap: 8px; }
.account-member-actions button { min-height: 44px; padding: 8px 10px; white-space: nowrap; }
.account-member-actions .account-member-delete { border-color: var(--danger); color: var(--danger); background: transparent; }
.account-member-actions .account-member-delete:hover { background: var(--surface-raised); }
.member-empty { padding: 28px 12px; text-align: center; color: var(--muted); font-size: 13px; }
.member-reset-link { margin-top: 12px; min-height: 44px; }
@media (max-width: 700px) {
  .account-page-content { width: min(100% - 28px, 620px); padding-top: 20px; }
  .account-profile-banner { grid-template-columns: auto minmax(0, 1fr); gap: 12px; padding: 14px; }
  .account-avatar-large { width: 58px; height: 58px; font-size: 18px; }
  .account-profile-metrics { grid-column: 1 / -1; justify-content: space-between; padding-top: 10px; border-top: 1px solid var(--border); }
}
@media (max-width: 520px) {
  .member-toolbar-actions { width: 100%; }
  .member-search { flex: 1 1 100%; min-width: 0; }
  .account-content .member-form { grid-template-columns: minmax(0, 1fr); }
  .account-avatar-trigger { padding-right: 5px; }
  .account-trigger-label, .account-avatar-trigger > .app-icon { display: none; }
  .account-page-header { gap: 12px; padding-inline: 12px; }
  .account-page-brand { gap: 8px; font-size: 16px; }
  .account-return { padding-inline: 8px; font-size: 11px; }
  .account-page-content { width: calc(100% - 24px); padding-top: 16px; }
  .account-page-heading { align-items: flex-start; flex-direction: column; }
  .account-content { padding: 14px; }
  .account-identity-compact { display: none; }
}
</style>
