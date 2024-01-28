// import './assets/reset.css'

import './assets/main.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { useAuthStore } from './stores/auth';
import router from './router'

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

const authStore = useAuthStore();
authStore.initializeAuth();


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

app.use(router).mount('#app');

// src/main.ts or main.js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(registration => {
        console.log('SW registered: ', registration);
      })
      .catch(registrationError => {
        console.log('SW registration failed: ', registrationError);
      });
  });
}
