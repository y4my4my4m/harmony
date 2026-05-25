# Performance

## Build Optimization

### Code Splitting

Vite automatically splits the bundle into chunks:

| Chunk | Contents |
|-------|----------|
| `vue-vendor` | Vue, Pinia, Vue Router |
| `supabase-vendor` | Supabase client libraries |
| `crypto-vendor` | Encryption libraries (Signal Protocol, etc.) |
| `view-*` | Per-route view chunks (lazy loaded) |
| `editor` | Rich text editor |
| `message` | Message rendering |

Route-based chunks are lazy-loaded -- only the current view's code is downloaded on navigation.

### Selective Preloading

The `selectivePreload` Vite plugin controls which chunks are preloaded. Critical path chunks are preloaded; route-specific chunks load on demand.

### Build Targets

- Chrome 105 on Windows (Tauri uses WebView2)
- Safari 16 on other platforms

## Runtime Performance

### Virtual Scrolling

`MessageDisplay` uses virtual scrolling for message lists, rendering only visible messages plus a small buffer. This keeps memory and DOM node count constant regardless of message history length.

### Request Deduplication

`RequestDeduplicator` (`src/utils/requestDeduplicator.ts`) prevents duplicate concurrent API calls:

```typescript
const data = await deduplicator.deduplicate(
  `profile-${userId}`,
  () => fetchProfile(userId)
)
```

Multiple callers requesting the same resource share a single in-flight request.

### User Data Caching

`userDataService` caches profile data with a 5-minute TTL:

- Cache hits avoid database round-trips
- Presence data synced via Supabase Realtime (no polling)
- Context-based subscriptions: only subscribe to data relevant to the current view

### Debouncing

Common patterns using `useDebounce` composable:

- Search input debouncing (reduce API calls while typing)
- Typing indicator updates
- Resize handlers
- Scroll event processing

### Lazy Loading

- **Components**: Route views loaded on navigation via dynamic `import()`
- **Images**: Native lazy loading via `loading="lazy"`
- **Emoji data**: Loaded on demand and cached in IndexedDB (`EmojiIndexedDBCache`)

## Real-time Efficiency

### Channel Subscriptions

`RealtimeConnectionManager` manages subscriptions efficiently:

- Subscribe only to channels the user has open
- Unsubscribe when navigating away
- Connection pooling across subscriptions
- Automatic cleanup on auth state changes

### Presence Batching

Presence updates are batched to reduce Supabase Realtime traffic. The `SessionHeartbeat` service sends periodic keepalive pings rather than on every action.

### Message Deduplication

The chat store deduplicates messages received from both the initial fetch and realtime subscription, preventing duplicate rendering during the overlap window.

## Monitoring

Use the browser Performance tab and Vue DevTools performance timeline to identify:

- Slow component renders
- Excessive re-renders from reactive dependencies
- Large layout shifts
- Memory leaks from uncleared subscriptions

### Bundle Analysis

```bash
npm run build-only -- --report
```

Inspect the generated report to identify oversized chunks or unexpected dependencies.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/development/performance.md` and run `npm run docs:generate-guide` to update.
