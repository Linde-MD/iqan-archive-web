<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import { checkPermission, chooseDirectory, type ArchiveRoots, type DirectoryHandle } from '../files/directories';
import { buildArchiveRootOpenUri } from '../domain/iqan-protocol';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; disabled: boolean }>();
const emit = defineEmits<{ roots: [roots: ArchiveRoots]; busy: [value: boolean]; error: [cause: unknown] }>();
const roots = shallowRef<ArchiveRoots>({});
const permission = ref<Record<'shared' | 'local', string>>({ shared: '未授权', local: '未授权' });
const busy = ref(false);
const message = ref('');

async function operation(action: () => Promise<void>) {
  busy.value = true;
  emit('busy', true);
  message.value = '';
  try { await action(); }
  catch (cause) { emit('error', cause); }
  finally { busy.value = false; emit('busy', false); }
}

async function restore() {
  await operation(async () => {
    const [shared, local] = await Promise.all([
      props.repository.getArchiveRoot('shared'), props.repository.getArchiveRoot('local'),
    ]);
    roots.value = {
      ...(shared ? { shared } : {}),
      ...(local ? { local } : {}),
    };
    emit('roots', roots.value);
    for (const location of ['shared', 'local'] as const) {
      permission.value[location] = roots.value[location]
        ? await checkPermission(roots.value[location]!, false, 'readwrite') ? '读写已授权' : '需要读写授权'
        : '未授权';
    }
  });
}

async function chooseRoot(location: 'shared' | 'local') {
  await operation(async () => {
    const selected = await chooseDirectory('readwrite');
    if (!selected) { message.value = '已取消选择，原设置未改变。'; return; }
    if (!await checkPermission(selected, false, 'readwrite')) throw new Error('目录未获读写授权，原设置未改变。');
    await props.repository.setArchiveRoot(selected, location);
    roots.value = { ...roots.value, [location]: selected };
    permission.value[location] = '读写已授权';
    emit('roots', roots.value);
    message.value = `${location === 'shared' ? '共享' : '本地'}归档根目录已保存。`;
  });
}

async function authorize(location: 'shared' | 'local') {
  await operation(async () => {
    const root = roots.value[location];
    if (!root) throw new Error(`请先选择${location === 'shared' ? '共享' : '本地'}归档根目录。`);
    const granted = await checkPermission(root, true, 'readwrite');
    permission.value[location] = granted ? '读写已授权' : '需要读写授权';
    if (!granted) throw new Error('根目录读写权限被拒绝，请重新授权或重新选择。');
    emit('roots', roots.value);
  });
}

async function openRoot(location: 'shared' | 'local') {
  await operation(async () => {
    const root = roots.value[location];
    if (!root) throw new Error(`请先选择${location === 'shared' ? '共享' : '本地'}根目录。`);
    if (!await checkPermission(root, false, 'readwrite'))
      throw new Error(`${location === 'shared' ? '共享' : '本地'}根目录授权已失效，请重新授权后再打开。`);
    window.location.assign(buildArchiveRootOpenUri(location));
    message.value = `已请求 Launcher 打开${location === 'shared' ? '共享' : '本地'}根目录；请在本机核对路径并确认。网页无法确认资源管理器是否已打开。`;
  });
}

async function unbind(location: 'shared' | 'local') {
  await operation(async () => {
    await props.repository.db.archiveRoots.delete(location);
    const next = { ...roots.value };
    delete next[location];
    roots.value = next;
    permission.value[location] = '未授权';
    emit('roots', next);
    message.value = `已解除${location === 'shared' ? '共享' : '本地'}根目录授权；磁盘文件和项目数据未删除。`;
  });
}

onMounted(restore);
</script>

<template>
  <section class="panel archive-root-panel" aria-labelledby="archive-root-title" :aria-busy="busy">
    <div class="section-heading"><h2 id="archive-root-title">归档目录</h2><span class="archive-root-note">JSON · 本地根目录</span></div>
    <div class="archive-root-grid">
      <div v-for="location in ['shared', 'local'] as const" :key="location" class="archive-root-entry">
        <div class="section-heading">
          <h3>{{ location === 'shared' ? '共享根目录' : '本地根目录' }}</h3>
          <span class="permission-badge">{{ permission[location] }}</span>
        </div>
        <div class="archive-root-value"><AppIcon name="folder" /><strong>{{ roots[location]?.name ?? '尚未选择目录' }}</strong></div>
        <div class="actions">
          <button type="button" class="secondary" :aria-label="`${roots[location] ? '更换' : '选择'}${location === 'shared' ? '共享' : '本地'}根目录`" :disabled="disabled || busy" @click="chooseRoot(location)"><AppIcon name="folder" />{{ roots[location] ? '更换' : '选择' }}</button>
          <button type="button" class="secondary" :aria-label="`在资源管理器中打开${location === 'shared' ? '共享' : '本地'}根目录`" :title="`请求 Launcher 打开本机配置的${location === 'shared' ? '共享' : '本地'}根目录`" :disabled="disabled || busy || !roots[location]" @click="openRoot(location)"><AppIcon name="folder" />打开目录</button>
          <button type="button" class="secondary" :aria-label="`重新授权${location === 'shared' ? '共享' : '本地'}根目录`" :disabled="disabled || busy || !roots[location]" @click="authorize(location)"><AppIcon name="shield" />授权</button>
          <button type="button" class="secondary" :aria-label="`解除${location === 'shared' ? '共享' : '本地'}根目录授权`" :disabled="disabled || busy || !roots[location]" @click="unbind(location)"><AppIcon name="unlink" />移除</button>
        </div>
      </div>
    </div>
    <p role="status">{{ busy ? '正在处理归档根目录…' : message }}</p>
  </section>
</template>