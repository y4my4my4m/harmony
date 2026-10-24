// Import unified design system (single source of truth for tokens + base styles)
import './assets/design-system.css'
import './assets/shared.css'
import './assets/embed-previews.css'
import './assets/themes.css' // Theme system CSS
import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n, waitForInitialLocale } from './i18n'
import { serviceWorkerManager } from '@/services/ServiceWorkerManager'
import { pwaManager } from '@/services/PWAManager'
import { useAuthStore } from '@/stores/auth'
import { isTauriRuntime } from '@/services/instanceConfig'
import { getBuildInfo, getNativeVersion } from '@/utils/buildInfo'
import { reloadIfStaleBundle, withoutStaleParam } from '@/utils/staleBundle'
import { reactionCacheManager } from '@/utils/reactionCacheManager'
import { setAppSessionCookie } from '@/utils/appSessionCookie'

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
import { installRenderFallback } from '@/utils/renderFallback';
import { toastRole } from '@/utils/a11y/toastRole';
import { installOverlayHistory } from '@/utils/overlayHistory';
import { isMobileLayout } from '@/composables/useLayoutState';

// Expose for debugging in browser console
if (typeof window !== 'undefined') {
  (window as any).webrtcManager = webrtcManager;
  (window as any).livekitWebRTC = livekitWebRTC;
  (window as any).pwaManager = pwaManager;
}

installRenderFallback();
// Copying rendered messages and posts writes custom emoji as their tokens.
void import('@/utils/emojiClipboard').then(({ installRenderedEmojiCopy }) => installRenderedEmojiCopy());

const app = createApp(App);

app.use(Toast, {
  transition: "Vue-Toastification__bounce",
  maxToasts: 20,
  newestOnTop: true,
  // Long enough to be read, or heard, before it goes (WCAG 2.2.1).
  timeout: 6000,
  pauseOnHover: true,
  pauseOnFocusLoss: true,
  closeOnClick: true,
  // Warnings/errors go top-center with longer timeouts so they don't get
  // buried under routine info/success toasts in the corner.
  toastDefaults: {
    error: { position: 'top-center', timeout: 8000 },
    warning: { position: 'top-center', timeout: 8000 },
  },
  // Errors and warnings interrupt (role=alert); the rest are polite (role=status).
  filterBeforeCreate: (toast: any) => ({
    ...toast,
    accessibility: {
      toastRole: toastRole(toast.type),
      closeButtonLabel: i18n.global.t('a11y.toast.dismiss'),
    },
  }),
  // The toast host is a direct child of <body>: an open modal must not make it
  // inert. Keyboard focus on a toast (its close button) pauses its timer the way
  // the pointer does: the library listens for mouseenter/mouseleave only.
  onMounted: (component: any) => {
    const host: HTMLElement | undefined = component?.$el
    if (!host?.setAttribute) return
    host.setAttribute('data-a11y-persistent', '')
    const toastOf = (target: EventTarget | null) => (target as Element | null)?.closest?.('.Vue-Toastification__toast')
    host.addEventListener('focusin', (e) => toastOf(e.target)?.dispatchEvent(new MouseEvent('mouseenter')))
    host.addEventListener('focusout', (e) => {
      const toast = toastOf(e.target)
      if (toast && !toast.contains(e.relatedTarget as Node | null)) toast.dispatchEvent(new MouseEvent('mouseleave'))
    })
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

// A chunk or stylesheet of this bundle that no longer exists (a desktop update replaced the
// files under a cached page) reloads the page once per session.
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (sessionStorage.getItem('harmony:preload-reload')) return
    sessionStorage.setItem('harmony:preload-reload', '1')
  } catch {
    return
  }
  event.preventDefault()
  window.location.reload()
})

async function initializeApp() {
  if (isTauriRuntime()) {
    const stale = await reloadIfStaleBundle({
      bundleVersion: getBuildInfo().version,
      nativeVersion: getNativeVersion,
      storage: (() => { try { return sessionStorage } catch { return null } })(),
      reload: (url) => window.location.replace(url),
    })
    if (stale) return
    const clean = withoutStaleParam(window.location.href)
    if (clean) history.replaceState(history.state, '', clean)
  }

  let mounted = false
  const mountApp = () => {
    if (mounted) return
    // The reverse proxy serves the app on /@ paths to a browser with this cookie.
    if (!isTauriRuntime()) {
      const authStore = useAuthStore()
      watch(() => authStore.isLoggedIn, (signedIn) => setAppSessionCookie(signedIn), { immediate: true })
    }
    installOverlayHistory(router, isMobileLayout)
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
      debug.log('Service Worker supported:', swSupported)
      await pwaManager.initialize()
      debug.log('PWA Manager initialized')
      // no auto permission request here: unprompted requests get flagged as spammy
    })()

    const authStore = useAuthStore()
    await Promise.all([
      waitForInitialLocale().then(() => debug.log('Initial locale loaded')),
      swChain.catch((err) => debug.warn('SW/PWA init failed (non-fatal):', err)),
      authStore.initializeAuth().then(() => debug.log('Auth initialized')),
    ])

    // Mount the app AFTER auth
    mountApp()

    if (isTauriRuntime()) {
      import('@/services/instanceCapabilities')
        .then((m) => m.checkInstanceVersion())
        .catch((err) => debug.warn('Instance version check failed:', err))
    }

    // Emoji pack detection probes external pack availability - best-effort
    // and NOT needed for first paint; run it after mount in the background.
    detectAvailablePacks()
      .then(() => debug.log('Emoji packs detected'))
      .catch((err) => debug.warn('Emoji pack detection failed, using builtin packs:', err))

    try {
      reactionCacheManager.startCleanup()
    } catch (err) {
      debug.error('reactionCacheManager.startCleanup failed:', err)
    }
  } catch (error) {
    debug.error('Error initializing app:', error)
    // Still mount the app even if initialization fails (no-op if already mounted)
    mountApp()
  }
}

// The transparent game overlay loads this same bundle at index.html?overlay=1, the floating
// voice dock at index.html?dock=1; each mounts its lightweight app instead of the full client.
const windowRole = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
if (windowRole?.get('overlay') === '1') {
  import('./overlay/mountOverlay').then(m => m.mountOverlay()).catch(err => debug.error('overlay mount failed', err))
} else if (windowRole?.get('dock') === '1') {
  import('./overlay/mountFloatingDock').then(m => m.mountFloatingDock()).catch(err => debug.error('dock mount failed', err))
} else {
  initializeApp()
  import('@/services/nativePresence').then(m => m.initRichPresence()).catch(() => {})
  import('@/services/tauriLinks').then(m => m.installTauriExternalLinks()).catch(() => {})
  import('@/utils/shareTarget').then(m => m.installShareLaunchConsumer(router)).catch(() => {})
  import('@/services/desktopUpdater').then(m => m.initDesktopUpdater()).catch(() => {})
  import('@/utils/videoPoster').then(m => m.installVideoPosters()).catch(() => {})
  import('@/utils/mediaFullscreen').then(m => m.installWindowFullscreenSync()).catch(() => {})
  import('@/utils/iosKeyboard').then(m => m.installIOSKeyboardInset()).catch(() => {})
}
