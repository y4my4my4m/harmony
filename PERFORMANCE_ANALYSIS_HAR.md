# Performance Analysis: HAR File Review

**Date:** 2025-12-07  
**Total Load Time:** ~8.3 seconds (from first to last request)  
**Page onLoad:** 475ms (misleading - doesn't include async operations)  
**Total Requests:** 157

## Critical Issues

### 1. 🔴 WebSocket Connection Blocking (6.7 seconds)
**Impact:** CRITICAL - This is the biggest bottleneck

- **Issue:** The Supabase realtime websocket connection (`wss://db.mony.lol/realtime/v1/websocket`) is taking **6,775ms** to establish
- **Location:** RealtimeConnectionManager initialization
- **Impact:** Blocks page interactivity and data loading

**Recommendations:**
- Make websocket connection **non-blocking** - don't wait for it before showing UI
- Use lazy initialization - only connect when realtime features are actually needed
- Add connection retry with exponential backoff (already exists, but connection should be async)
- Consider using HTTP polling as fallback for initial load, then upgrade to websocket

### 2. 🟠 Duplicate Asset Requests
**Impact:** HIGH - Wastes bandwidth and increases load time

**Duplicates Found:**
- `/assets/index-Dv-kOXgL.js` - 2x
- `/assets/crypto-vendor-C-6GJc2G.js` - 2x  
- `/assets/vendor-Chxb5v8W.js` - 2x
- `/assets/vue-vendor-BgMPPz-_.js` - 2x
- `/assets/supabase-vendor-CBuFQGOr.js` - 2x
- `/assets/editor-BUvxpLmZ.js` - 2x
- `/assets/message-4Arf_l1W.js` - 2x
- `/assets/view-ServerSettings-BqNlfNKT.js` - 2x

**Root Cause:** Likely service worker intercepting requests or browser cache issues

**Recommendations:**
- Review service worker fetch handler - ensure it's not causing duplicate requests
- Add proper cache headers to assets
- Use HTTP/2 server push for critical assets (if supported)
- Implement proper asset versioning

### 3. 🟠 High Blocked Time (400ms+ per asset)
**Impact:** HIGH - Delays asset loading significantly

**Pattern:** Many JavaScript and CSS files are blocked for **400-413ms** before they can start downloading

**Examples:**
- `editor-BUvxpLmZ.js`: 412.9ms blocked, 134.2ms wait
- `message-4Arf_l1W.js`: 413.3ms blocked, 261.3ms wait
- `view-ServerSettings-BqNlfNKT.js`: 412.9ms blocked, 261.3ms wait

**Root Causes:**
- Browser waiting for higher priority resources
- HTTP/2 connection limits
- Service worker intercepting requests
- Render-blocking resources

**Recommendations:**
- Use `<link rel="preload">` for critical assets (already done, but may need optimization)
- Reduce number of initial requests
- Use resource hints (`dns-prefetch`, `preconnect`) for external domains
- Consider code splitting to reduce initial bundle size
- Defer non-critical CSS loading

### 4. 🟡 Multiple Auth API Calls (4x)
**Impact:** MEDIUM - Unnecessary network overhead

- `/auth/v1/user` is being called **4 times** during initial load
- Each call takes 300-600ms

**Recommendations:**
- Cache auth state in memory after first call
- Use singleton pattern for auth checks
- Batch auth-related API calls
- Consider using session storage for auth state

### 5. 🟡 Large Emoji Data File (712KB)
**Impact:** MEDIUM - Large synchronous load

- `/assets/emojis/unicode-emoji-data.json` is **712.5KB**
- Loaded synchronously during initialization

**Recommendations:**
- Lazy load emoji data - only load when emoji picker is opened
- Use compression (gzip/brotli) - verify it's enabled
- Consider splitting emoji data into chunks
- Load emoji data in background after initial render

### 6. 🟡 Slow API Calls (300-600ms)
**Impact:** MEDIUM - Delays data loading

**Slow API Calls:**
- `get_batch_message_reactions`: 668ms
- `user_servers`: 541ms  
- `servers`: 503ms
- `emojis`: 345ms

**Recommendations:**
- Add database indexes for frequently queried columns
- Use database connection pooling
- Implement request batching where possible
- Add response caching for static/semi-static data
- Use Supabase edge functions for complex queries

### 7. 🟡 Large JavaScript Bundles
**Impact:** MEDIUM - Increases parse/compile time

**Large Bundles:**
- `vendor-Chxb5v8W.js`: 658.5KB
- `editor-BUvxpLmZ.js`: 562.3KB
- `view-UserSettings-iME7Lp0f.js`: 389.0KB
- `crypto-vendor-C-6GJc2G.js`: 353.6KB

**Recommendations:**
- Implement route-based code splitting (already partially done)
- Lazy load heavy components (editor, crypto) only when needed
- Use dynamic imports for non-critical features
- Consider tree-shaking unused code
- Review bundle analyzer to identify bloat

## Performance Metrics Summary

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Total Load Time | 8.3s | <3s | 🔴 Critical |
| Page onLoad | 475ms | <1s | 🟢 Good |
| Total Requests | 157 | <50 | 🔴 High |
| Largest Asset | 712KB | <200KB | 🟡 Medium |
| Duplicate Requests | 8+ | 0 | 🔴 High |
| WebSocket Connect | 6.7s | <1s | 🔴 Critical |

## Priority Action Items

### ✅ Fixed
1. **Stop preloading unused route chunks** - Created Vite plugin to prevent preloading UserSettings, BookmarksView, ServerSettings, AdminPanel, etc. when not needed
   - **Impact**: Saves ~500KB+ on initial load
   - **Files**: `vite-plugin-selective-preload.ts`, `vite.config.ts`

### Immediate (Critical)
1. **Make websocket connection non-blocking** - Don't wait for realtime connection before showing UI
2. **Fix duplicate asset requests** - Investigate service worker and cache headers
3. **Reduce blocked time** - Optimize resource loading order and priorities

### Short-term (High Priority)
4. **Lazy load emoji data** - Only load when emoji picker is opened
5. **Cache auth state** - Prevent multiple `/auth/v1/user` calls
6. **Optimize API calls** - Add indexes, caching, and batching

### Medium-term (Nice to Have)
7. **Further code splitting** - Lazy load editor, crypto, and other heavy components
8. **Implement HTTP/2 server push** - For critical assets
9. **Add service worker caching** - For static assets and API responses

## Code Locations to Review

1. **RealtimeConnectionManager.ts** - Make connection async/non-blocking
2. **BaseLayout.vue** - Review initialization sequence
3. **service-worker.js** - Check for duplicate request issues
4. **vite.config.ts** - Review build configuration and code splitting
5. **CoreMessageService.ts** - Optimize `get_batch_message_reactions` call
6. **useServerChannel.ts** - Review `initializeUserEnvironment` for optimization

## Testing Recommendations

1. Test with cache disabled (current HAR) vs enabled
2. Test on slower connections (3G throttling)
3. Use Chrome DevTools Performance tab to identify render-blocking resources
4. Use Lighthouse to get comprehensive performance score
5. Monitor Core Web Vitals (LCP, FID, CLS)

