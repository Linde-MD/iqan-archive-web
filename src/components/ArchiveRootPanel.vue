<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue';
import type { ArchiveRepository } from '../storage/database';
import { checkPermission, chooseDirectory, type DirectoryHandle } from '../files/directories';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ repository: ArchiveRepository; disabled: boolean }>();
const emit = defineEmits<{ root: [handle: DirectoryHandle | undefined]; busy: [value: boolean]; error: [cause: unknown] }>();
const root = shallowRef<DirectoryHandle>();
const permission = ref('未授权');
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
    root.value = await props.repository.getArchiveRoot();
    emit('root', root.value);
    if (!root.value) { permission.value = '未授权'; return; }
    permission.value = await checkPermission(root.value, false, 'readwrite') ? '读写已授权' : '需要读写授权';
  });
}

async function chooseRoot() {
  await operation(async () => {
    const selected = await chooseDirectory('readwrite');
    if (!selected) { message.value = '已取消选择，原根目录未改变。'; return; }
    if (!await checkPermission(selected, false, 'readwrite')) throw new Error('根目录未获读写授权，原设置未改变。');
    await props.repository.setArchiveRoot(selected);
    root.value = selected;
    permission.value = '读写已授权';
    emit('root', selected);
    message.value = '根目录已保存；项目子目录将按项目名称自动定位。';
  });
}

async function authorize() {
  await operation(async () => {
    if (!root.value) throw new Error('请先选择归档根目录。');
    const granted = await checkPermission(root.value, true, 'readwrite');
    permission.value = granted ? '读写已授权' : '需要读写授权';
    if (!granted) throw new Error('根目录读写权限被拒绝，请重新授权或重新选择。');
    emit('root', root.value);
  });
}

async function unbind() {
  await operation(async () => {
    await props.repository.db.archiveRoots.delete('root');
    root.value = undefined;
    permission.value = '未授权';
    emit('root', undefined);
    message.value = '已解除统一根目录授权；磁盘文件和项目数据未删除。';
  });
}

onMounted(restore);
</script>

<template>
  <section class="panel archive-root-panel" aria-labelledby="archive-root-title" :aria-busy="busy">
    <div class="section-heading">
      <div><p class="eyebrow">LOCAL DIRECTORY</p><h2 id="archive-root-title">归档根目录</h2></div>
      <span class="permission-badge">{{ permission }}</span>
    </div>
    <div class="archive-root-value">
      <AppIcon name="folder" />
      <strong>{{ root?.name ?? '尚未选择目录' }}</strong>
    </div>
    <p v-if="!root" class="form-help">选择一次后，各项目按名称自动定位工程和文档子目录。JSON 备份读写此根目录；子目录只扫描读取。</p>
    <div class="actions">
      <button type="button" class="secondary" :disabled="disabled || busy" @click="chooseRoot"><AppIcon name="folder" />{{ root ? '更换根目录' : '选择根目录' }}</button>
      <button type="button" class="secondary" :disabled="disabled || busy || !root" @click="authorize"><AppIcon name="shield" />重新授权</button>
      <button type="button" class="secondary" :disabled="disabled || busy || !root" @click="unbind"><AppIcon name="unlink" />解除授权</button>
    </div>
    <p role="status">{{ busy ? '正在处理归档根目录…' : message }}</p>
  </section>
</template>