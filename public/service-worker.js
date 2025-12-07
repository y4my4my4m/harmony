// Enhanced Service Worker for Discord-like Notifications and PWA Features
// Version: 3.2 - Mobile optimized to prevent aggressive reloading

const CACHE_NAME = 'harmony-v4-mobile'
const NOTIFICATION_CACHE = 'harmony-notifications-v2'
const STATIC_CACHE = 'harmony-static-v2'
const API_CACHE = 'harmony-api-v2'

// Cache strategies
const STATIC_RESOURCES = [
  '/',
  '/manifest.json',
  '/img/app_icon_square.webp',
  '/favicon/android-icon-192x192.png',
  '/src/main.ts',
  '/src/App.vue'
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
              cacheName !== NOTIFICATION_CACHE) {
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
self.addEventListener('push', async (event) => {
  console.log('🔔 Service Worker: Push event received', event)
  
  if (!event.data) {
    console.log('⚠️ Service Worker: No data in push event')
    return
  }

  try {
    const data = event.data.json()
    console.log('📨 Service Worker: Notification data:', data)

    // Discord-like notification logic
    // icon = colored icon for notification body (can be user avatar or app icon)
    // badge = small monochrome icon for status bar (must be white/transparent, 96x96)
    const notificationOptions = {
      body: data.message || data.body,
      // Use avatar if available, otherwise colored app icon for notification body
      icon: data.data?.avatar_url || data.icon || '/favicon/android-icon-192x192.png',
      // Badge should be monochrome white for Android status bar
      // Falls back to square icon if badge doesn't exist
      badge: '/img/app_icon_badge.png',
      tag: data.tag || `harmony-${data.type}-${data.data?.user_id || 'unknown'}`,
      data: data.data || {},
      requireInteraction: data.type === 'mention' || data.type === 'dm',
      silent: false,
      timestamp: Date.now(),
      actions: getNotificationActions(data.type),
      image: data.data?.image_url,
      vibrate: getVibrationPattern(data.type),
      // Non-standard: Accent color for Android (may not work on all browsers)
      // This is the equivalent of Android's setColor() but for web
      color: '#5865f2'
    }

    // Store notification for later retrieval
    await storeNotification(data)

    // Show notification with proper title
    const title = data.title || getDefaultTitle(data.type)
    
    event.waitUntil(
      self.registration.showNotification(title, notificationOptions)
    )

  } catch (error) {
    console.error('❌ Service Worker: Error handling push event:', error)
  }
})

// Enhanced notification click handling
self.addEventListener('notificationclick', async (event) => {
  console.log('🖱️ Service Worker: Notification clicked', event)
  
  event.notification.close()

  const data = event.notification.data
  const action = event.action

  // Handle notification actions
  if (action === 'reply' && (data.conversation_id || data.server_id)) {
    event.waitUntil(handleQuickReply(data))
    return
  }

  if (action === 'mark_read') {
    event.waitUntil(markAsRead(data))
    return
  }

  if (action === 'dismiss') {
    return // Just close the notification
  }

  // Default click behavior - navigate to the content
  const url = getNavigationUrl(data)
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Check if Harmony is already open
      const harmonyClient = clientList.find(client => 
        client.url.includes('localhost') || client.url.includes('harmony')
      )

      if (harmonyClient) {
        // Focus existing window and navigate
        return harmonyClient.focus().then(() => {
          return harmonyClient.postMessage({
            type: 'NAVIGATE_TO_NOTIFICATION',
            data: data,
            url: url
          })
        })
      } else {
        // Open new window
        return self.clients.openWindow(url)
      }
    })
  )
})

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
        version: '3.2',
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

  // Add type-specific actions
  if (type === 'dm' || type === 'mention' || type === 'reply') {
    baseActions.unshift({
      action: 'reply',
      title: 'Quick Reply',
      icon: '/icons/reply.png'
    })
  }

  return baseActions
}

function getVibrationPattern(type) {
  switch (type) {
    case 'mention':
      return [200, 100, 200] // Strong vibration for mentions
    case 'dm':
      return [150, 50, 150] // Medium vibration for DMs
    case 'reaction':
      return [100] // Light vibration for reactions
    default:
      return [100, 50, 100] // Default pattern
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
    return `${baseUrl}/dm/${data.conversation_id}`
  }

  if (data.server_id && data.channel_id) {
    let url = `${baseUrl}/servers/${data.server_id}/channels/${data.channel_id}`
    if (data.message_id) {
      url += `?message=${data.message_id}`
    }
    return url
  }

  if (data.server_id) {
    return `${baseUrl}/servers/${data.server_id}`
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

async function handleQuickReply(data) {
  try {
    // This would open a quick reply interface
    // For now, just navigate to the conversation
    const url = getNavigationUrl(data)
    return self.clients.openWindow(url)
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

async function processNotification(data) {
  // Implementation for processing individual notifications
  console.log('🔄 Service Worker: Processing notification:', data)
}

// Note: Install and activate event listeners are defined at the top of the file

// Enhanced fetch handling with offline support - Mobile optimized
self.addEventListener('fetch', (event) => {
  // Skip unsupported schemes
  const requestUrl = new URL(event.request.url)
  if (!requestUrl.protocol.startsWith('http')) {
    return
  }

  // Skip ALL image requests to prevent avatar loops
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
  
  // ✅ PERFORMANCE: Skip modulepreload requests to prevent duplicate fetches
  // The browser handles these efficiently, and intercepting causes duplicates
  const isModulePreload = event.request.headers.get('purpose') === 'modulepreload' ||
                          event.request.headers.get('X-Purpose') === 'modulepreload' ||
                          event.request.mode === 'cors' && event.request.credentials === 'omit' && isJSRequest

  // Only intercept specific types of requests
  if (isModulePreload) {
    // Let browser handle modulepreload requests naturally - don't intercept
    return
  } else if (isAPIRequest || isAuthRequest) {
    // Critical API requests - network first with enhanced error handling
    event.respondWith(enhancedNetworkFirst(event.request, API_CACHE))
  } else if (isCSSRequest || isJSRequest) {
    // Static assets - stale while revalidate (better for mobile)
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
    
    if (networkResponse.status === 200 && networkResponse.ok) {
      // Only cache if response is good and not too large (mobile friendly)
      const contentLength = networkResponse.headers.get('content-length')
      const isSmallResponse = !contentLength || parseInt(contentLength) < 1024 * 1024 // 1MB limit
      
      if (isSmallResponse) {
        const cache = await caches.open(cacheName)
        // Clone response before caching
        const responseClone = networkResponse.clone()
        cache.put(request, responseClone).catch(err => {
          console.warn('Failed to cache response:', err)
        })
      }
    }
    
    return networkResponse
  } catch (error) {
    console.log('🌐 Service Worker: Network failed, trying cache:', error.message)
    
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
    if (response.status === 200) {
      // Clone the response BEFORE using it
      const responseClone = response.clone()
      caches.open(cacheName).then(cache => {
        cache.put(request, responseClone)
      }).catch(err => {
        console.warn('Failed to cache response in background:', err)
      })
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

console.log('🚀 Service Worker: Script loaded successfully')
