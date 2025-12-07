# Performance Improvements Summary

Based on HAR file analysis (`nocache_chat_loading.har`), we've implemented several critical performance optimizations to reduce the 8+ second load time.

## ✅ Completed Optimizations

### 1. Stop Preloading Unused Route Chunks (~500KB saved)
**Problem**: Vite was preloading ALL route chunks (UserSettings, BookmarksView, ServerSettings, AdminPanel, etc.) even when not visiting those routes.

**Solution**: Created `vite-plugin-selective-preload.ts` that filters out route chunk preloads from HTML, keeping only critical vendor chunks.

**Files Changed**:
- `vite-plugin-selective-preload.ts` (new)
- `vite.config.ts`

**Expected Impact**: Saves ~500-600KB on initial load, reduces blocked time

---

### 2. Make Websocket Connection Non-Blocking (6.7s → 0s blocking)
**Problem**: Supabase realtime websocket connection was blocking for 6.7 seconds during initialization, preventing UI from being interactive.

**Solution**: Changed `subscribeToUserServers()` to not await during initialization - let it connect in background.

**Files Changed**:
- `src/stores/useServerChannel.ts`

**Expected Impact**: Eliminates 6.7 second blocking delay, page becomes interactive immediately

---

### 3. Cache Auth State (4x → 1x calls)
**Problem**: `/auth/v1/user` was being called 4 times during initial load (300-600ms each).

**Solution**: Added session caching with 5-second timeout to prevent redundant `getSession()` calls.

**Files Changed**:
- `src/stores/auth.ts`

**Expected Impact**: Reduces 4 auth API calls to 1, saves ~1-2 seconds

---

### 4. Emoji Data Lazy Loading (712KB saved)
**Status**: Already implemented! ✅

The 712KB `unicode-emoji-data.json` file is only loaded when the emoji picker is opened, not on initial page load.

**Files**:
- `src/components/EmojiPopup.vue` (lazy loads on mount)
- `src/services/unifiedEmojiService.ts` (lazy loading logic)

---

### 5. Fix Duplicate Asset Requests
**Problem**: Assets were being requested twice (likely service worker intercepting modulepreload requests).

**Solution**: 
1. Vite plugin removes unnecessary modulepreload tags
2. Service worker now skips modulepreload requests to let browser handle them naturally

**Files Changed**:
- `vite-plugin-selective-preload.ts`
- `public/service-worker.js`

**Expected Impact**: Eliminates duplicate requests, reduces network overhead

---

## 📊 Expected Performance Improvements

| Metric | Before | After (Expected) | Improvement |
|--------|--------|------------------|-------------|
| **Total Load Time** | 8.3s | ~3-4s | ~50% faster |
| **Blocking Time** | 6.7s (websocket) | 0s | 100% eliminated |
| **Initial JS Size** | ~2.5MB | ~1.5MB | ~40% reduction |
| **Auth API Calls** | 4x | 1x | 75% reduction |
| **Duplicate Requests** | 8+ | 0 | 100% eliminated |

---

## 🧪 Testing Recommendations

1. **Rebuild the app**: `npm run build`
2. **Test with cache disabled**: Open DevTools → Network → Disable cache
3. **Check HTML**: Verify fewer `<link rel="modulepreload">` tags in `dist/index.html`
4. **Monitor Network Tab**: 
   - Should see fewer duplicate requests
   - Websocket should connect in background (non-blocking)
   - Only 1 `/auth/v1/user` call
5. **Test Route Navigation**: Verify route chunks load on-demand when navigating

---

## 🔄 Remaining Optimizations (Future)

### API Call Optimization
- Add database indexes for frequently queried columns
- Implement request batching for related queries
- Add response caching for static/semi-static data

### Further Code Splitting
- Lazy load editor component only when needed
- Lazy load crypto vendor only when encryption is used
- Consider splitting large vendor bundles further

### Image Optimization
- Implement lazy loading for images below the fold
- Use Supabase image transformations for smaller sizes
- Add progressive image loading

---

## 📝 Notes

- The Vite plugin works at build time, so you must rebuild for changes to take effect
- Service worker changes require a new service worker registration (clear cache or hard refresh)
- Websocket will still connect, just non-blocking - realtime features will work once connected
- Auth caching has a 5-second window to prevent stale data while still reducing duplicates

