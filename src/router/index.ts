import { createRouter, createWebHistory } from 'vue-router';
import ChatView from '@/views/ChatView.vue';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import ProfileComponent from '@/components/ProfileComponent.vue';
import InviteAccept from '@/components/InviteAccept.vue';
import { useAuthStore } from '@/stores/auth';
import ServerSettings from '@/views/ServerSettings.vue';

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
      path: '/register',
      name: 'Register',
      component: RegisterView
    },
    {
      path: '/profile',
      name: 'Profile',
      component: ProfileComponent,
      meta: { requiresAuth: true }
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
      component: ServerSettings,
      meta: { requiresAuth: true },
      props: true
    },
  ],
});

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore();
  if (to.meta.requiresAuth && !authStore.isLoggedIn) {
    console.log("Redirecting to Login, isLoggedIn:", authStore.isLoggedIn);
    next({ name: 'Login' });
  }
  // if on login page and logged in, redirect to chat
  else if ((to.name === 'Login' || to.name === 'Home') && authStore.isLoggedIn) {
    console.log("Redirecting to Chat, isLoggedIn:", authStore.isLoggedIn);
    next({ name: 'Chat' });
  }
  else {
    console.log("Proceeding to route, isLoggedIn:", authStore.isLoggedIn);
    next();
  }
});

export default router;
