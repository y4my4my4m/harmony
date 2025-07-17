# Global Presence System Architecture

## Problem Solved

**Issue**: Users starting the app in `/dm` wouldn't appear online in servers until they visited those servers, causing inconsistent presence across the application.

**Root Cause**: Presence subscriptions were component-based instead of globally managed, leading to fragmented presence tracking.

## Solution: Global Presence Initialization

### Core Architecture

The presence system now has **two levels**:

1. **Global Level** (BaseLayout.vue): Subscribes to ALL user contexts on login
2. **Component Level** (UserSidebar, DMHeader, etc.): Smart subscription that checks for existing context

### Implementation Location

**BaseLayout.vue** `initializeApp()` function now includes:

```typescript
// 🎯 CRITICAL: Initialize Global Presence System
try {
  console.log('🌐 Initializing global presence system...')
  
  // Get all servers user is a member of
  const serverIds = serverChannelStore.servers.map(server => server.id)
  
  // Get all DM conversation partners
  const { useDMStore } = await import('@/stores/useDM')
  const dmStore = useDMStore()
  await dmStore.loadConversations()
  const conversationUserIds = dmStore.conversations.map(conv => conv.other_user_id)
  
  // Subscribe to ALL server contexts immediately
  for (const serverId of serverIds) {
    const { getUserIdsForServer } = await import('@/services/usersService')
    const serverUserIds = await getUserIdsForServer(serverId)
    await userData.subscribeToContext(serverId, 'server', serverUserIds)
  }
  
  // Subscribe to ALL DM conversations immediately
  if (conversationUserIds.length > 0) {
    await userData.subscribeToDMPresence(conversationUserIds)
  }
  
  console.log(`📊 Presence tracking: ${serverIds.length} servers, ${conversationUserIds.length} DM partners`)
} catch (error) {
  console.error('❌ Failed to initialize global presence system:', error)
}
```

### Smart Component Subscriptions

Components now check if contexts already exist before subscribing:

**UserSidebar.vue**:
```typescript
const fetchAndSetUsers = async (serverId: string | null) => {
  if (serverId) {
    // Check if context is already subscribed (global presence may have done this)
    const users = getUsersInContext(serverId).value;
    
    if (users.length > 0) {
      console.log(`📋 Server context already initialized: ${serverId} - using existing subscription`);
      return;
    }
    
    // Context not initialized, subscribe to it
    const userIds = await getUserIdsForServer(serverId);
    await subscribeToContext(serverId, 'server', userIds);
  }
};
```

**DMHeader.vue**:
```typescript
const initializePresenceTracking = async () => {
  if (props.conversation.other_user?.id) {
    // Check if user is already tracked by global DM presence
    const userId = props.conversation.other_user.id
    const isUserTracked = isUserOnline(userId).value !== undefined
    
    if (isUserTracked) {
      console.log(`🗨️ DMHeader: User ${userId} already tracked by global DM presence`)
      return
    }
    
    // User not tracked globally, subscribe to profile presence
    profileContextId = await subscribeToProfilePresence(userId)
  }
}
```

## Benefits

### ✅ **Consistent Global Presence**
- User appears online everywhere immediately on login
- No matter which page they start on (`/dm`, `/server`, etc.)
- Real-time presence across all contexts

### ✅ **Efficient Resource Usage**
- Components check for existing subscriptions before creating new ones
- No duplicate presence channels for the same users
- Automatic cleanup on logout

### ✅ **Professional UX**
- Instant presence visibility (like Discord, Slack, Teams)
- No "cold start" presence delays
- Accurate status regardless of navigation path

## Initialization Flow

1. **User logs in** → Auth store triggers BaseLayout initialization
2. **BaseLayout.vue** → Loads all user's servers and DM conversations
3. **Global subscription** → Subscribes to ALL relevant presence contexts
4. **Component smart subscription** → Checks existing contexts before subscribing
5. **Real-time updates** → All components get presence updates immediately

## Testing Scenarios

### Scenario 1: Start in DM
- User opens app directly to `/dm/user123`
- ✅ User appears online in all their servers immediately
- ✅ DM partner sees user as online immediately
- ✅ Server members see user as online immediately

### Scenario 2: Start in Server
- User opens app to `/server/abc123`
- ✅ User appears online in that server AND all other servers
- ✅ DM partners see user as online
- ✅ No duplicate subscriptions when navigating between servers

### Scenario 3: Status Changes
- User changes from Online → Away
- ✅ Status updates in all servers immediately
- ✅ Status updates in all DM conversations immediately
- ✅ Avatar dots update everywhere in real-time

## Architecture Comparison

### Before (Fragmented)
```
/dm → Only DM presence
/server/A → Only Server A presence  
/server/B → Only Server B presence
```
❌ Inconsistent presence across contexts

### After (Global)
```
Login → ALL server + DM presence
/dm → Uses existing global presence
/server/A → Uses existing global presence
/server/B → Uses existing global presence
```
✅ Consistent presence everywhere

## Implementation Complete

The global presence system ensures professional, scalable real-time presence that works consistently regardless of how users navigate the application. Users now appear online everywhere immediately upon login, just like modern chat applications.
