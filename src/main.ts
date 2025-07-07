// import './assets/reset.css'

import './assets/main.css'
import './assets/shared.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { serviceWorkerManager } from '@/services/ServiceWorkerManager'
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

async function initializeApp() {
  try {
    // Initialize auth store first to check for existing sessions
    const authStore = useAuthStore()
    await authStore.initializeAuth()
    console.log('✅ Auth initialized')
    
    // Register service worker for enhanced notification handling
    const swSupported = await serviceWorkerManager.initialize()
    console.log('🔔 Service Worker supported:', swSupported)
    
    // Request notification permission if supported
    if (swSupported) {
      await serviceWorkerManager.requestNotificationPermission()
    }
    
    // Start reaction cache management
    reactionCacheManager.startCleanup()
    console.log('🎯 Reaction cache manager started')
  } catch (error) {
    console.error('❌ Error initializing service worker:', error)
  }
  
  // Mount the app
  app.use(router).mount('#app')
}

// Initialize the application
initializeApp()
