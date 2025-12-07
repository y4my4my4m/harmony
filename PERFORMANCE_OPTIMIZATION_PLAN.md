# Performance Optimization Plan

Based on HAR file analysis of `nocache_chat_loading.har`:
- **Total load time**: 14.11s
- **DOMContentLoaded**: 1.31s
- **Total requests**: 144
- **Total JS size**: 3.2MB (initial: 3.1MB, lazy: 127KB)

## Critical Issues Found

### 1. **Massive Main Bundle (1.8MB)**
- `index-BrCHHmMu.js`: 1,818.9KB
- This is blocking initial render
- **Impact**: High - blocks DOMContentLoaded

**Solutions**:
- Implement better code splitting in `vite.config.ts`
- Split by route (chat, social, settings, etc.)
- Lazy load heavy components (RichTextEditor, Composer, etc.)
- Use dynamic imports for non-critical features

### 2. **Duplicate API Calls**
- **10x** `profiles` requests
- **8x** `user_servers` requests  
- **6x** `servers` requests
- **4x** `channels`, `emojis`, `conversation_participants`

**Root Causes**:
- Multiple stores/services fetching same data independently
- No centralized request deduplication
- Components fetching data instead of using store cache

**Solutions**:
- Centralize all profile fetches through `ProfileService` with request deduplication
- Use `serverMembershipService` for all `user_servers` queries (already created)
- Add request deduplication to `useServerChannelStore.fetchServersForUser`
- Cache API responses in stores with TTL

### 3. **Large Images (1.7MB avatars)**
- Multiple 1.7MB avatar images loaded immediately
- No lazy loading or size optimization

**Solutions**:
- Implement lazy loading for images below the fold
- Use Supabase image transformations for smaller sizes
- Add `loading="lazy"` to all avatar components
- Use thumbnail sizes initially, load full size on click

### 4. **Large Emoji Data (712KB)**
- `unicode-emoji-data.json`: 712.5KB loaded on initial load
- `twemoji-file-map.json`: 110.8KB

**Solutions**:
- Lazy load emoji data only when emoji picker is opened
- Split emoji data into chunks (categories)
- Load only frequently used emojis initially

### 5. **High Wait Times (551ms average)**
- Total wait time: 79.4s across 144 requests
- Many sequential API calls

**Solutions**:
- Parallelize independent API calls using `Promise.all`
- Batch related queries (e.g., fetch all profiles in one query)
- Use Supabase batch queries where possible

## Implementation Priority

### Phase 1: Quick Wins (High Impact, Low Effort)
1. ✅ Add request deduplication to profile fetches
2. ✅ Lazy load emoji data
3. ✅ Add `loading="lazy"` to avatar images
4. ✅ Parallelize independent API calls in `BaseLayout.initializeApp`

### Phase 2: Code Splitting (High Impact, Medium Effort)
1. Configure Vite for better code splitting
2. Split routes into separate chunks
3. Lazy load heavy components (RichTextEditor, Composer)

### Phase 3: Image Optimization (Medium Impact, Medium Effort)
1. Implement image size optimization
2. Use Supabase image transformations
3. Add progressive image loading

### Phase 4: Advanced Optimizations (Medium Impact, High Effort)
1. Implement service worker caching strategy
2. Prefetch critical resources
3. Implement request batching

## Expected Improvements

- **Main bundle**: 1.8MB → ~800KB (with code splitting)
- **Duplicate API calls**: 10x → 1x (with deduplication)
- **Initial load time**: 14.11s → ~6-8s (estimated)
- **DOMContentLoaded**: 1.31s → ~0.8s (estimated)

