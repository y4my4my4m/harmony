# Loading Performance Analysis

## Current Issue
When accessing a direct chat URL (`/chat/{serverId}/{channelId}`), the application is loading **everything** instead of just what's needed for that specific page. This creates unnecessary network requests, database queries, and initialization overhead.

## Console Output Analysis

### ✅ NECESSARY (Keep These)
1. **PWA Manager** - Essential for app functionality
2. **Auth Context** - Required for any authenticated page
3. **Service Worker** - Important for offline/caching
4. **Theme Store** - Needed for UI rendering
5. **Current Server/Channel resolution** - Required for the specific page being accessed
6. **Messages for current channel** - The actual content being viewed
7. **Reactions for current channel** - Part of the message display

### ❌ UNNECESSARY (Should be lazy-loaded)

#### 1. All DM Conversations Loading
```
🔄 Fetching user conversations via service-like method: 2d06f6ba-4c21-4c84-a963-db65148ac543
✅ Processed 9 conversations via service-like method
🔄 Setting up DM realtime subscriptions for user: 2d06f6ba-4c21-4c84-a963-db65148ac543
```
**WHY REMOVE:** User is viewing a server channel, not DMs. DMs should **NEVER** load unless:
- User directly navigates to a DM URL (`/dm/{conversationId}`)
- User clicks on the DM section in the sidebar

Even then, we should only load:
- **DM list metadata** (conversation names, last message timestamp, unread counts)
- **NOT** the actual message content until a specific DM is opened

#### 2. All Server Presence Systems (Receiving + Broadcasting)
```
🔄 Subscribing to server context: 9895ae8a-b25a-475b-b2f1-3bd3e2dffeab (10 users)
🔄 Subscribing to server context: 1803806b-eb5b-4c55-996d-c8670d3269a8 (2 users)
🔄 Subscribing to server context: 6acd38e6-5939-41ab-bc60-255cdf4cf97a (1 users)
🔄 Subscribing to server context: cb3fe7c9-b449-4c57-92d7-f2de10b727ed (1 users)
```
**WHY OPTIMIZE (Not completely remove):** 
- **Receiving presence:** Only subscribe to **current server** presence data (what we see)
- **Broadcasting presence:** Must broadcast our status to **all servers** we're in (what others see)
- **Solution:** Separate "lightweight broadcast" from "full presence subscription"
  - Broadcast our online status to all servers (minimal overhead)
  - Only receive detailed presence data from current server

#### 3. All Server Emoji Caches
```
📦 Cached 20 emojis for server: Harmony's Town Square
📦 Cached 48 emojis for server: Ragnarok Online
📦 Cached 32 emojis for server: Normie Central
📦 Cached 2 emojis for server: artsy
```
**WHY REMOVE:** Only current server emojis needed. Others should load when:
- User switches servers
- User starts typing (for emoji autocomplete across servers)

#### 4. Global Notification System on Page Load
```
🔔 Initializing notification system for user: 2d06f6ba-4c21-4c84-a963-db65148ac543
🔄 Fetching notifications via NotificationService: 2d06f6ba-4c21-4c84-a963-db65148ac543
✅ Fetched 50 notifications
```
**WHY REMOVE:** Notifications should be:
- Background loaded after critical UI renders
- Only fetch unread count initially
- Full notification list when user opens notification panel

#### 5. All Server User Lists
```
🔄 Loading user data for 8 users
🔄 Loading user data for 2 users
🔄 Loading user data for 9 users (DM users)
```
**WHY REMOVE:** Only current server users needed. Others load on-demand.

#### 6. Double Auth Context Resolution
```
🔄 Auth state changed: SIGNED_IN
🧹 Auth context cache cleared
🔄 Auth state changed: INITIAL_SESSION
🧹 Auth context cache cleared
```
**WHY REMOVE:** This suggests the auth system is firing twice. Should be optimized to resolve once.

## Proposed Loading Strategy

### Phase 1: Critical Path (First 100ms)
1. ✅ Auth context resolution
2. ✅ Theme loading
3. ✅ Current server/channel resolution
4. ✅ Basic UI framework

### Phase 2: Content Loading (100-300ms)
1. ✅ Current channel messages
2. ✅ Current server user list (for sidebar)
3. ✅ Current server emojis
4. ✅ Current server presence

### Phase 3: Background Loading (After UI is interactive)
1. 🔄 Notification count (not full list)
2. 🔄 Other servers' metadata (names, unread counts)
3. 🔄 Service worker cache warming

### Phase 4: On-Demand Loading (Only when specifically accessed)
1. 🔄 DM conversation list (when user clicks DM section - only metadata)
2. 🔄 DM conversation content (when user opens specific DM)
3. 🔄 Other servers' presence (when switching servers)
4. 🔄 Full notification list (when notification panel opened)
5. 🔄 Other servers' emojis (when switching servers)

## Route-Specific Loading Strategy

### When accessing `/chat/{serverId}/{channelId}`:
- ✅ Load current server + channel data
- ❌ Don't load ANY DM data
- ❌ Don't load other servers' data

### When accessing `/dm/{conversationId}`:
- ✅ Load that specific DM conversation messages
- ✅ Load DM sidebar list (metadata only: names, unread counts, last message preview)
- ✅ Load participants' user data for that conversation
- ❌ Don't load server data unless user is also in servers
- ❌ Don't load other DM conversations' message content

### When accessing `/dm` (DM section without specific conversation):
- ✅ Load DM sidebar list (metadata only)
- ❌ Don't load any conversation message content until user clicks one
- ❌ Don't load server data

### When accessing `/` (homepage/default):
- ✅ Route to last visited location (server channel or DM)
- ✅ Load only what's needed for that specific route

## Implementation Plan

### 1. Fix AuthContextService Double Resolution
- **File:** `AuthContextService.ts`
- **Issue:** Auth state changing twice on load
- **Fix:** Debounce auth state changes or optimize initial session detection

### 2. Make DM System Route-Based
- **File:** `useDM.ts`, `BaseLayout.vue`, router
- **Change:** Initialize DM system based on current route
- **Route-based loading:**
  - `/chat/{serverId}/{channelId}` → **NO** DM loading
  - `/dm/{conversationId}` → Load **that specific** DM conversation + DM sidebar list
  - `/dm` or DM sidebar click → Load **only** DM list metadata (no message content)

### 3. Make Server Presence Smart (Broadcast vs Receive)
- **File:** `userDataService.ts`, `BaseLayout.vue`
- **Change:** Separate lightweight broadcasting from full presence subscription
- **Implementation:**
  - **Broadcast presence:** Send our status to all servers we're in (lightweight) (make sure its working for ppl watching our profile or in DMs were with)
  - **Receive presence:** Only subscribe to current server's detailed presence data
  - **On server switch:** Subscribe to new server's presence, unsubscribe from old

### 4. Make Emoji Cache Selective
- **File:** `useEmojiCache.ts`
- **Change:** Only load current server emojis initially
- **Trigger:** Load others when switching servers or typing

### 5. Make Notifications Background
- **File:** `useNotification.ts`
- **Change:** Only fetch unread count initially
- **Trigger:** Full list when notification panel opened

### 6. Optimize User Data Loading
- **File:** `userDataService.ts`
- **Change:** Don't load all users from all servers
- **Trigger:** Load users per-server as needed

## Expected Performance Gains

### Current State
- **Initial requests:** ~15-20 database queries
- **Data loaded:** All servers, all DMs, all users, all emojis
- **Time to interactive:** 2-3 seconds
- **Memory usage:** High (everything loaded)

### Optimized State
- **Initial requests:** ~5-7 database queries
- **Data loaded:** Only current server/channel
- **Time to interactive:** 500ms-1s
- **Memory usage:** Low (lazy loading)

## Critical Path Focus

The user clicked on a specific channel URL. They want to see:
1. ✅ The channel messages
2. ✅ Who's online in this server
3. ✅ Server navigation (current server)

They DON'T immediately need:
1. ❌ DM conversations
2. ❌ Other servers' data
3. ❌ Full notification history
4. ❌ All emojis from all servers

## Error to Fix

```
GET http://localhost:8000/rest/v1/profiles?select=...&id=in.%28undefined,undefined,undefined...%29 400 (Bad Request)
```

This suggests the user data service is trying to load profiles with undefined IDs, likely from the DM conversation processing that shouldn't even be running.

## Conclusion

The current loading strategy is "load everything upfront" which is terrible for performance. We need to shift to "load what's needed, when it's needed" with a clear critical path for the initial page load.

The biggest wins will be:
1. Remove DM loading from initial page load
2. Only load current server data
3. Background/lazy load everything else
4. Fix the double auth resolution
