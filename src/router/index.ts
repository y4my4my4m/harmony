import { createRouter, createWebHistory } from 'vue-router';
import ChatView from '../views/ChatView.vue';
import LoginView from '../views/LoginView.vue';
import RegisterView from '../views/RegisterView.vue';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/chat',
      name: 'Chat',
      component: ChatView,
      meta: { requiresAuth: true }
    },
    {
      path: '/login',
      name: 'Login',
      component: LoginView,
    },
    {
      path: '/',
      name: 'Register',
      component: RegisterView
    }
  ],
});

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore();

  if (to.meta.requiresAuth && !authStore.isLoggedIn) {
    console.log("Redirecting to Login, isLoggedIn:", authStore.isLoggedIn);
    next({ name: 'Login' });
  } else {
    console.log("Proceeding to route, isLoggedIn:", authStore.isLoggedIn);
    next();
  }
});

export default router;
