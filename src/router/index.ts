import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import InviteAccept from '@/components/InviteAccept.vue';
import { useAuthStore } from '@/stores/auth';
import { 
  ViewMode, 
  ViewType, 
  CurrentView 
} from '@/types/viewTypes';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Home',
      redirect: '/chat'
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
      path: '/invite/:code',
      name: 'InviteAccept',
      component: InviteAccept,
      meta: { requiresAuth: true }
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
    // Chat Layout Routes
    {
      path: '/chat',
      component: () => import('@/layouts/ChatLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'Chat',
          component: () => import('@/views/ChatView.vue'),
          props: route => ({
            isDM: false,
            serverId: route.params.serverId as string,
            channelId: route.params.channelId as string
          })
        },
        {
          path: ':serverId/:channelId',
          name: 'ChatChannel',
          component: () => import('@/views/ChatView.vue'),
          props: route => ({
            isDM: false,
            serverId: route.params.serverId as string,
            channelId: route.params.channelId as string
          })
        }
      ]
    },
    {
      path: '/dm',
      component: () => import('@/layouts/ChatLayout.vue'),
      meta: { requiresAuth: true },
      props: { isDM: true },
      children: [
        {
          path: '',
          name: 'DMHome',
          component: () => import('@/views/DMView.vue'),
          props: { isDM: true }
        },
        {
          path: ':conversationId',
          name: 'DMConversation',
          component: () => import('@/views/DMView.vue'),
          props: route => ({
            isDM: true,
            conversationId: route.params.conversationId as string
          })
        }
      ]
    },
    // Social Layout Routes
    {
      path: '/social',
      component: () => import('@/layouts/SocialLayout.vue'),
      meta: { requiresAuth: true },
      props: route => {
        // Extract props from child route for layout
        const childRoute = route.matched[route.matched.length - 1];
        return childRoute?.props?.default || {};
      },
      children: [
        {
          path: '',
          redirect: '/social/home'
        },
        {
          path: 'home',
          name: 'SocialHome',
          component: () => import('@/views/TimelineView.vue'),
          props: {
            currentView: CurrentView.HOME,
            viewType: ViewType.TIMELINE
          }
        },
        {
          path: 'local',
          name: 'SocialLocal',
          component: () => import('@/views/TimelineView.vue'),
          props: {
            currentView: CurrentView.LOCAL,
            viewType: ViewType.TIMELINE
          }
        },
        {
          path: 'public',
          name: 'SocialPublic',
          component: () => import('@/views/TimelineView.vue'),
          props: {
            currentView: CurrentView.PUBLIC,
            viewType: ViewType.TIMELINE
          }
        },
        {
          path: 'notifications',
          name: 'Notifications',
          component: () => import('@/views/NotificationsView.vue'),
          props: {
            currentView: CurrentView.NOTIFICATIONS,
            viewType: ViewType.NOTIFICATIONS
          }
        },
        {
          path: 'bookmarks',
          name: 'Bookmarks',
          component: () => import('@/views/BookmarksView.vue'),
          props: {
            currentView: CurrentView.BOOKMARKS,
            viewType: ViewType.BOOKMARKS
          }
        },
        {
          path: 'lists',
          name: 'Lists',
          component: () => import('@/views/ListsView.vue'),
          props: {
            currentView: CurrentView.LISTS,
            viewType: ViewType.LISTS
          }
        },
        {
          path: 'followers',
          name: 'Followers',
          component: () => import('@/views/FollowersView.vue'),
          props: { viewType: 'followers' }
        },
        {
          path: 'following',
          name: 'Following',
          component: () => import('@/views/FollowersView.vue'),
          props: { viewType: 'following' }
        },
        {
          path: 'trending',
          name: 'SocialTrending',
          component: () => import('@/views/ExploreView.vue'),
          props: {
            currentView: CurrentView.TRENDING,
            viewType: ViewType.EXPLORE
          }
        },
        {
          path: 'instances',
          name: 'SocialInstances',
          component: () => import('@/views/ExploreView.vue'),
          props: {
            currentView: CurrentView.INSTANCES,
            viewType: ViewType.EXPLORE
          }
        },
        {
          path: 'post/:postId',
          name: 'PostDetail',
          component: () => import('@/views/PostDetailView.vue'),
          props: route => ({
            postId: route.params.postId as string,
            currentView: CurrentView.POST,
            viewType: ViewType.POST
          })
        },
        {
          path: 'conversation/:postId',
          name: 'ConversationThread',
          component: () => import('@/views/ConversationThreadView.vue'),
          props: route => ({
            postId: route.params.postId as string,
            highlightPostId: route.query.highlight as string,
            fromPostId: route.query.from as string,
            contextTimestamp: route.query.t ? parseInt(route.query.t as string) : null
          })
        }
      ]
    },
    // Legacy route redirects
    {
      path: '/social/:timeline',
      name: 'Social',
      redirect: route => {
        const timeline = route.params.timeline as string || 'home';
        return `/social/${timeline}`;
      }
    },
    {
      path: '/explore',
      name: 'Explore',
      redirect: '/social/trending'
    },
    {
      path: '/profile/:handle',
      name: 'UserProfile',
      component: () => import('@/layouts/SocialLayout.vue'),
      props: route => ({
        currentView: CurrentView.PROFILE,
        viewType: ViewType.PROFILE,
        profileHandle: route.params.handle as string
      }),
      children: [
        {
          path: '',
          component: () => import('@/views/UserProfileView.vue'),
          props: route => ({
            profileHandle: route.params.handle as string,
            currentView: CurrentView.PROFILE,
            viewType: ViewType.PROFILE
          })
        }
      ]
    },
    // Settings and Admin (standalone routes)
    {
      path: '/settings/:section?',
      name: 'UserSettings',
      component: () => import('@/views/UserSettings.vue'),
      meta: { requiresAuth: true },
      props: true
    },
    {
      path: '/server/:serverId',
      name: 'ServerSettings',
      component: () => import('@/views/ServerSettings.vue'),
      meta: { requiresAuth: true },
      props: true
    },
    {
      path: '/admin',
      name: 'AdminPanel',
      component: () => import('@/views/AdminPanel.vue'),
      meta: { requiresAuth: true, requiresAdmin: true }
    },
    {
      path: '/new-profile',
      name: 'NewProfile',
      component: () => import('@/views/NewProfile.vue'),
      meta: { requiresAuth: true }
    },
    // Legacy redirects for backward compatibility
    {
      path: '/monyverse/:timeline?',
      name: 'Monyverse',
      redirect: route => ({
        name: 'SocialHome',
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
