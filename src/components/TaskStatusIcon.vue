<script setup lang="ts">
import { computed } from 'vue';
import { taskStatusPresentation } from '../utils/task-status-presentation';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ statusName: string | null }>();
const presentation = computed(() => taskStatusPresentation(props.statusName));
</script>

<template>
  <AppIcon class="task-status-icon" :name="presentation.icon" :style="{ color: presentation.color }" />
</template>

<style scoped>
.task-status-icon { flex: 0 0 auto; width: 18px; height: 18px; }
</style>
