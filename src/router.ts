import { createRouter, createWebHashHistory } from 'vue-router';

export { parseWorkspaceLocation, projectOverlayPath, projectPath } from './workspace-routes';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/:pathMatch(.*)*', name: 'workspace', component: () => import('./App.vue') }],
});