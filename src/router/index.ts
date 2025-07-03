import { createRouter, createWebHistory } from 'vue-router';
import ChatView from '@/views/ChatView.vue';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import NewProfile from '@/views/NewProfile.vue';
import InviteAccept from '@/components/InviteAccept.vue';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Home',
      component: LoginView,
      meta: { requiresAuth: true }
    },
    {
      path: '/chat/:serverId?/:channelId?',
      name: 'Chat',
      component: ChatView,
      props: true,
      meta: { requiresAuth: true },
    },
    {
      path: '/login',
      name: 'Login',
      component: LoginView,
    },
    {
      path: '/register',
      name: 'Register',
      component: RegisterView
    },
    {
      path: '/new-profile',
      name: 'NewProfile',
      component: NewProfile,
      meta: { requiresAuth: true },
    },
    {
      path: '/invite/:code',
      name: 'InviteAccept',
      component: InviteAccept,
      meta: { requiresAuth: true }
    },
    {
      path: '/server/:serverId',
      name: 'ServerSettings',
      component: () => import('@/views/ServerSettings.vue'),
      meta: { requiresAuth: true },
      props: true
    },
    {
      path: '/settings',
      name: 'UserSettings',
      component: () => import('@/views/UserSettings.vue'),
      meta: { requiresAuth: true }
    },
  ],
});

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore();
  const isLoggedIn = authStore.isLoggedIn;

  if (to.meta.requiresAuth && !isLoggedIn) {
    next({ name: 'Login' });
  } else if ((to.name === 'Login' || to.name === 'Home') && isLoggedIn) {
    next({ name: 'Chat' });
  } else {
    next();
  }
});

export default router;
