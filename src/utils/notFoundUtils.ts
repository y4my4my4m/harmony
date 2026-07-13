import type { RouteLocationNormalized } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

export interface NotFoundContext {
  isAuthenticated: boolean
  suggestedRoute: string
  layoutType: 'auth' | 'base' | 'social' | 'chat'
  previousRoute?: RouteLocationNormalized
}

export function getNotFoundContext(
  currentRoute: RouteLocationNormalized,
  previousRoute?: RouteLocationNormalized
): NotFoundContext {
  const authStore = useAuthStore()
  const isAuthenticated = authStore.isLoggedIn

  let suggestedRoute = isAuthenticated ? '/chat' : '/login'
  let layoutType: NotFoundContext['layoutType'] = isAuthenticated ? 'base' : 'auth'

  if (isAuthenticated && currentRoute.path) {
    if (currentRoute.path.startsWith('/social/')) {
      suggestedRoute = '/social/home'
      layoutType = 'social'
    }
    else if (currentRoute.path.startsWith('/chat/') || currentRoute.path.startsWith('/dm/')) {
      suggestedRoute = '/chat'
      layoutType = 'chat'
    }
    else if (currentRoute.path.startsWith('/settings/') || currentRoute.path.startsWith('/admin')) {
      suggestedRoute = '/settings/account'
      layoutType = 'base'
    }
    // Default to most recent context if we have previous route info
    else if (previousRoute?.path) {
      if (previousRoute.path.startsWith('/social/')) {
        suggestedRoute = '/social/home'
        layoutType = 'social'
      } else if (previousRoute.path.startsWith('/chat/') || previousRoute.path.startsWith('/dm/')) {
        suggestedRoute = '/chat'
        layoutType = 'chat'
      }
    }
  }

  return {
    isAuthenticated,
    suggestedRoute,
    layoutType,
    previousRoute
  }
}

export function getQuickNavigationLinks(context: NotFoundContext) {
  if (!context.isAuthenticated) {
    return [
      { to: '/login', label: 'Login', icon: 'log-in' },
      { to: '/register', label: 'Register', icon: 'user-plus' }
    ]
  }

  const baseLinks = [
    { to: '/chat', label: 'Chat', icon: 'message-circle' },
    { to: '/social/home', label: 'Social', icon: 'users' },
    { to: '/dm', label: 'Messages', icon: 'mail' },
    { to: '/social/mentions', label: 'Mentions', icon: 'at-sign' }
  ]

  // Filter out the current suggested route to avoid redundancy
  return baseLinks.filter(link => link.to !== context.suggestedRoute)
}

export function getContextualErrorMessage(route: RouteLocationNormalized): {
  title: string
  description: string
} {
  const path = route.path.toLowerCase()

  if (path.includes('/user/') || path.includes('/profile/')) {
    return {
      title: 'User not found',
      description: 'The user profile you\'re looking for doesn\'t exist or has been removed.'
    }
  }

  if (path.includes('/post/') || path.includes('/status/')) {
    return {
      title: 'Post not found',
      description: 'This post might have been deleted or you don\'t have permission to view it.'
    }
  }

  if (path.includes('/server/') || path.includes('/chat/')) {
    return {
      title: 'Server or channel not found',
      description: 'The server or channel you\'re trying to access doesn\'t exist or you don\'t have access.'
    }
  }

  if (path.includes('/dm/') || path.includes('/message/')) {
    return {
      title: 'Conversation not found',
      description: 'This conversation doesn\'t exist or you don\'t have permission to view it.'
    }
  }

  if (path.includes('/settings/') || path.includes('/admin/')) {
    return {
      title: 'Settings page not found',
      description: 'The settings page you\'re looking for doesn\'t exist.'
    }
  }

  return {
    title: 'Page not found',
    description: 'The page you\'re looking for doesn\'t exist or has been moved.'
  }
}
