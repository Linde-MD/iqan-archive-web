import { createApp } from 'vue';
import RouterRoot from './RouterRoot.vue';
import { router } from './router';
import './style.css';

createApp(RouterRoot).use(router).mount('#app');
