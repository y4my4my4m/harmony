// Service worker: push notifications and PWA caching.
// Version 3.7 - non-GET requests bypass the worker; notification dedupe by id,
// pushsubscriptionchange renewal, click-through via the payload url, pending reads
// for closed apps.

const CACHE_NAME = 'harmony-v5-mobile'
const STATIC_CACHE = 'harmony-static-v3'
const API_CACHE = 'harmony-api-v3'
const EMOJI_CACHE = 'harmony-emoji-v2'
const TRANSFORM_CACHE = 'harmony-transform-v1'
// Notification bookkeeping, not HTTP responses. Keys encode their timestamp.
const NOTIF_STATE_CACHE = 'harmony-notif-state-v1'
const SW_VERSION = '3.7'

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
              cacheName !== NOTIF_STATE_CACHE &&
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

// Notification bookkeeping ---------------------------------------------------
//
// shown:    ids already displayed, so a push and the app's own system notification
//           for the same row alert once. Kept for SHOWN_TTL_MS.
// read:     ids clicked or marked read while no window could take the write; the app
//           drains them after sign-in.

const SHOWN_TTL_MS = 24 * 60 * 60 * 1000
const recentlyShown = new Map()

function stateKey(kind, id, stamp) {
  return `${self.registration.scope}__notif/${kind}/${encodeURIComponent(id)}?t=${stamp}`
}

function stampOf(request) {
  return Number(new URL(request.url).searchParams.get('t')) || 0
}

async function pruneState(cache) {
  const cutoff = Date.now() - SHOWN_TTL_MS
  const keys = await cache.keys()
  await Promise.all(keys
    .filter((request) => request.url.includes('__notif/shown/') && stampOf(request) < cutoff)
    .map((request) => cache.delete(request)))
}

// The in-memory claim is taken before the first await: two events racing inside one
// worker instance see it. The cache covers a restarted worker.
async function claimShown(id) {
  if (!id) return true
  const now = Date.now()
  for (const [key, at] of recentlyShown) {
    if (now - at > SHOWN_TTL_MS) recentlyShown.delete(key)
  }
  if (recentlyShown.has(id)) return false
  recentlyShown.set(id, now)
  try {
    const cache = await caches.open(NOTIF_STATE_CACHE)
    if (await cache.match(stateKey('shown', id, 0), { ignoreSearch: true })) return false
    await cache.put(stateKey('shown', id, now), new Response(''))
    pruneState(cache).catch(() => {})
  } catch (e) {
    // Cache Storage unavailable; the in-memory claim stands.
  }
  return true
}

function notificationIdOf(data) {
  return (data && (data.notification_id || data.notificationId)) || null
}

async function queuePendingRead(data) {
  const id = notificationIdOf(data)
  if (!id) return
  try {
    const cache = await caches.open(NOTIF_STATE_CACHE)
    await cache.put(stateKey('read', id, Date.now()), new Response(''))
  } catch (e) {
    // Lost only if no window ever opens; the route visit also clears it.
  }
}

async function showOnce(title, options) {
  const id = notificationIdOf(options.data)
  if (!(await claimShown(id))) return false
  await self.registration.showNotification(title, options)
  await updateBadgeCount()
  return true
}

function isSameOrigin(client) {
  try {
    return new URL(client.url).origin === self.location.origin
  } catch {
    return false
  }
}

async function windowClients() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return all.filter(isSameOrigin)
}

// Push -----------------------------------------------------------------------

// event.waitUntil() must be called synchronously, before any await, or the
// browser may terminate the worker before the notification is shown.
self.addEventListener('push', (event) => {
  if (!event.data) return
  event.waitUntil(handlePushEvent(event))
})

async function handlePushEvent(event) {
  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'Harmony', body: event.data.text() }
  }
  const data = payload.data || {}

  try {
    // A focused window shows its own toast from the realtime event. Uncontrolled
    // windows count: a page loaded before this worker activated is still the app.
    const clients = await windowClients()
    if (clients.some((client) => client.focused)) return

    await showOnce(payload.title || getDefaultTitle(payload.type), {
      body: payload.message || payload.body || '',
      icon: data.avatar_url || payload.icon || '/favicon/android-icon-192x192.png',
      badge: '/img/app_icon_badge.png',
      tag: payload.tag || fallbackTag(payload.type, data),
      renotify: true,
      data,
      requireInteraction: ['mention', 'dm', 'reply', 'friend_request', 'server_invite'].includes(payload.type),
      silent: false,
      timestamp: Date.now(),
      actions: getNotificationActions(payload.type),
      vibrate: getVibrationPattern(payload.type),
    })
  } catch (error) {
    console.error('Service Worker: Error handling push event:', error)
  }
}

function fallbackTag(type, data) {
  if (data.conversation_id) return `harmony-${type}-conv-${data.conversation_id}`
  if (data.channel_id) return `harmony-${type}-ch-${data.channel_id}`
  return `harmony-${type}-${notificationIdOf(data) || Date.now()}`
}

// The browser rotated or expired the subscription. Renew it with the same key and
// hand the server the old endpoint plus its auth secret as proof of ownership. When
// no key is available the app renews it on its next reconcile.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(handleSubscriptionChange(event))
})

async function handleSubscriptionChange(event) {
  const previous = event.oldSubscription ? event.oldSubscription.toJSON() : null
  let next = event.newSubscription || null
  try {
    const key = event.oldSubscription && event.oldSubscription.options
      ? event.oldSubscription.options.applicationServerKey
      : null
    if (!next && key) {
      next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    }
    if (next && previous && previous.endpoint && previous.keys && previous.keys.auth) {
      await fetch('/api/federation/push/resubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldEndpoint: previous.endpoint,
          oldAuth: previous.keys.auth,
          subscription: next.toJSON(),
        }),
      })
    }
  } catch (error) {
    console.warn('Service Worker: push subscription renewal failed:', error)
  }
  const clients = await windowClients()
  clients.forEach((client) => client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' }))
}

// Clicks ---------------------------------------------------------------------

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(handleNotificationClick(event))
})

async function handleNotificationClick(event) {
  const data = event.notification.data || {}
  const action = event.action

  await updateBadgeCount()

  if (action === 'reply' && (data.conversation_id || data.server_id)) {
    return handleQuickReply(data, event.reply || null)
  }

  if (action === 'dismiss') return

  await queuePendingRead(data)
  const clients = await windowClients()

  if (action === 'mark_read') {
    clients.forEach((client) => client.postMessage({ type: 'MARK_NOTIFICATION_READ', data }))
    return
  }

  const url = getNavigationUrl(data)
  const target = clients.find((client) => client.focused) || clients[0]
  if (target) {
    await target.focus().catch(() => {})
    target.postMessage({ type: 'NAVIGATE_TO_NOTIFICATION', data, url })
    return
  }
  return self.clients.openWindow(url)
}

// Swipe-away also lands here.
self.addEventListener('notificationclose', (event) => {
  event.waitUntil(updateBadgeCount())
})

// An open window sets the badge to its unread count; the displayed-notification
// count stands in only while no window exists.
async function updateBadgeCount() {
  try {
    if ((await windowClients()).length > 0) return
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

// Messages -------------------------------------------------------------------

self.addEventListener('message', (event) => {
  const message = event.data || {}
  switch (message.type) {
    case 'SKIP_WAITING':
      // Sole path to activation; the install handler never skips waiting.
      self.skipWaiting()
      break
    case 'GET_VERSION':
      event.ports[0]?.postMessage({ version: SW_VERSION, updated: new Date().toISOString() })
      break
    case 'SHOW_NOTIFICATION':
      // The app's own system notification, deduplicated against pushes by id. The
      // reply tells the page this worker handled it.
      if (message.title && message.options) {
        event.waitUntil(showOnce(message.title, message.options)
          .catch((error) => console.error('Service Worker: Error showing notification:', error))
          .finally(() => event.ports?.[0]?.postMessage({ handled: true })))
      }
      break
    case 'DISMISS_NOTIFICATIONS':
      event.waitUntil(handleDismissNotifications(message))
      break
    case 'TAKE_PENDING_READS':
      event.waitUntil(takePendingReads(event))
      break
    case 'PREFETCH_CRITICAL':
    case 'UPDATE_NOTIFICATION_SETTINGS':
    case 'CLEAR_NOTIFICATIONS':
      break
    default:
      console.log('Service Worker: Unknown message type:', message.type)
  }
})

// Replies on event.ports[0] with the queued ids and forgets them.
async function takePendingReads(event) {
  const port = event.ports && event.ports[0]
  let ids = []
  try {
    const cache = await caches.open(NOTIF_STATE_CACHE)
    const keys = (await cache.keys()).filter((request) => request.url.includes('__notif/read/'))
    ids = keys.map((request) => decodeURIComponent(new URL(request.url).pathname.split('/').pop()))
    await Promise.all(keys.map((request) => cache.delete(request)))
  } catch (e) {
    ids = []
  }
  if (port) port.postMessage({ ids })
}

// Matches by notification id, tag, conversation or channel; `all` closes everything.
async function handleDismissNotifications(criteria) {
  try {
    const ids = new Set(criteria.notificationIds || (criteria.notificationId ? [criteria.notificationId] : []))
    const notifications = await self.registration.getNotifications()
    let dismissed = 0

    for (const notification of notifications) {
      const id = notificationIdOf(notification.data)
      const matches = criteria.all === true ||
        (id && ids.has(id)) ||
        (criteria.tag && notification.tag === criteria.tag) ||
        (criteria.conversationId && notification.tag?.includes(`conv-${criteria.conversationId}`)) ||
        (criteria.channelId && notification.tag?.includes(`ch-${criteria.channelId}`)) ||
        (Array.isArray(criteria.keepIds) && id && !criteria.keepIds.includes(id))

      if (matches) {
        notification.close()
        dismissed++
      }
    }

    if (dismissed > 0) await updateBadgeCount()
  } catch (error) {
    console.error('Service Worker: Error dismissing notifications:', error)
  }
}

// Helper functions
function getNotificationActions(type) {
  const baseActions = [
    { action: 'mark_read', title: 'Mark as read' },
    { action: 'dismiss', title: 'Dismiss' }
  ]

  if (type === 'dm' || type === 'chat_message' || type === 'mention' || type === 'reply') {
    baseActions.unshift({
      action: 'reply',
      title: 'Reply',
      type: 'text',
      placeholder: 'Type a reply...'
    })
  }

  return baseActions
}

function getVibrationPattern(type) {
  switch (type) {
    case 'mention':
    case 'dm':
    case 'chat_message':
      return [300, 100, 300, 100, 300]
    case 'reply':
    case 'thread_reply':
      return [200, 100, 200, 100, 200]
    case 'reaction':
      return [150, 50, 150]
    default:
      return [200, 100, 200]
  }
}

function getDefaultTitle(type) {
  switch (type) {
    case 'mention': return 'You were mentioned'
    case 'dm':
    case 'chat_message': return 'New message'
    case 'reaction': return 'Someone reacted'
    case 'reply':
    case 'thread_reply': return 'New reply'
    case 'server_invite': return 'Server invitation'
    case 'voice_channel_activity': return 'Voice activity'
    default: return 'Harmony'
  }
}

// Payloads from this backend carry `url`; the id-based fallback covers payloads
// queued by an older backend. Only same-origin paths are opened.
function getNavigationUrl(data) {
  const origin = self.location.origin

  if (data.url) {
    try {
      const target = new URL(data.url, origin)
      if (target.origin === origin) return target.href
    } catch (e) {
      // Malformed url; fall through to the ids.
    }
  }

  const query = data.message_id ? `?messageId=${encodeURIComponent(data.message_id)}` : ''
  if (data.conversation_id) return `${origin}/dm/${data.conversation_id}${query}`
  if (data.server_id && data.thread_id) return `${origin}/chat/${data.server_id}/thread/${data.thread_id}${query}`
  if (data.server_id && data.channel_id) return `${origin}/chat/${data.server_id}/${data.channel_id}${query}`
  if (data.post_id) return `${origin}/social/post/${data.post_id}`
  return `${origin}/chat`
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

// Install and activate listeners are at the top of the file.

// Supabase imgproxy render URLs for storage-backed images. Scoped to known
// buckets; broader matching reintroduces the avatar fetch loop.
function isStorageTransformRequest(url) {
  return /\/storage\/v1\/render\/image\/public\/(emojis|avatars|server_icons|server_banners|user_media)\//.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  // Only GET responses are cached. Intercepting other methods gains nothing and puts them
  // under the 5 s API timeout below, which turns a slower POST into a synthetic 503.
  if (event.request.method !== 'GET') {
    return
  }

  // Non-http schemes (chrome-extension:, blob:) are not cacheable.
  const requestUrl = new URL(event.request.url)
  if (!requestUrl.protocol.startsWith('http')) {
    return
  }

  // /assets/emojis/ SVG and JSON are immutable: cache-first.
  if (requestUrl.origin === self.location.origin &&
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

  // Same-origin only; cross-origin interception loops on avatars. Compared by
  // origin: a backend on the same host and another port is cross-origin.
  if (requestUrl.origin !== self.location.origin) {
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
    
    if (networkResponse.status === 200 && networkResponse.ok) {
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
