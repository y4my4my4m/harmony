import { createRouter, createWebHistory } from 'vue-router';
import UnifiedView from '@/views/UnifiedView.vue';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
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
      component: UnifiedView,
      props: route => ({
        mode: 'chat',
        serverId: route.params.serverId,
        channelId: route.params.channelId,
        isDM: false
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/dm/:conversationId?',
      name: 'DM',
      component: UnifiedView,
      props: route => ({ 
        mode: 'chat',
        isDM: true, 
        conversationId: route.params.conversationId 
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/dm',
      name: 'DMHome',
      component: UnifiedView,
      props: { 
        mode: 'chat',
        isDM: true 
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/bookmarks',
      name: 'Bookmarks',
      component: UnifiedView,
      props: { 
        mode: 'activitypub',
        viewType: 'bookmarks'
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/notifications',
      name: 'Notifications',
      component: UnifiedView,
      props: { 
        mode: 'activitypub',
        viewType: 'notifications'
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/lists',
      name: 'Lists',
      component: UnifiedView,
      props: { 
        mode: 'activitypub',
        viewType: 'lists'
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/u/:handle',
      name: 'UserProfile',
      component: UnifiedView,
      props: route => ({
        mode: 'activitypub',
        viewType: 'profile',
        profileHandle: route.params.handle
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/social/followers',
      name: 'Followers',
      component: () => import('@/views/FollowersView.vue'),
      props: { viewType: 'followers' },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/following',
      name: 'Following',
      component: () => import('@/views/FollowersView.vue'),
      props: { viewType: 'following' },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/:timeline?',
      name: 'Social',
      component: UnifiedView,
      props: route => ({ 
        mode: 'activitypub',
        timeline: route.params.timeline || 'home'
      }),
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
    // Legacy route redirects for backward compatibility
    {
      path: '/monyverse/:timeline?',
      name: 'Monyverse',
      redirect: route => ({
        name: 'Social',
        params: { timeline: route.params.timeline || 'home' }
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/social/post/:postId',
      name: 'PostDetail',
      component: UnifiedView,
      props: route => ({
        mode: 'activitypub',
        viewType: 'post',
        postId: route.params.postId
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/new-profile',
      name: 'NewProfile',
      component: () => import('@/views/NewProfile.vue'),
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
      path: '/settings/:section?',
      name: 'UserSettings',
      component: () => import('@/views/UserSettings.vue'),
      meta: { requiresAuth: true },
      props: true
    },
    {
      path: '/demo',
      name: 'RichTextDemo',
      component: () => import('@/components/demo/RichTextDemo.vue'),
      meta: { requiresAuth: false }
    },
    {
      path: '/audio-demo',
      name: 'AudioThemeDemo',
      component: () => import('@/components/demo/AudioThemeShowcase.vue'),
      meta: { requiresAuth: false }
    },
  ],
});

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore();
  const isLoggedIn = authStore.isLoggedIn;

  if (to.meta.requiresAuth && !isLoggedIn) {
    next({ name: 'Login' });
  } else if ((to.name === 'Login' || to.name === 'Home') && isLoggedIn) {
    // Default to chat mode when logging in
    next({ name: 'Chat' });
  } else {
    next();
  }
});

export default router;
