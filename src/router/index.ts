import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '@/views/LoginView.vue';
import RegisterView from '@/views/RegisterView.vue';
import InviteAccept from '@/components/InviteAccept.vue';
import { useAuthStore } from '@/stores/auth';
import {
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
    // ActivityPub Post Routes (redirect to social layout)
    {
      path: '/posts/:postId',
      name: 'PostView',
      redirect: route => {
        const postId = route.params.postId as string;
        const query = route.query;
        return {
          name: 'PostDetail',
          params: { postId },
          query
        };
      },
      meta: { requiresAuth: true }
    },
    // Social Layout Routes (Updated to use unified PostView)
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
          component: () => import('@/views/PostView.vue'),
          props: route => ({
            postId: route.params.postId as string,
            contextType: (route.query.context as any) || 'thread', // Default to thread
            highlightReply: route.query.highlight as string,
            timestamp: route.query.t ? parseInt(route.query.t as string) : null,
            currentView: CurrentView.POST,
            viewType: ViewType.POST
          })
        },
        {
          path: 'profile/:handle',
          name: 'UserProfile',
          component: () => import('@/views/UserProfileView.vue'),
          props: route => ({
            profileHandle: route.params.handle as string,
            currentView: CurrentView.PROFILE,
            viewType: ViewType.PROFILE
          })
        }
      ]
    },
    // ActivityPub User Profile Routes (handled by nginx, this is just for browser fallback)
    {
      path: '/users/:username',
      name: 'ActivityPubUser',
      redirect: route => {
        // For browser access, redirect to the proper Vue app profile route
        const username = route.params.username as string;
        return `/social/profile/${username}`;
      },
      meta: { requiresAuth: false }
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
    // Profile redirect for backward compatibility
    {
      path: '/profile/:handle',
      redirect: route => {
        const handle = route.params.handle as string;
        return `/social/profile/${handle}`;
      }
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
    // 404 Routes - Authenticated users (with app layout)
    {
      path: '/404',
      name: 'NotFound',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { requiresAuth: true }
    },
    // 404 Routes - Unauthenticated users (auth layout)
    {
      path: '/404-public',
      name: 'NotFoundPublic',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { requiresAuth: false }
    },
    // Catch-all route for undefined routes
    {
      path: '/:pathMatch(.*)*',
      name: 'CatchAll',
      redirect: () => {
        // Determine if user is authenticated
        const authStore = useAuthStore();
        const isLoggedIn = authStore.isLoggedIn;
        
        if (isLoggedIn) {
          return { name: 'NotFound' };
        } else {
          return { name: 'NotFoundPublic' };
        }
      }
    }
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
