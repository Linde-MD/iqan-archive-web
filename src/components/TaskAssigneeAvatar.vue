<script setup lang="ts">
import { computed } from 'vue';
import { accountAvatarTheme, accountInitials } from '../domain/account';
import type { TaskAssignee } from '../domain/model';

const props = withDefaults(defineProps<{
  assignee: TaskAssignee;
  size?: 'small' | 'medium';
}>(), { size: 'small' });

const initials = computed(() => accountInitials(props.assignee.displayName, props.assignee.username));
const style = computed(() => {
  const theme = accountAvatarTheme(props.assignee.id);
  return {
    '--avatar-background': theme.background,
    '--avatar-foreground': theme.foreground,
    '--avatar-border': theme.border,
  };
});
</script>

<template>
  <span class="task-assignee-avatar" :class="`is-${size}`" :style="style" :title="`${assignee.displayName}（@${assignee.username}）`" aria-hidden="true">
    <img v-if="assignee.avatar" :src="assignee.avatar" alt="">
    <span v-else>{{ initials }}</span>
  </span>
</template>

<style scoped>
.task-assignee-avatar {
  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; overflow: hidden;
  border: 1px solid var(--avatar-border); border-radius: 50%; background: var(--avatar-background);
  color: var(--avatar-foreground); font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  font-weight: 700; line-height: 1;
}
.task-assignee-avatar img { width: 100%; height: 100%; object-fit: cover; }
.task-assignee-avatar.is-small { width: 26px; height: 26px; font-size: 10px; }
.task-assignee-avatar.is-medium { width: 34px; height: 34px; font-size: 12px; }
</style>
