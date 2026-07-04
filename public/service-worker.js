// Enhanced Service Worker for Discord-like Notifications and PWA Features
// Version: 3.5 - Canonical imgproxy transform sizes + stale-while-revalidate
//                cache for emoji/avatar/server icon/banner/attachment render
//                URLs so reaction tooltips, server switches, and message
//                galleries reuse cached, downscaled images.

const CACHE_NAME = 'harmony-v5-mobile'
const NOTIFICATION_CACHE = 'harmony-notifications-v2'
const STATIC_CACHE = 'harmony-static-v3'
const API_CACHE = 'harmony-api-v3'
const EMOJI_CACHE = 'harmony-emoji-v2'
const TRANSFORM_CACHE = 'harmony-transform-v1'

// Cache strategies
const STATIC_RESOURCES = [
  '/',
  '/manifest.json',
  '/img/app_icon_square.webp',
  '/favicon/android-icon-192x192.png'
]

// Install event - precache critical resources
self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker: Installing...')
  
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('📦 Service Worker: Precaching static resources')
      return cache.addAll(STATIC_RESOURCES)
    })
    // Don't skip waiting - let the user control updates
    // This prevents aggressive takeover on mobile
  )
})

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker: Activating...')
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && 
              cacheName !== STATIC_CACHE && 
              cacheName !== API_CACHE && 
              cacheName !== NOTIFICATION_CACHE &&
              cacheName !== EMOJI_CACHE &&
              cacheName !== TRANSFORM_CACHE) {
            console.log('🗑️ Service Worker: Deleting old cache:', cacheName)
            return caches.delete(cacheName)
          }
        })
      )
    }).then(() => {
      // Only claim clients if explicitly requested - prevents aggressive takeover
      // This helps with mobile reload issues
      if (self.registration?.waiting) {
        return self.clients.claim()
      }
    })
  )
})

// Note: Main fetch event handler is implemented later in the file with enhanced logic

// Note: Caching strategies are implemented later in the file with enhanced versions

// Enhanced notification handling with proper Discord-like behavior
// event.waitUntil() must be called synchronously (before any await)
// or the browser may terminate the service worker before the notification is shown.
self.addEventListener('push', (event) => {
  console.log('🔔 Service Worker: Push event received', event)
  
  if (!event.data) {
    console.log('⚠️ Service Worker: No data in push event')
    return
  }

  event.waitUntil(handlePushEvent(event))
})

async function handlePushEvent(event) {
  try {
    const data = event.data.json()
    console.log('📨 Service Worker: Notification data:', data)

    // Skip push notification if any app window is focused - the realtime
    // subscription already handles desktop notifications in that case
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })
    const hasFocusedClient = windowClients.some(client => client.focused)
    if (hasFocusedClient) {
      console.log('🔕 Service Worker: App is focused, skipping push notification')
      return
    }

    const notificationOptions = {
      body: data.message || data.body,
      icon: data.data?.avatar_url || data.icon || '/favicon/android-icon-192x192.png',
      badge: '/img/app_icon_badge.png',
      tag: data.tag || (data.data?.conversation_id
        ? `harmony-${data.type}-conv-${data.data.conversation_id}`
        : data.data?.channel_id
          ? `harmony-${data.type}-ch-${data.data.channel_id}`
          : `harmony-${data.type}-${data.data?.user_id || 'unknown'}`),
      renotify: true,
      data: data.data || {},
      requireInteraction: ['mention', 'dm', 'reply', 'friend_request', 'server_invite'].includes(data.type),
      silent: false,
      timestamp: Date.now(),
      actions: getNotificationActions(data.type),
      image: data.data?.image_url,
      vibrate: getVibrationPattern(data.type),
      color: '#0EA5E9'
    }

    // Store notification for later retrieval
    await storeNotification(data)

    // Update app icon badge count (works from service worker on Android Chrome)
    try {
      const notifications = await self.registration.getNotifications()
      const badgeCount = notifications.length + 1
      if (navigator.setAppBadge) {
        await navigator.setAppBadge(badgeCount)
      }
    } catch (e) {
      // Badging API not supported in this context - safe to ignore
    }

    // Show notification with proper title
    const title = data.title || getDefaultTitle(data.type)
    await self.registration.showNotification(title, notificationOptions)

  } catch (error) {
    console.error('❌ Service Worker: Error handling push event:', error)
  }
}

// Enhanced notification click handling
self.addEventListener('notificationclick', (event) => {
  console.log('🖱️ Service Worker: Notification clicked', event)
  event.notification.close()
  event.waitUntil(handleNotificationClick(event))
})

async function handleNotificationClick(event) {
  const data = event.notification.data
  const action = event.action

  // Update badge count after closing
  await updateBadgeCount()

  if (action === 'reply' && (data.conversation_id || data.server_id)) {
    const replyText = event.reply || null
    return handleQuickReply(data, replyText)
  }

  if (action === 'mark_read') {
    return markAsRead(data)
  }

  if (action === 'dismiss') {
    return
  }

  // Default click behavior: focus an existing app window (tab or installed
  // PWA) and navigate it in-place; only open a new window when none exists.
  const url = getNavigationUrl(data)
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const sameOriginClients = clientList.filter(client => {
    try {
      return new URL(client.url).origin === self.location.origin
    } catch {
      return false
    }
  })
  const harmonyClient = sameOriginClients.find(client => client.focused) || sameOriginClients[0]

  if (harmonyClient) {
    await harmonyClient.focus()
    return harmonyClient.postMessage({
      type: 'NAVIGATE_TO_NOTIFICATION',
      data: data,
      url: url
    })
  } else {
    return self.clients.openWindow(url)
  }
}

// Update badge when notifications are swiped away
self.addEventListener('notificationclose', (event) => {
  event.waitUntil(updateBadgeCount())
})

async function updateBadgeCount() {
  try {
    const notifications = await self.registration.getNotifications()
    if (navigator.setAppBadge) {
      if (notifications.length > 0) {
        await navigator.setAppBadge(notifications.length)
      } else {
        await navigator.clearAppBadge()
      }
    }
  } catch (e) {
    // Badging API not available - safe to ignore
  }
}

// Handle background sync for offline notifications
self.addEventListener('sync', (event) => {
  console.log('🔄 Service Worker: Background sync event', event.tag)
  
  if (event.tag === 'send-notification') {
    event.waitUntil(processPendingNotifications())
  }
})

// Handle messages from main app - Mobile friendly update control
self.addEventListener('message', (event) => {
  console.log('📧 Service Worker: Received message', event.data)
  
  switch (event.data.type) {
    case 'SKIP_WAITING':
      // Only skip waiting when explicitly requested by user
      console.log('⏭️ Service Worker: Manual skip waiting requested')
      self.skipWaiting()
      break
    case 'GET_VERSION':
      // Handle version requests
      event.ports[0]?.postMessage({
        version: '3.5',
        updated: new Date().toISOString()
      })
      break
    case 'PREFETCH_CRITICAL':
      // Handle prefetch requests
      console.log('📦 Service Worker: Prefetch critical resources requested')
      break
    case 'UPDATE_NOTIFICATION_SETTINGS':
      // Handle notification settings
      console.log('⚙️ Service Worker: Notification settings updated')
      break
    case 'CLEAR_NOTIFICATIONS':
      // Handle notification clearing
      console.log('🗑️ Service Worker: Clearing notifications')
      break
    case 'DISMISS_NOTIFICATIONS':
      // Dismiss specific notifications by tag or notificationId (cross-device sync)
      event.waitUntil(handleDismissNotifications(event.data))
      break
    default:
      console.log('⚠️ Service Worker: Unknown message type:', event.data.type)
  }
})

// Helper functions
function getNotificationActions(type) {
  const baseActions = [
    { action: 'mark_read', title: 'Mark as Read', icon: '/icons/check.png' },
    { action: 'dismiss', title: 'Dismiss', icon: '/icons/close.png' }
  ]

  if (type === 'dm' || type === 'mention' || type === 'reply') {
    baseActions.unshift({
      action: 'reply',
      title: 'Quick Reply',
      type: 'text',
      placeholder: 'Type a reply...',
      icon: '/icons/reply.png'
    })
  }

  return baseActions
}

function getVibrationPattern(type) {
  switch (type) {
    case 'mention':
    case 'dm':
      return [300, 100, 300, 100, 300]
    case 'reply':
      return [200, 100, 200, 100, 200]
    case 'reaction':
      return [150, 50, 150]
    case 'friend_request':
    case 'server_invite':
      return [200, 100, 200]
    default:
      return [200, 100, 200]
  }
}

function getDefaultTitle(type) {
  switch (type) {
    case 'mention': return 'You were mentioned'
    case 'dm': return 'New message'
    case 'reaction': return 'Someone reacted'
    case 'reply': return 'New reply'
    case 'server_invite': return 'Server invitation'
    case 'voice_channel_activity': return 'Voice activity'
    default: return 'Harmony'
  }
}

function getNavigationUrl(data) {
  const baseUrl = self.location.origin

  // If URL was pre-computed by the notification store, use it
  if (data.url) {
    // Handle both absolute and relative URLs
    return data.url.startsWith('/') ? `${baseUrl}${data.url}` : data.url
  }

  // Fallback for push notifications from backend (which use different field names)
  if (data.conversation_id) {
    let url = `${baseUrl}/dm/${data.conversation_id}`
    if (data.message_id) {
      url += `?messageId=${encodeURIComponent(data.message_id)}`
    }
    return url
  }

  if (data.server_id && data.channel_id) {
    let url = `${baseUrl}/chat/${data.server_id}/${data.channel_id}`
    if (data.message_id) {
      url += `?messageId=${encodeURIComponent(data.message_id)}`
    }
    return url
  }

  if (data.server_id) {
    return `${baseUrl}/chat/${data.server_id}`
  }

  return baseUrl
}

async function storeNotification(data) {
  try {
    const cache = await caches.open(NOTIFICATION_CACHE)
    const key = `notification-${Date.now()}-${Math.random()}`
    
    await cache.put(
      new Request(key),
      new Response(JSON.stringify({
        ...data,
        timestamp: Date.now(),
        read: false
      }))
    )
  } catch (error) {
    console.error('❌ Service Worker: Error storing notification:', error)
  }
}

// ============================================================================
// Quick-reply queue (IndexedDB)
// ----------------------------------------------------------------------------
// Replies typed into a notification text input must NEVER be lost. The legacy
// flow tried to postMessage() to a focused client and fell back to "open a
// window" without persisting the typed text, so a user who replied to a
// notification with no app window open got their message silently dropped.
// We now durably queue every reply here, then have the frontend
// (ServiceWorkerManager.drainQuickReplyQueue) flush them via the real
// messageService - which preserves encryption, optimistic UI, and federation
// handling. The "open the window" step is just to give the frontend a chance
// to run; the queue is the source of truth.
// ============================================================================

const QUICK_REPLY_DB_NAME = 'harmony-sw'
const QUICK_REPLY_DB_VERSION = 1
const QUICK_REPLY_STORE = 'pending-quick-replies'

function openQuickReplyDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUICK_REPLY_DB_NAME, QUICK_REPLY_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(QUICK_REPLY_STORE)) {
        db.createObjectStore(QUICK_REPLY_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function enqueueQuickReply(entry) {
  try {
    const db = await openQuickReplyDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUICK_REPLY_STORE, 'readwrite')
      tx.objectStore(QUICK_REPLY_STORE).add(entry)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  } catch (error) {
    console.error('❌ Service Worker: Failed to enqueue quick reply:', error)
  }
}

async function handleQuickReply(data, replyText) {
  try {
    // Without typed text there's nothing to send - just navigate to the
    // conversation as if the user had clicked the notification body.
    if (!replyText || !replyText.trim()) {
      const url = getNavigationUrl(data)
      return self.clients.openWindow(url)
    }

    // Persist FIRST so we never lose the user's typed text, even if every
    // subsequent step (postMessage / focus / openWindow) fails.
    await enqueueQuickReply({
      replyText,
      data,
      navigationUrl: getNavigationUrl(data),
      queuedAt: Date.now(),
    })

    // Best-effort: nudge a live client so it drains immediately instead of
    // waiting for its next page load. Whether or not this succeeds, the
    // queued entry will be processed by ServiceWorkerManager on app boot.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const focusedClient = clients.find(c => c.focused) || clients[0]

    if (focusedClient) {
      try {
        focusedClient.postMessage({ type: 'QUICK_REPLY_QUEUED' })
      } catch (e) {
        // postMessage shouldn't throw, but defend against it anyway -
        // the queue is durable and will be drained later regardless.
      }
      // Don't navigate the focused client - the user might be in another
      // conversation and we shouldn't yank them out of context. Just
      // surface the window so the toast/state update is visible.
      return focusedClient.focus()
    }

    // No live client: open a window so the frontend boots and drains the
    // queue. We deliberately point at the conversation/channel so the
    // reply lands in a useful context if the user wants to follow up.
    return self.clients.openWindow(getNavigationUrl(data))
  } catch (error) {
    console.error('❌ Service Worker: Error handling quick reply:', error)
  }
}

async function markAsRead(data) {
  try {
    // Send message to main app to mark notification as read
    const clients = await self.clients.matchAll({ type: 'window' })
    clients.forEach(client => {
      client.postMessage({
        type: 'MARK_NOTIFICATION_READ',
        data: data
      })
    })
  } catch (error) {
    console.error('❌ Service Worker: Error marking as read:', error)
  }
}

async function processPendingNotifications() {
  try {
    const cache = await caches.open(NOTIFICATION_CACHE)
    const requests = await cache.keys()
    
    // Process any pending notifications that failed to send
    for (const request of requests) {
      const response = await cache.match(request)
      const data = await response.json()
      
      if (!data.processed) {
        // Attempt to process the notification
        await processNotification(data)
        
        // Mark as processed
        await cache.put(
          request,
          new Response(JSON.stringify({ ...data, processed: true }))
        )
      }
    }
  } catch (error) {
    console.error('❌ Service Worker: Error processing pending notifications:', error)
  }
}

async function handleDismissNotifications(data) {
  try {
    const notifications = await self.registration.getNotifications()
    let dismissed = 0
    
    for (const notification of notifications) {
      const matchesId = data.notificationId && notification.data?.notificationId === data.notificationId
      const matchesTag = data.tag && notification.tag === data.tag
      const matchesConversation = data.conversationId && notification.tag?.includes(`conv-${data.conversationId}`)
      const matchesChannel = data.channelId && notification.tag?.includes(`ch-${data.channelId}`)
      
      if (matchesId || matchesTag || matchesConversation || matchesChannel) {
        notification.close()
        dismissed++
      }
    }
    
    if (dismissed > 0) {
      console.log(`🔕 Service Worker: Dismissed ${dismissed} notification(s) via cross-device sync`)
      await updateBadgeCount()
    }
  } catch (error) {
    console.error('❌ Service Worker: Error dismissing notifications:', error)
  }
}

async function processNotification(data) {
  // Implementation for processing individual notifications
  console.log('🔄 Service Worker: Processing notification:', data)
}

// Note: Install and activate event listeners are defined at the top of the file

// Supabase imgproxy render URLs for storage-backed images. Scoped narrowly so we
// do not intercept arbitrary cross-origin images (the old avatar-loop issue).
function isStorageTransformRequest(url) {
  return /\/storage\/v1\/render\/image\/public\/(emojis|avatars|server_icons|server_banners|user_media)\//.test(url.pathname)
}

// Enhanced fetch handling with offline support - Mobile optimized
self.addEventListener('fetch', (event) => {
  // Skip unsupported schemes
  const requestUrl = new URL(event.request.url)
  if (!requestUrl.protocol.startsWith('http')) {
    return
  }

  // Emoji assets: cache-first for SVGs and JSON in /assets/emojis/
  // These are immutable static assets that should be served from cache
  if (requestUrl.hostname === self.location.hostname &&
      requestUrl.pathname.startsWith('/assets/emojis/')) {
    event.respondWith(emojiCacheFirst(event.request))
    return
  }

  // Storage transform images (emoji/avatar/server icon/banner): serve cached
  // immediately, refresh in background so uploads still propagate.
  if (isStorageTransformRequest(requestUrl)) {
    event.respondWith(transformImageStaleWhileRevalidate(event.request))
    return
  }

  // Skip ALL other image requests to prevent avatar loops (transforms handled above)
  if (event.request.destination === 'image' || 
      requestUrl.pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)$/i)) {
    return
  }

  // Only handle same-origin requests - this prevents external avatar loops
  if (requestUrl.hostname !== self.location.hostname) {
    return
  }

  // Skip Supabase storage URLs (these are external and cause loops)
  if (requestUrl.hostname.includes('supabase') || 
      requestUrl.hostname.includes('storage') ||
      requestUrl.pathname.includes('storage/v1/object/public')) {
    return
  }

  // Skip requests that might cause loops (additional safety)
  if (requestUrl.pathname.includes('avatar') || 
      requestUrl.pathname.includes('profile') || 
      requestUrl.searchParams.has('avatar') ||
      requestUrl.searchParams.has('profile_image')) {
    return
  }

  // MOBILE FIX: Skip navigation requests to prevent aggressive reloading
  // Only handle specific resource types, not page navigation
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    return // Let the browser handle navigation naturally
  }

  // Enhanced request categorization (more selective for mobile)
  const url = new URL(event.request.url)
  const isAPIRequest = url.pathname.startsWith('/api/')
  const isAuthRequest = url.pathname.includes('/auth/')
  const isCSSRequest = url.pathname.endsWith('.css')
  const isJSRequest = url.pathname.endsWith('.js') || url.pathname.endsWith('.ts')
  
  // FIX: Skip all JS module requests to prevent caching HTML responses as JS
  // Dynamic imports from Vite code splitting are in /assets/ and should be handled by browser
  // This prevents the issue where 404 JS files return index.html, which gets cached as JS
  const isViteModule = url.pathname.startsWith('/assets/') && isJSRequest
  const isModuleRequest = event.request.destination === 'script' || 
                          event.request.mode === 'cors' ||
                          event.request.credentials === 'omit' ||
                          event.request.headers.get('accept')?.includes('application/javascript') ||
                          event.request.headers.get('accept')?.includes('text/javascript')
  
  // PERFORMANCE: Skip modulepreload requests to prevent duplicate fetches
  // The browser handles these efficiently, and intercepting causes duplicates
  const isModulePreload = event.request.headers.get('purpose') === 'modulepreload' ||
                          event.request.headers.get('X-Purpose') === 'modulepreload'

  // Only intercept specific types of requests
  if (isModulePreload || isViteModule || (isJSRequest && isModuleRequest)) {
    // Let browser handle module requests naturally - don't intercept
    // This prevents caching HTML responses (from 404s) as JS modules
    return
  } else if (isAPIRequest || isAuthRequest) {
    // Critical API requests - network first with enhanced error handling
    event.respondWith(enhancedNetworkFirst(event.request, API_CACHE))
  } else if (isCSSRequest) {
    // Vite dev serves imported *.css as JS modules (Content-Type: text/javascript).
    // Caching those as CSS breaks validation and spams the console; let the dev server handle them.
    const isViteSourceStyle =
      url.pathname.startsWith('/src/') || url.pathname.includes('/node_modules/')
    if (isViteSourceStyle) {
      return
    }
    // Static CSS assets - stale while revalidate (better for mobile)
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE))
  }
  // Remove the 'else' case that was intercepting ALL other requests
})

// Enhanced caching strategies - Mobile optimized
async function enhancedNetworkFirst(request, cacheName) {
  try {
    // Add timeout for mobile connections
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout
    
    const networkResponse = await fetch(request, {
      signal: controller.signal
    })
    
    clearTimeout(timeoutId)
    
    if (networkResponse.status === 200 && networkResponse.ok && request.method === 'GET') {
      const contentLength = networkResponse.headers.get('content-length')
      const isSmallResponse = !contentLength || parseInt(contentLength) < 1024 * 1024 // 1MB limit
      
      if (isSmallResponse) {
        const cache = await caches.open(cacheName)
        const responseClone = networkResponse.clone()
        cache.put(request, responseClone).catch(err => {
          console.warn('Failed to cache response:', err)
        })
      }
    }
    
    return networkResponse
  } catch (error) {
    console.log('🌐 Service Worker: Network failed, trying cache:', error.message)
    
    if (request.method !== 'GET') {
      return new Response('Network unavailable', { 
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      })
    }
    
    const cachedResponse = await caches.match(request)
    if (cachedResponse) {
      return cachedResponse
    }
    
    // Simplified offline fallback for mobile
    return new Response('Network unavailable', { 
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cachedResponse = await caches.match(request)
  
  // Always fetch in background to update cache
  const fetchPromise = fetch(request).then(response => {
    // FIX: Validate response MIME type before caching
    // Only cache if response is actually the expected type (not HTML from 404s)
    const contentType = response.headers.get('content-type') || ''
    const isExpectedType = 
      (request.url.endsWith('.css') && contentType.includes('text/css')) ||
      (request.url.endsWith('.js') && (contentType.includes('application/javascript') || contentType.includes('text/javascript'))) ||
      (!request.url.match(/\.(css|js)$/)) // Non-CSS/JS files
    
    if (response.status === 200 && response.ok && isExpectedType) {
      // Clone the response BEFORE using it
      const responseClone = response.clone()
      caches.open(cacheName).then(cache => {
        cache.put(request, responseClone)
      }).catch(err => {
        console.warn('Failed to cache response in background:', err)
      })
    } else if (response.status === 200 && !isExpectedType) {
      // If we got a 200 but wrong content type (e.g., HTML for a JS file), don't cache
      console.warn('⚠️ Service Worker: Skipping cache for wrong content type:', request.url, contentType)
    }
    return response
  }).catch(err => {
    console.warn('Background fetch failed:', err)
    return null
  })
  
  // Return cached version immediately if available
  if (cachedResponse) {
    // Start background update but don't wait for it
    fetchPromise
    return cachedResponse
  }
  
  // Otherwise wait for network
  const networkResponse = await fetchPromise
  return networkResponse || new Response('Resource not available', { status: 503 })
}

// Stale-while-revalidate for imgproxy render URLs. Validates image/* so a 404
// HTML page never gets pinned in cache (the old avatar-loop failure mode).
async function transformImageStaleWhileRevalidate(request) {
  const cachedResponse = await caches.match(request)

  const fetchPromise = fetch(request).then((response) => {
    const contentType = response.headers.get('content-type') || ''
    const isImage = contentType.startsWith('image/')
    if (response.status === 200 && response.ok && isImage) {
      const responseClone = response.clone()
      caches.open(TRANSFORM_CACHE).then((cache) => {
        cache.put(request, responseClone)
      }).catch(() => {})
    }
    return response
  }).catch(() => null)

  if (cachedResponse) {
    fetchPromise
    return cachedResponse
  }

  const networkResponse = await fetchPromise
  return networkResponse || new Response('Image unavailable', { status: 503 })
}

// Cache-first strategy for emoji assets (SVGs and JSON in /assets/emojis/)
// These are static and rarely change, so we serve from cache and update in background.
async function emojiCacheFirst(request) {
  try {
    const cached = await caches.match(request)
    if (cached) {
      return cached
    }

    const networkResponse = await fetch(request)
    if (networkResponse.ok) {
      const cache = await caches.open(EMOJI_CACHE)
      cache.put(request, networkResponse.clone()).catch(() => {})
    }
    return networkResponse
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached
    return new Response('Emoji asset unavailable', { status: 503 })
  }
}

console.log('🚀 Service Worker: Script loaded successfully')
