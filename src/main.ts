// Import unified design system (single source of truth for tokens + base styles)
import './assets/design-system.css'
import './assets/shared.css'
import './assets/embed-previews.css'
import './assets/themes.css' // Theme system CSS
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n, waitForInitialLocale } from './i18n'
import { serviceWorkerManager } from '@/services/ServiceWorkerManager'
import { pwaManager } from '@/services/PWAManager'
import { useAuthStore } from '@/stores/auth'
import { isTauriRuntime } from '@/services/instanceConfig'
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
  // Warnings/errors go top-center with longer timeouts so they don't get
  // buried under routine info/success toasts in the corner.
  toastDefaults: {
    error: { position: 'top-center', timeout: 8000 },
    warning: { position: 'top-center', timeout: 8000 },
  },
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
    // The three pre-mount requirements are independent - run them in
    // PARALLEL. They used to run serially (locale -> SW -> PWA -> auth ->
    // emoji packs), which pushed first data fetch out by their summed
    // latency on every cold start.
    //   - locale: translations must exist before first render
    //   - SW -> PWA: registration must precede install/push checks (kept as
    //     one sequential chain, but concurrent with the rest)
    //   - auth: session must be adopted before router guards run
    // SW/PWA is web-only; skip in Tauri (has its own native notification path)
    const swChain = isTauriRuntime() ? Promise.resolve() : (async () => {
      const swSupported = await serviceWorkerManager.initialize()
      debug.log('🔔 Service Worker supported:', swSupported)
      await pwaManager.initialize()
      debug.log('🚀 PWA Manager initialized')
      // no auto permission request here: unprompted requests get flagged as spammy
    })()

    const authStore = useAuthStore()
    await Promise.all([
      waitForInitialLocale().then(() => debug.log('🌐 Initial locale loaded')),
      swChain.catch((err) => debug.warn('⚠️ SW/PWA init failed (non-fatal):', err)),
      authStore.initializeAuth().then(() => debug.log('✅ Auth initialized')),
    ])

    // Mount the app AFTER auth
    mountApp()

    // Emoji pack detection probes external pack availability - best-effort
    // and NOT needed for first paint; run it after mount in the background.
    detectAvailablePacks()
      .then(() => debug.log('📦 Emoji packs detected'))
      .catch((err) => debug.warn('⚠️ Emoji pack detection failed, using builtin packs:', err))

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

// The transparent game overlay loads this same bundle at index.html?overlay=1;
// mount the lightweight overlay app instead of the full client.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('overlay') === '1') {
  import('./overlay/mountOverlay').then(m => m.mountOverlay()).catch(err => debug.error('overlay mount failed', err))
} else {
  initializeApp()
  import('@/services/nativePresence').then(m => m.initRichPresence()).catch(() => {})
}
