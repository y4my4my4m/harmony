import { createRouter, createWebHistory } from 'vue-router';
import ChatView from '../views/ChatView.vue';
import LoginView from '../views/LoginView.vue';
import { useStore } from '@/stores';

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
      path: '/',
      name: 'Login',
      component: LoginView
    },
    // Other routes...
  ],
});

router.beforeEach((to, from, next) => {
  const store = useStore();
  if (to.meta.requiresAuth && !store.isLoggedIn) {
    next({ name: 'Login' });
  } else {
    next();
  }
});

export default router;
