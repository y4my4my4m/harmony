/**
 * Professional View State Management Types
 * Centralized type definitions for clean architecture
 */

// Core Mode Enumeration
export enum ViewMode {
  CHAT = 'chat',
  ACTIVITYPUB = 'activitypub'
}

// View Type Enumeration - Defines the general category of view
export enum ViewType {
  TIMELINE = 'timeline',      // Timeline feeds (home, local, public)
  EXPLORE = 'explore',        // Explore content (trending, instances)
  PROFILE = 'profile',        // User profile view
  POST = 'post',             // Single post detail view
  HASHTAG = 'hashtag',       // Hashtag posts view
  BOOKMARKS = 'bookmarks',   // User bookmarks
  MENTIONS = 'mentions',           // Posts mentioning the user
  LISTS = 'lists',           // User lists
  DM = 'dm',                 // Direct messages
  CHAT = 'chat'              // Server chat channels
}

// Current View Enumeration - Defines the specific view within a type
export enum CurrentView {
  // Timeline views
  HOME = 'home',
  LOCAL = 'local', 
  PUBLIC = 'public',
  
  // Explore views
  TRENDING = 'trending',
  INSTANCES = 'instances',
  
  // Generic views
  PROFILE = 'profile',
  POST = 'post',
  HASHTAG = 'hashtag',
  BOOKMARKS = 'bookmarks',
  MENTIONS = 'mentions',
  LISTS = 'lists',
  DM = 'dm',
  CHAT = 'chat'
}

// View State Interface - Complete view state representation
export interface ViewState {
  mode: ViewMode;
  viewType: ViewType;
  currentView: CurrentView;
  
  // Optional contextual data
  serverId?: string;
  channelId?: string;
  conversationId?: string;
  profileHandle?: string;
  postId?: string;
  isDM?: boolean;
}

// Router Props Interface - Props passed from router to components
export interface RouterViewProps {
  mode: ViewMode;
  viewType?: ViewType;
  currentView?: CurrentView;
  timeline?: string; // Legacy support
  
  // Context-specific props
  serverId?: string;
  channelId?: string;
  conversationId?: string;
  profileHandle?: string;
  postId?: string;
  isDM?: boolean;
}

// View Configuration Interface - Defines view capabilities and metadata
export interface ViewConfig {
  mode: ViewMode;
  viewType: ViewType;
  currentView: CurrentView;
  
  // Metadata
  title: string;
  icon: string;
  path: string;
  requiresAuth: boolean;
  
  // Capabilities
  hasTimeline?: boolean;
  hasComposer?: boolean;
  hasSearch?: boolean;
  hasProfile?: boolean;
}

/**
 * View State Factory Functions
 * Clean constructors for common view states
 */

export const createTimelineView = (timeline: CurrentView.HOME | CurrentView.LOCAL | CurrentView.PUBLIC): ViewState => ({
  mode: ViewMode.ACTIVITYPUB,
  viewType: ViewType.TIMELINE,
  currentView: timeline
});

export const createExploreView = (explore: CurrentView.TRENDING | CurrentView.INSTANCES): ViewState => ({
  mode: ViewMode.ACTIVITYPUB,
  viewType: ViewType.EXPLORE,
  currentView: explore
});

export const createProfileView = (profileHandle: string): ViewState => ({
  mode: ViewMode.ACTIVITYPUB,
  viewType: ViewType.PROFILE,
  currentView: CurrentView.PROFILE,
  profileHandle
});

export const createPostView = (postId: string): ViewState => ({
  mode: ViewMode.ACTIVITYPUB,
  viewType: ViewType.POST,
  currentView: CurrentView.POST,
  postId
});

export const createChatView = (serverId?: string, channelId?: string): ViewState => ({
  mode: ViewMode.CHAT,
  viewType: ViewType.CHAT,
  currentView: CurrentView.CHAT,
  serverId,
  channelId
});

export const createDMView = (conversationId?: string): ViewState => ({
  mode: ViewMode.CHAT,
  viewType: ViewType.DM,
  currentView: CurrentView.DM,
  conversationId,
  isDM: true
});

/**
 * View State Utilities
 * Helper functions for working with view states
 */

export const isTimelineView = (state: ViewState): boolean => 
  state.viewType === ViewType.TIMELINE;

export const isExploreView = (state: ViewState): boolean => 
  state.viewType === ViewType.EXPLORE;

export const isChatMode = (state: ViewState): boolean => 
  state.mode === ViewMode.CHAT;

export const isActivityPubMode = (state: ViewState): boolean => 
  state.mode === ViewMode.ACTIVITYPUB;

export const getViewPath = (state: ViewState): string => {
  switch (state.viewType) {
    case ViewType.TIMELINE:
      return `/social/${state.currentView}`;
    case ViewType.EXPLORE:
      return `/social/${state.currentView}`;
    case ViewType.PROFILE:
      return `/profile/${state.profileHandle}`;
    case ViewType.POST:
      return `/social/post/${state.postId}`;
    case ViewType.BOOKMARKS:
      return '/social/bookmarks';
    case ViewType.MENTIONS:
      return '/social/mentions';
    case ViewType.LISTS:
      return '/social/lists';
    case ViewType.CHAT:
      return state.serverId && state.channelId 
        ? `/chat/${state.serverId}/${state.channelId}` 
        : '/chat';
    case ViewType.DM:
      return state.conversationId 
        ? `/dm/${state.conversationId}` 
        : '/dm';
    default:
      return '/social/home';
  }
};

/**
 * Route Utilities
 * Helper functions for working with routes and view modes
 */

export const getViewModeFromRoute = (routeName: string | null | undefined): ViewMode => {
  if (!routeName) return ViewMode.CHAT;
  
  // ActivityPub routes - updated to match actual router route names
  const activityPubRoutes = [
    'Social', 'Fediverse', 'Explore', // Legacy routes
    'SocialHome', 'SocialLocal', 'SocialPublic', // Timeline routes
    'UserProfile', 'Followers', 'Following', // Profile routes
    'Lists', 'Mentions', 'Bookmarks', // Social feature routes
    'SocialTrending', 'SocialInstances', // Explore routes
    'PostView', 'PostDetail', 'RemotePostDetail', 'DirectPost', 'ConversationThread' // Post routes
  ];
  
  return activityPubRoutes.includes(routeName) ? ViewMode.ACTIVITYPUB : ViewMode.CHAT;
};

export const isActivityPubRoute = (routeName: string | null | undefined): boolean => {
  return getViewModeFromRoute(routeName) === ViewMode.ACTIVITYPUB;
};

/**
 * View Configuration Registry
 * Centralized view definitions
 */

export const VIEW_CONFIGS: Record<string, ViewConfig> = {
  'timeline-home': {
    mode: ViewMode.ACTIVITYPUB,
    viewType: ViewType.TIMELINE,
    currentView: CurrentView.HOME,
    title: 'Home',
    icon: 'home',
    path: '/social/home',
    requiresAuth: true,
    hasTimeline: true,
    hasComposer: true,
    hasSearch: true
  },
  'timeline-local': {
    mode: ViewMode.ACTIVITYPUB,
    viewType: ViewType.TIMELINE,
    currentView: CurrentView.LOCAL,
    title: 'Local',
    icon: 'users',
    path: '/social/local',
    requiresAuth: true,
    hasTimeline: true,
    hasSearch: true
  },
  'timeline-public': {
    mode: ViewMode.ACTIVITYPUB,
    viewType: ViewType.TIMELINE,
    currentView: CurrentView.PUBLIC,
    title: 'Federated',
    icon: 'globe',
    path: '/social/public',
    requiresAuth: true,
    hasTimeline: true,
    hasSearch: true
  },
  'explore-trending': {
    mode: ViewMode.ACTIVITYPUB,
    viewType: ViewType.EXPLORE,
    currentView: CurrentView.TRENDING,
    title: 'Trending',
    icon: 'trending-up',
    path: '/social/trending',
    requiresAuth: true,
    hasSearch: true
  },
  'explore-instances': {
    mode: ViewMode.ACTIVITYPUB,
    viewType: ViewType.EXPLORE,
    currentView: CurrentView.INSTANCES,
    title: 'Instances',
    icon: 'server',
    path: '/social/instances',
    requiresAuth: true,
    hasSearch: true
  }
}; 