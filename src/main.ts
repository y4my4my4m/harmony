import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { useAuthStore } from './stores/auth';
import router from './router'

import Toast from 'vue-toastification';
import "vue-toastification/dist/index.css";

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
await authStore.initializeAuth();
app.directive('scroll-bottom', {
    updated(el) {
      el.scrollTop = el.scrollHeight;
    },
  });
  
app.directive('click-outside', ClickOutsideDirective);

app.use(router).mount('#app');