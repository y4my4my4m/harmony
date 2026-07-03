import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
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
      component: () => import('@/views/LoginView.vue'),
    },
    {
      path: '/register',
      name: 'Register',
      component: () => import('@/views/RegisterView.vue')
    },
    {
      path: '/reset-password',
      name: 'ResetPassword',
      component: () => import('@/views/ResetPasswordView.vue'),
      meta: { requiresAuth: false }
    },
    {
      path: '/auth/callback',
      name: 'AuthCallback',
      component: () => import('@/views/AuthCallbackView.vue'),
      meta: { requiresAuth: false }
    },
    {
      path: '/logout',
      name: 'Logout',
      component: () => import('@/views/LogoutView.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/invite/:code',
      name: 'InviteAccept',
      component: () => import('@/components/InviteAccept.vue'),
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
        },
        {
          path: ':serverId/thread/:threadId',
          name: 'ThreadView',
          component: () => import('@/views/ThreadFullView.vue'),
          props: route => ({
            serverId: route.params.serverId as string,
            threadId: route.params.threadId as string
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
    // ActivityPub Post Routes (direct access for external sharing)
    // This route is for direct post URLs (ActivityPub standard)
    // Uses SocialLayout to maintain consistent UI with /social/post/:postId
    {
      path: '/posts/:postId',
      component: () => import('@/layouts/SocialLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          name: 'DirectPost',
          component: () => import('@/views/PostView.vue'),
          props: route => ({
            postId: route.params.postId as string,
            contextType: 'thread',
            highlightReply: route.query.highlight as string,
            timestamp: route.query.t ? parseInt(route.query.t as string) : null,
            currentView: CurrentView.POST,
            viewType: ViewType.POST
          })
        }
      ]
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
          path: 'mentions',
          name: 'Mentions',
          component: () => import('@/views/MentionsView.vue'),
          props: {
            currentView: CurrentView.MENTIONS,
            viewType: ViewType.MENTIONS
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
          path: 'lists/:listId',
          name: 'ListDetail',
          component: () => import('@/views/ListDetailView.vue'),
          props: true
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
          path: 'posts/:handle/:noteId',
          name: 'RemotePostDetail',
          beforeEnter: async (to) => {
            const handle = to.params.handle as string
            const noteId = to.params.noteId as string
            const { postResolverService } = await import('@/services/PostResolverService')
            const post = await postResolverService.resolveByHandle(handle, noteId)
            if (post?.id) {
              return {
                name: 'PostDetail',
                params: { postId: post.id },
                query: to.query,
                replace: true,
              }
            }
            // Fallback: load PostView with remote params (shows error state)
            return true
          },
          component: () => import('@/views/PostView.vue'),
          props: route => ({
            remoteHandle: route.params.handle as string,
            remoteNoteId: route.params.noteId as string,
            contextType: (route.query.context as any) || 'thread',
            highlightReply: route.query.highlight as string,
            timestamp: route.query.t ? parseInt(route.query.t as string) : null,
            currentView: CurrentView.POST,
            viewType: ViewType.POST
          })
        },
        {
          path: 'post/:postId',
          name: 'PostDetail',
          component: () => import('@/views/PostView.vue'),
          props: route => ({
            postId: route.params.postId as string,
            contextType: (route.query.context as any) || 'thread',
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
        },
        {
          path: 'hashtag/:tag',
          name: 'HashtagView',
          component: () => import('@/views/HashtagView.vue'),
          props: route => ({
            hashtag: route.params.tag as string,
            currentView: CurrentView.HASHTAG,
            viewType: ViewType.HASHTAG
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
    // "Today" dashboard (beta, gated by a per-user setting)
    {
      path: '/today',
      name: 'Today',
      component: () => import('@/views/TodayView.vue'),
      meta: { requiresAuth: true },
      beforeEnter: async () => {
        const { useTodayDashboard } = await import('@/composables/useTodayDashboard')
        const { todayDashboardEnabled } = useTodayDashboard()
        return todayDashboardEnabled.value ? true : { path: '/' }
      }
    },
    {
      path: '/new-profile',
      name: 'NewProfile',
      component: () => import('@/views/NewProfile.vue'),
      meta: { requiresAuth: true }
    },
    // Redirect legacy paths
    {
      path: '/notifications',
      redirect: '/social/mentions'
    },
    {
      path: '/social/notifications',
      redirect: '/social/mentions'
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

const PROFILE_EXEMPT_ROUTES = new Set([
  'NewProfile', 'Login', 'Register', 'Home', 'ResetPassword',
  'AuthCallback', 'NotFoundPublic', 'NotFound', 'CatchAll'
])

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore();
  const isLoggedIn = authStore.isLoggedIn;

  if (authStore.isPasswordResetMode && to.name !== 'ResetPassword' && to.name !== 'Login') {
    next({ name: 'ResetPassword' });
    return;
  }

  if (to.meta.requiresAuth && !isLoggedIn) {
    next({ name: 'Login' });
    return;
  }

  if (to.meta.requiresAdmin && isLoggedIn) {
    const profileStore = useProfileStore();
    if (!profileStore.profileFetched) {
      const authStore2 = useAuthStore();
      // BUGS.md Pattern A: there is no `authStore.user` - the auth store
      // exposes `session.user`. Reading `authStore2.user?.id` always
      // produced `undefined`, so the profile fetch was skipped and the
      // admin gate fell back to a (possibly stale) `profileStore.profile`
      // from a prior session.
      const authUserId = authStore2.session?.user?.id;
      if (authUserId) {
        await profileStore.fetchProfileByAuthUserId(authUserId);
      }
    }
    if (!profileStore.profile?.is_admin) {
      next({ name: 'Chat' });
      return;
    }
  }

  if (isLoggedIn && !PROFILE_EXEMPT_ROUTES.has(to.name as string)) {
    const profileStore = useProfileStore();
    if (profileStore.profileFetched && (!profileStore.profile || !profileStore.profile.username)) {
      next({ name: 'NewProfile' });
      return;
    }
  }

  if ((to.name === 'Login' || to.name === 'Home') && isLoggedIn) {
    next({ name: 'Chat' });
  } else {
    next();
  }
});

export default router;
