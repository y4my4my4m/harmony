// Import unified design system (single source of truth for tokens + base styles)
import './assets/design-system.css'
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
import { i18n, waitForInitialLocale } from './i18n'
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
import { detectAvailablePacks } from '@/services/emojiPackService';

// Expose for debugging in browser console
if (typeof window !== 'undefined') {
  (window as any).webrtcManager = webrtcManager;
  (window as any).livekitWebRTC = livekitWebRTC;
  (window as any).pwaManager = pwaManager;
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

app.config.errorHandler = (err, instance, info) => {
  debug.error(`[Vue Error] ${info}:`, err)
}

async function initializeApp() {
  let mounted = false
  const mountApp = () => {
    if (mounted) return
    app.use(router).mount('#app')
    mounted = true
  }

  try {
    // Wait for initial locale to load (ensures translations are available)
    await waitForInitialLocale()
    debug.log('🌐 Initial locale loaded')
    
    // Register service worker before PWA/install checks (push + installability)
    const swSupported = await serviceWorkerManager.initialize()
    debug.log('🔔 Service Worker supported:', swSupported)

    // Initialize PWA features (install prompt listener, diagnostics)
    await pwaManager.initialize()
    debug.log('🚀 PWA Manager initialized')

    if (swSupported && Notification.permission === 'default') {
      serviceWorkerManager.requestNotificationPermission().catch((err) => {
        debug.warn('⚠️ Notification permission request failed:', err)
      })
    }
    
    // Initialize auth store first to check for existing sessions (CRITICAL - must be before mount)
    const authStore = useAuthStore()
    await authStore.initializeAuth()
    debug.log('✅ Auth initialized')

    try {
      await detectAvailablePacks()
      debug.log('📦 Emoji packs detected')
    } catch (err) {
      debug.warn('⚠️ Emoji pack detection failed, using builtin packs:', err)
    }

    // Mount the app AFTER auth (emoji detection is best-effort above)
    mountApp()

    try {
      reactionCacheManager.startCleanup()
    } catch (err) {
      debug.error('❌ reactionCacheManager.startCleanup failed:', err)
    }
  } catch (error) {
    debug.error('❌ Error initializing app:', error)
    // Still mount the app even if initialization fails (no-op if already mounted)
    mountApp()
  }
}

// Initialize the application
initializeApp()
