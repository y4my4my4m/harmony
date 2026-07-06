import { createApp } from 'vue';
import OverlayApp from './OverlayApp.vue';

export function mountOverlay(): void {
  createApp(OverlayApp).mount('#app');
}
