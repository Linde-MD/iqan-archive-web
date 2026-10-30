<script setup lang="ts">
defineProps<{ name: 'folder' | 'copy' | 'refresh' | 'scan' | 'unlink' | 'stop' | 'check' | 'clear' | 'plus' | 'arrow' | 'file' | 'shield' }>();
const paths = {
  folder: 'M3 7V5h6l2 2h10v13H3Z M3 10h18',
  copy: 'M9 9h11v12H9Z M15 9V3H3v12h6',
  refresh: 'M20 7A9 9 0 1 0 21 14 M20 3v5h-5',
  scan: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M7 12h10',
  unlink: 'M9 15l6-6 M8 4l-3 3a5 5 0 0 0 7 7 M16 20l3-3a5 5 0 0 0-7-7 M3 3l18 18',
  stop: 'M6 6h12v12H6Z',
  check: 'M4 12l5 5L20 6',
  clear: 'M6 6l12 12 M6 18L18 6',
  plus: 'M12 4v16 M4 12h16',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  file: 'M14 3H5v18h14V8Z M14 3v5h5 M9 13h6 M9 17h6',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z M8 12l3 3 5-6',
};
</script>

<template>
  <svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path :d="paths[name]" /></svg>
</template>
