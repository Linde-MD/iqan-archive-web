<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import { checkPermission, chooseDirectory, sameDirectory, type ArchiveRoots } from '../files/directories';
import { buildArchiveRootOpenUri } from '../domain/iqan-protocol';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; disabled: boolean }>();
const emit = defineEmits<{ roots: [roots: ArchiveRoots]; busy: [value: boolean]; error: [cause: unknown] }>();
const roots = shallowRef<ArchiveRoots>({});
const permission = ref<Record<'shared' | 'local', string>>({ shared: '未授权', local: '未授权' });
const busy = ref(false);
const message = ref('');
const menu = ref<HTMLDetailsElement>();
const menuTrigger = ref<HTMLElement>();

function diagnose(event: string, details: Record<string, unknown> = {}) {
  console.info('[archive-root]', { event, ...details });
}

function errorDetails(cause: unknown) {
  return {
    errorName: cause instanceof Error ? cause.name : typeof cause,
    ...(cause instanceof DOMException ? { errorCode: cause.code } : {}),
    ...(cause instanceof Error && !(cause instanceof DOMException) ? { errorMessage: cause.message.slice(0, 240) } : {}),
  };
}

async function operation(actionName: string, action: () => Promise<void>) {
  busy.value = true;
  emit('busy', true);
  message.value = '';
  diagnose('operation-start', { action: actionName });
  try { await action(); }
  catch (cause) {
    diagnose('operation-error', { action: actionName, ...errorDetails(cause) });
    emit('error', cause);
  }
  finally {
    diagnose('operation-end', { action: actionName });
    busy.value = false;
    emit('busy', false);
  }
}

async function restore() {
  await operation('restore', async () => {
    diagnose('restore-start', {
      secureContext: window.isSecureContext,
      directoryPickerAvailable: typeof window.showDirectoryPicker === 'function',
      userAgent: navigator.userAgent,
    });
    const [shared, local] = await Promise.all([
      props.repository.getArchiveRoot('shared'), props.repository.getArchiveRoot('local'),
    ]);
    roots.value = {
      ...(shared ? { shared } : {}),
      ...(local ? { local } : {}),
    };
    emit('roots', roots.value);
    const permissionStates: Record<'shared' | 'local', string> = { shared: 'unavailable', local: 'unavailable' };
    for (const location of ['shared', 'local'] as const) {
      const root = roots.value[location];
      const state = root ? await root.queryPermission({ mode: 'readwrite' }) : 'unavailable';
      permissionStates[location] = state;
      permission.value[location] = state === 'granted' ? '读写已授权' : root ? '需要读写授权' : '未授权';
    }
    diagnose('restore-result', {
      sharedConfigured: Boolean(shared), localConfigured: Boolean(local),
      sharedPermission: permissionStates.shared, localPermission: permissionStates.local,
    });
  });
}

async function chooseRoot(location: 'shared' | 'local') {
  await operation('choose-root', async () => {
    diagnose('picker-start', {
      location,
      secureContext: window.isSecureContext,
      directoryPickerAvailable: typeof window.showDirectoryPicker === 'function',
      userActivationActive: navigator.userActivation?.isActive ?? null,
    });
    const selected = await chooseDirectory('readwrite');
    if (!selected) {
      diagnose('picker-canceled', { location });
      message.value = '已取消选择，原设置未改变。';
      return;
    }
    let permissionState = await selected.queryPermission({ mode: 'readwrite' });
    diagnose('permission-query-result', { location, permissionState });
    if (permissionState !== 'granted') {
      diagnose('permission-request-start', {
        location,
        userActivationActive: navigator.userActivation?.isActive ?? null,
      });
      permissionState = await selected.requestPermission({ mode: 'readwrite' });
      diagnose('permission-request-result', { location, permissionState });
    }
    if (permissionState !== 'granted') throw new Error('目录未获读写授权，原设置未改变。');
    diagnose('database-save-start', { location });
    await props.repository.setArchiveRoot(selected, location);
    const saved = await props.repository.getArchiveRoot(location);
    const identityMatches = saved
      ? saved === selected ? true : selected.isSameEntry ? await sameDirectory(selected, saved) : null
      : false;
    diagnose('database-save-verified', { location, persisted: Boolean(saved), identityMatches });
    if (!saved) throw new Error('目录权限已获准，但归档根目录写入后未能读取到记录。');
    roots.value = { ...roots.value, [location]: selected };
    permission.value[location] = '读写已授权';
    emit('roots', roots.value);
    diagnose('roots-emitted', { sharedConfigured: Boolean(roots.value.shared), localConfigured: Boolean(roots.value.local) });
    message.value = `${location === 'shared' ? '共享' : '本地'}归档根目录已保存。`;
  });
}

async function authorize(location: 'shared' | 'local') {
  await operation('authorize', async () => {
    const root = roots.value[location];
    if (!root) throw new Error(`请先选择${location === 'shared' ? '共享' : '本地'}归档根目录。`);
    const granted = await checkPermission(root, true, 'readwrite');
    diagnose('permission-request-result', { location, permissionState: granted ? 'granted' : 'not-granted' });
    permission.value[location] = granted ? '读写已授权' : '需要读写授权';
    if (!granted) throw new Error('根目录读写权限被拒绝，请重新授权或重新选择。');
    emit('roots', roots.value);
  });
}

async function openRoot(location: 'shared' | 'local') {
  await operation('open-root', async () => {
    const root = roots.value[location];
    if (!root) throw new Error(`请先选择${location === 'shared' ? '共享' : '本地'}根目录。`);
    if (!await checkPermission(root, false, 'readwrite'))
      throw new Error(`${location === 'shared' ? '共享' : '本地'}根目录授权已失效，请重新授权后再打开。`);
    window.location.assign(buildArchiveRootOpenUri(location));
    message.value = `已请求 Launcher 打开${location === 'shared' ? '共享' : '本地'}根目录；请在本机核对路径并确认。网页无法确认资源管理器是否已打开。`;
  });
}

function closeMenu() {
  if (menu.value) menu.value.open = false;
  menuTrigger.value?.focus();
}

function onOutsidePointerDown(event: PointerEvent) {
  if (menu.value?.open && !event.composedPath().includes(menu.value)) menu.value.open = false;
}

async function unbind(location: 'shared' | 'local') {
  await operation('unbind', async () => {
    await props.repository.db.archiveRoots.delete(location);
    const next = { ...roots.value };
    delete next[location];
    roots.value = next;
    permission.value[location] = '未授权';
    emit('roots', next);
    message.value = `已解除${location === 'shared' ? '共享' : '本地'}根目录授权；磁盘文件和项目数据未删除。`;
  });
}

onMounted(() => {
  diagnose('component-mounted');
  window.addEventListener('pointerdown', onOutsidePointerDown, true);
  void restore();
});
onUnmounted(() => window.removeEventListener('pointerdown', onOutsidePointerDown, true));
</script>

<template>
  <details ref="menu" class="topbar-menu archive-root-menu" @keydown.esc.prevent="closeMenu">
    <summary ref="menuTrigger" class="topbar-menu-trigger"><AppIcon name="folder" />归档目录</summary>
    <div class="topbar-menu-items archive-menu-items" :aria-busy="busy">
      <section v-for="location in ['shared', 'local'] as const" :key="location" class="archive-menu-group" :aria-labelledby="`archive-${location}-title`">
        <div class="archive-menu-heading">
          <h3 :id="`archive-${location}-title`">{{ location === 'shared' ? '共享根目录' : '本地根目录' }}</h3>
          <span class="permission-badge">{{ permission[location] }}</span>
        </div>
        <div class="archive-root-value"><AppIcon name="folder" /><strong>{{ roots[location]?.name ?? '尚未选择目录' }}</strong></div>
        <div class="archive-menu-actions">
          <button type="button" :aria-label="`${roots[location] ? '更换' : '选择'}${location === 'shared' ? '共享' : '本地'}根目录`" :disabled="disabled || busy" @click="chooseRoot(location)"><AppIcon name="folder" />{{ roots[location] ? '更换' : '选择' }}</button>
          <button type="button" :disabled="disabled || busy || !roots[location]" :aria-label="`重新授权${location === 'shared' ? '共享' : '本地'}根目录`" @click="authorize(location)"><AppIcon name="shield" />授权</button>
          <button type="button" :disabled="disabled || busy || !roots[location]" :aria-label="`打开${location === 'shared' ? '共享' : '本地'}根目录`" :title="`请求 Launcher 打开本机配置的${location === 'shared' ? '共享' : '本地'}根目录`" @click="openRoot(location)"><AppIcon name="folder" />打开目录</button>
          <button type="button" :disabled="disabled || busy || !roots[location]" :aria-label="`解除${location === 'shared' ? '共享' : '本地'}根目录授权`" @click="unbind(location)"><AppIcon name="unlink" />移除</button>
        </div>
      </section>
      <p class="archive-menu-status" role="status">{{ busy ? '正在处理归档根目录…' : message }}</p>
    </div>
  </details>
</template>