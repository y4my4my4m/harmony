import { createRouter, createWebHistory } from 'vue-router';
import UnifiedView from '@/views/UnifiedView.vue';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import InviteAccept from '@/components/InviteAccept.vue';
import { useAuthStore } from '@/stores/auth';
import { 
  ViewMode, 
  ViewType, 
  CurrentView, 
  createTimelineView,
  createExploreView,
  createProfileView,
  createPostView,
  createChatView,
  createDMView
} from '@/types/viewTypes';

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
        mode: ViewMode.CHAT,
        viewType: ViewType.CHAT,
        currentView: CurrentView.CHAT,
        serverId: route.params.serverId as string,
        channelId: route.params.channelId as string,
        isDM: false
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/dm/:conversationId?',
      name: 'DM',
      component: UnifiedView,
      props: route => ({ 
        mode: ViewMode.CHAT,
        viewType: ViewType.DM,
        currentView: CurrentView.DM,
        isDM: true, 
        conversationId: route.params.conversationId as string
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/dm',
      name: 'DMHome',
      component: UnifiedView,
      props: { 
        mode: ViewMode.CHAT,
        viewType: ViewType.DM,
        currentView: CurrentView.DM,
        isDM: true 
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/bookmarks',
      name: 'Bookmarks',
      component: UnifiedView,
      props: { 
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.BOOKMARKS,
        currentView: CurrentView.BOOKMARKS
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/notifications',
      name: 'Notifications',
      component: UnifiedView,
      props: { 
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.NOTIFICATIONS,
        currentView: CurrentView.NOTIFICATIONS
      },
      meta: { requiresAuth: true },
    },
    {
      path: '/social/lists',
      name: 'Lists',
      component: UnifiedView,
      props: { 
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.LISTS,
        currentView: CurrentView.LISTS
      },
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
      path: '/social/post/:postId',
      name: 'PostDetail',
      component: UnifiedView,
      props: route => ({
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.POST,
        currentView: CurrentView.POST,
        postId: route.params.postId as string
      }),
      meta: { requiresAuth: true },
    },
    {
      path: '/social/conversation/:postId',
      name: 'ConversationThread',
      component: () => import('@/views/ConversationThreadView.vue'),
      props: route => ({
        postId: route.params.postId as string,
        highlightPostId: route.query.highlight as string,
        fromPostId: route.query.from as string,
        contextTimestamp: route.query.t ? parseInt(route.query.t as string) : null
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
    {
      path: '/admin',
      name: 'AdminPanel',
      component: () => import('@/views/AdminPanel.vue'),
      meta: { requiresAuth: true, requiresAdmin: true }
    },
    // ActivityPub / Social Routes (specific routes first!)
    {
      path: '/social/trending',
      name: 'SocialTrending',
      component: () => import('@/views/UnifiedView.vue'),
      props: {
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.EXPLORE,
        currentView: CurrentView.TRENDING
      },
      meta: { requiresAuth: true }
    },
    {
      path: '/social/instances',
      name: 'SocialInstances',
      component: () => import('@/views/UnifiedView.vue'),
      props: {
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.EXPLORE,
        currentView: CurrentView.INSTANCES
      },
      meta: { requiresAuth: true }
    },
    {
      path: '/social/:timeline?',
      name: 'Social',
      component: () => import('@/views/UnifiedView.vue'),
      props: (route) => {
        const timeline = route.params.timeline as string || 'home';
        const currentView = timeline === 'home' ? CurrentView.HOME 
          : timeline === 'local' ? CurrentView.LOCAL 
          : timeline === 'public' ? CurrentView.PUBLIC 
          : CurrentView.HOME;
        
        return {
          mode: ViewMode.ACTIVITYPUB,
          viewType: ViewType.TIMELINE,
          currentView,
          timeline // Legacy support
        };
      }
    },
    {
      path: '/explore',
      name: 'Explore',
      component: () => import('@/views/UnifiedView.vue'),
      props: {
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.EXPLORE,
        currentView: CurrentView.TRENDING // Default to trending in explore
      }
    },
    {
      path: '/profile/:handle',
      name: 'UserProfile',
      component: () => import('@/views/UnifiedView.vue'),
      props: (route) => ({
        mode: ViewMode.ACTIVITYPUB,
        viewType: ViewType.PROFILE,
        currentView: CurrentView.PROFILE,
        profileHandle: route.params.handle as string
      })
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
