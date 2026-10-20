import { createApp } from 'vue';
import '@/assets/design-system.css';
import '@/assets/themes.css';
import FloatingDockApp from './FloatingDockApp.vue';

export function mountFloatingDock(): void {
  createApp(FloatingDockApp).mount('#app');
}
