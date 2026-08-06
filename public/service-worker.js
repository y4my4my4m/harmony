// Service worker: push notifications and PWA caching.
// Version 3.5 - canonical imgproxy transform sizes; stale-while-revalidate
// cache for emoji/avatar/server icon/banner/attachment render URLs.

const CACHE_NAME = 'harmony-v5-mobile'
const NOTIFICATION_CACHE = 'harmony-notifications-v2'
const STATIC_CACHE = 'harmony-static-v3'
const API_CACHE = 'harmony-api-v3'
const EMOJI_CACHE = 'harmony-emoji-v2'
const TRANSFORM_CACHE = 'harmony-transform-v1'

const STATIC_RESOURCES = [
  '/',
  '/manifest.json',
  '/img/app_icon_square.webp',
  '/favicon/android-icon-192x192.png'
]

self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing...')
  
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      console.log('Service Worker: Precaching static resources')
      return cache.addAll(STATIC_RESOURCES)
    })
    // No skipWaiting: activation is user-driven. Immediate takeover breaks
    // in-flight mobile sessions.
  )
})

// Activate: drop caches not in the current set.
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating...')
  
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
            console.log('Service Worker: Deleting old cache:', cacheName)
            return caches.delete(cacheName)
          }
        })
      )
    }).then(() => {
      // Claim clients only when an update is pending; unconditional claim
      // causes mobile reload loops.
      if (self.registration?.waiting) {
        return self.clients.claim()
      }
    })
  )
})

// Fetch handler and caching strategies are defined further down.

// event.waitUntil() must be called synchronously, before any await, or the
// browser may terminate the worker before the notification is shown.
self.addEventListener('push', (event) => {
  console.log('Service Worker: Push event received', event)
  
  if (!event.data) {
    console.log('Service Worker: No data in push event')
    return
  }

  event.waitUntil(handlePushEvent(event))
})

async function handlePushEvent(event) {
  try {
    const data = event.data.json()
    console.log('Service Worker: Notification data:', data)

    // A focused window already raises desktop notifications from the
    // realtime subscription.
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })
    const hasFocusedClient = windowClients.some(client => client.focused)
    if (hasFocusedClient) {
      console.log('Service Worker: App is focused, skipping push notification')
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

    await storeNotification(data)

    // Badging API works from the worker on Android Chrome.
    try {
      const notifications = await self.registration.getNotifications()
      const badgeCount = notifications.length + 1
      if (navigator.setAppBadge) {
        await navigator.setAppBadge(badgeCount)
      }
    } catch (e) {
      // Badging API unsupported here.
    }

    const title = data.title || getDefaultTitle(data.type)
    await self.registration.showNotification(title, notificationOptions)

  } catch (error) {
    console.error('Service Worker: Error handling push event:', error)
  }
}

self.addEventListener('notificationclick', (event) => {
  console.log('Service Worker: Notification clicked', event)
  event.notification.close()
  event.waitUntil(handleNotificationClick(event))
})

async function handleNotificationClick(event) {
  const data = event.notification.data
  const action = event.action

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

  // Default click: focus an existing same-origin window and navigate it in
  // place; open a new window only when none exists.
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

// Swipe-away also lands here.
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
    // Badging API unavailable.
  }
}

self.addEventListener('sync', (event) => {
  console.log('Service Worker: Background sync event', event.tag)
  
  if (event.tag === 'send-notification') {
    event.waitUntil(processPendingNotifications())
  }
})

self.addEventListener('message', (event) => {
  console.log('Service Worker: Received message', event.data)
  
  switch (event.data.type) {
    case 'SKIP_WAITING':
      // Sole path to activation; the install handler never skips waiting.
      console.log('Service Worker: Manual skip waiting requested')
      self.skipWaiting()
      break
    case 'GET_VERSION':
      event.ports[0]?.postMessage({
        version: '3.5',
        updated: new Date().toISOString()
      })
      break
    // PREFETCH_CRITICAL, UPDATE_NOTIFICATION_SETTINGS and CLEAR_NOTIFICATIONS
    // log only; no implementation behind them.
    case 'PREFETCH_CRITICAL':
      console.log('Service Worker: Prefetch critical resources requested')
      break
    case 'UPDATE_NOTIFICATION_SETTINGS':
      console.log('Service Worker: Notification settings updated')
      break
    case 'CLEAR_NOTIFICATIONS':
      console.log('Service Worker: Clearing notifications')
      break
    case 'DISMISS_NOTIFICATIONS':
      // Matches by notificationId, tag, conversation or channel; used for
      // cross-device dismissal.
      event.waitUntil(handleDismissNotifications(event.data))
      break
    default:
      console.log('Service Worker: Unknown message type:', event.data.type)
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

  // The notification store pre-computes `url`; it may be absolute or relative.
  if (data.url) {
    return data.url.startsWith('/') ? `${baseUrl}${data.url}` : data.url
  }

  // Backend push payloads carry ids instead, under different field names.
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
    console.error('Service Worker: Error storing notification:', error)
  }
}

// Quick-reply queue (IndexedDB)
// The queue is the source of truth for text typed into a notification input.
// ServiceWorkerManager.drainQuickReplyQueue flushes it through messageService,
// which owns encryption, optimistic UI and federation. Focusing or opening a
// window only gives the frontend a chance to run; nothing is sent from here.

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
    console.error('Service Worker: Failed to enqueue quick reply:', error)
  }
}

async function handleQuickReply(data, replyText) {
  try {
    // No typed text: behave as a click on the notification body.
    if (!replyText || !replyText.trim()) {
      const url = getNavigationUrl(data)
      return self.clients.openWindow(url)
    }

    // Persist BEFORE postMessage/focus/openWindow; those may all fail.
    await enqueueQuickReply({
      replyText,
      data,
      navigationUrl: getNavigationUrl(data),
      queuedAt: Date.now(),
    })

    // Nudge a live client to drain now rather than on its next page load.
    // On failure the entry is drained at app boot.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const focusedClient = clients.find(c => c.focused) || clients[0]

    if (focusedClient) {
      try {
        focusedClient.postMessage({ type: 'QUICK_REPLY_QUEUED' })
      } catch (e) {
        // Queue is durable; a failed postMessage costs only latency.
      }
      // No navigation: the client may be in another conversation. Focus
      // only, so the state update is visible.
      return focusedClient.focus()
    }

    // No live client: open the conversation/channel so the frontend boots
    // and drains the queue in context.
    return self.clients.openWindow(getNavigationUrl(data))
  } catch (error) {
    console.error('Service Worker: Error handling quick reply:', error)
  }
}

async function markAsRead(data) {
  try {
    const clients = await self.clients.matchAll({ type: 'window' })
    clients.forEach(client => {
      client.postMessage({
        type: 'MARK_NOTIFICATION_READ',
        data: data
      })
    })
  } catch (error) {
    console.error('Service Worker: Error marking as read:', error)
  }
}

async function processPendingNotifications() {
  try {
    const cache = await caches.open(NOTIFICATION_CACHE)
    const requests = await cache.keys()
    
    for (const request of requests) {
      const response = await cache.match(request)
      const data = await response.json()
      
      if (!data.processed) {
        await processNotification(data)
        
        await cache.put(
          request,
          new Response(JSON.stringify({ ...data, processed: true }))
        )
      }
    }
  } catch (error) {
    console.error('Service Worker: Error processing pending notifications:', error)
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
      console.log(`Service Worker: Dismissed ${dismissed} notification(s) via cross-device sync`)
      await updateBadgeCount()
    }
  } catch (error) {
    console.error('Service Worker: Error dismissing notifications:', error)
  }
}

async function processNotification(data) {
  // Logging only; no processing implemented.
  console.log('Service Worker: Processing notification:', data)
}

// Install and activate listeners are at the top of the file.

// Supabase imgproxy render URLs for storage-backed images. Scoped to known
// buckets; broader matching reintroduces the avatar fetch loop.
function isStorageTransformRequest(url) {
  return /\/storage\/v1\/render\/image\/public\/(emojis|avatars|server_icons|server_banners|user_media)\//.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  // Non-http schemes (chrome-extension:, blob:) are not cacheable.
  const requestUrl = new URL(event.request.url)
  if (!requestUrl.protocol.startsWith('http')) {
    return
  }

  // /assets/emojis/ SVG and JSON are immutable: cache-first.
  if (requestUrl.hostname === self.location.hostname &&
      requestUrl.pathname.startsWith('/assets/emojis/')) {
    event.respondWith(emojiCacheFirst(event.request))
    return
  }

  // Storage transform images: serve cached, refresh in background so
  // re-uploads propagate.
  if (isStorageTransformRequest(requestUrl)) {
    event.respondWith(transformImageStaleWhileRevalidate(event.request))
    return
  }

  // All other images pass through; intercepting them causes avatar loops.
  if (event.request.destination === 'image' || 
      requestUrl.pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)$/i)) {
    return
  }

  // Same-origin only; cross-origin interception loops on avatars.
  if (requestUrl.hostname !== self.location.hostname) {
    return
  }

  // Supabase storage objects are served directly.
  if (requestUrl.hostname.includes('supabase') || 
      requestUrl.hostname.includes('storage') ||
      requestUrl.pathname.includes('storage/v1/object/public')) {
    return
  }

  // Avatar/profile paths loop when intercepted.
  if (requestUrl.pathname.includes('avatar') || 
      requestUrl.pathname.includes('profile') || 
      requestUrl.searchParams.has('avatar') ||
      requestUrl.searchParams.has('profile_image')) {
    return
  }

  // Navigations pass through to the browser; intercepting them causes
  // repeated reloads on mobile.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    return
  }

  const url = new URL(event.request.url)
  const isAPIRequest = url.pathname.startsWith('/api/')
  const isAuthRequest = url.pathname.includes('/auth/')
  const isCSSRequest = url.pathname.endsWith('.css')
  const isJSRequest = url.pathname.endsWith('.js') || url.pathname.endsWith('.ts')
  
  // Vite code-split chunks live under /assets/. A 404 there returns
  // index.html, which would be cached as JS.
  const isViteModule = url.pathname.startsWith('/assets/') && isJSRequest
  const isModuleRequest = event.request.destination === 'script' || 
                          event.request.mode === 'cors' ||
                          event.request.credentials === 'omit' ||
                          event.request.headers.get('accept')?.includes('application/javascript') ||
                          event.request.headers.get('accept')?.includes('text/javascript')
  
  // Intercepting modulepreload duplicates the fetch.
  const isModulePreload = event.request.headers.get('purpose') === 'modulepreload' ||
                          event.request.headers.get('X-Purpose') === 'modulepreload'

  if (isModulePreload || isViteModule || (isJSRequest && isModuleRequest)) {
    return
  } else if (isAPIRequest || isAuthRequest) {
    event.respondWith(enhancedNetworkFirst(event.request, API_CACHE))
  } else if (isCSSRequest) {
    // Vite dev serves imported *.css as JS modules
    // (Content-Type: text/javascript); caching those as CSS fails validation.
    const isViteSourceStyle =
      url.pathname.startsWith('/src/') || url.pathname.includes('/node_modules/')
    if (isViteSourceStyle) {
      return
    }
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE))
  }
  // Everything else is left to the browser.
})

async function enhancedNetworkFirst(request, cacheName) {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000) // 5s
    
    const networkResponse = await fetch(request, {
      signal: controller.signal
    })
    
    clearTimeout(timeoutId)
    
    if (networkResponse.status === 200 && networkResponse.ok && request.method === 'GET') {
      const contentLength = networkResponse.headers.get('content-length')
      const isSmallResponse = !contentLength || parseInt(contentLength) < 1024 * 1024 // 1 MiB cap
      
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
    console.log('Service Worker: Network failed, trying cache:', error.message)
    
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
    
    return new Response('Network unavailable', { 
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cachedResponse = await caches.match(request)
  
  const fetchPromise = fetch(request).then(response => {
    // MIME check: a 404 returns index.html, which must not be cached under
    // a .css/.js URL.
    const contentType = response.headers.get('content-type') || ''
    const isExpectedType = 
      (request.url.endsWith('.css') && contentType.includes('text/css')) ||
      (request.url.endsWith('.js') && (contentType.includes('application/javascript') || contentType.includes('text/javascript'))) ||
      (!request.url.match(/\.(css|js)$/))
    
    if (response.status === 200 && response.ok && isExpectedType) {
      // Clone before the body is consumed.
      const responseClone = response.clone()
      caches.open(cacheName).then(cache => {
        cache.put(request, responseClone)
      }).catch(err => {
        console.warn('Failed to cache response in background:', err)
      })
    } else if (response.status === 200 && !isExpectedType) {
      console.warn('Service Worker: Skipping cache for wrong content type:', request.url, contentType)
    }
    return response
  }).catch(err => {
    console.warn('Background fetch failed:', err)
    return null
  })
  
  if (cachedResponse) {
    // fetchPromise runs unawaited; the cache updates in the background.
    fetchPromise
    return cachedResponse
  }
  
  const networkResponse = await fetchPromise
  return networkResponse || new Response('Resource not available', { status: 503 })
}

// Stale-while-revalidate for imgproxy render URLs. Requires image/* so a 404
// HTML page is never pinned in the cache.
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

// Cache-first for /assets/emojis/ SVG and JSON; these assets rarely change.
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

console.log('Service Worker: Script loaded successfully')
