import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { useAuthStore } from './stores/auth';
import router from './router'


const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

const authStore = useAuthStore();
authStore.initializeAuth();

app.use(router).mount('#app');