// Import unified design system first
import './assets/design-system.css'
import './assets/main.css'
import './assets/shared.css'
import './assets/embed-previews.css'
import './assets/themes.css' // Theme system CSS
// Dynamically import 'pwa.css' based on mobile detection
// async function loadMobileStyles() {
//   const isMobile = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|Windows Phone/i.test(navigator.userAgent);
//   if (isMobile) {
//     await import('./assets/pwa.css');
//     debug.log('📱 Mobile styles loaded');
//   }
// }
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { serviceWorkerManager } from '@/services/ServiceWorkerManager'
import { pwaManager } from '@/services/PWAManager'
import { useAuthStore } from '@/stores/auth'
import { reactionCacheManager } from '@/utils/reactionCacheManager'

import Toast from 'vue-toastification';
import "vue-toastification/dist/index.css";

import VueEasyLightbox from 'vue-easy-lightbox';
import './assets/vue-easy-lightbox.css';

import VueLazyLoad from 'vue3-lazyload';
import MasonryWall from '@yeger/vue-masonry-wall'

// TODO: FIXME
import ClickOutsideDirective from './directives/ClickOutsideDirective';
import { vHaptic } from './utils/hapticFeedback';
import { debug } from '@/utils/debug'
import { webrtcManager } from '@/services/webrtcManager';
import { livekitWebRTC } from '@/services/livekitWebRTC';

// Expose for debugging in browser console
if (typeof window !== 'undefined') {
  (window as any).webrtcManager = webrtcManager;
  (window as any).livekitWebRTC = livekitWebRTC;
}

const app = createApp(App);

app.use(Toast, {
  transition: "Vue-Toastification__bounce",
  maxToasts: 20,
  newestOnTop: true,
  timeout: 2500,
  pauseOnHover: true,
  closeOnClick: true,
});

const pinia = createPinia();
app.use(pinia);
app.use(i18n);

app.use(VueEasyLightbox);
app.use(MasonryWall)

app.use(VueLazyLoad, {
  // options...
});

app.directive('scroll-bottom', {
  updated(el, binding) {
    if (binding.value) {
      el.scrollTop = el.scrollHeight;
    }
  },
});
  
app.directive('click-outside', ClickOutsideDirective);
app.directive('haptic', vHaptic);

async function initializeApp() {
  // Mount the app IMMEDIATELY - don't wait for non-critical services
  app.use(router).mount('#app')
  
  // Initialize critical auth first (needed for routing)
  try {
    const authStore = useAuthStore()
    await authStore.initializeAuth()
    debug.log('✅ Auth initialized')
  } catch (error) {
    debug.error('❌ Error initializing auth:', error)
  }
  
  // Initialize non-critical services in background (don't block rendering)
  Promise.all([
    // PWA features - mostly synchronous setup, can run in parallel
    pwaManager.initialize().then(() => {
      debug.log('🚀 PWA Manager initialized')
    }).catch(err => {
      debug.error('❌ PWA Manager initialization failed:', err)
    }),
    
    // Service worker - can be slow, run in background
    serviceWorkerManager.initialize().then(swSupported => {
      debug.log('🔔 Service Worker supported:', swSupported)
      
      // Request notification permission in background (non-blocking)
      if (swSupported) {
        // Don't await - let it happen in background
        serviceWorkerManager.requestNotificationPermission().catch(err => {
          debug.warn('⚠️ Notification permission request failed:', err)
        })
      }
    }).catch(err => {
      debug.error('❌ Service Worker initialization failed:', err)
    })
  ]).catch(err => {
    debug.error('❌ Error initializing background services:', err)
  })
  
  // Start reaction cache management
  // TODO: revisit reactionCacheManager
  // reactionCacheManager.startCleanup()
  // debug.log('🎯 Reaction cache manager started')
}

// Initialize the application
initializeApp()
