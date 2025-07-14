// Enhanced Service Worker for Discord-like Notifications and PWA Features
// Version: 3.1 - Improved update handling and caching strategies

const CACHE_NAME = 'harmony-v3'
const NOTIFICATION_CACHE = 'harmony-notifications-v1'
const STATIC_CACHE = 'harmony-static-v1'
const API_CACHE = 'harmony-api-v1'

// Cache strategies
const STATIC_RESOURCES = [
  '/',
  '/manifest.json',
  '/harmony_icon1.png',
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
    }).then(() => {
      // Skip waiting to activate immediately
      return self.skipWaiting()
    })
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
      // Take control of all clients
      return self.clients.claim()
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
    const notificationOptions = {
      body: data.message || data.body,
      icon: data.data?.avatar_url || '/harmony_icon1.png',
      badge: '/harmony_icon1.png',
      tag: `harmony-${data.type}-${data.data?.user_id || 'unknown'}`,
      data: data.data || {},
      requireInteraction: data.type === 'mention' || data.type === 'dm',
      silent: false,
      timestamp: Date.now(),
      actions: getNotificationActions(data.type),
      image: data.data?.image_url,
      vibrate: getVibrationPattern(data.type)
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

// Enhanced fetch handling with offline support
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

  // Enhanced request categorization (images are skipped above)
  const url = new URL(event.request.url)
  const isAPIRequest = url.pathname.startsWith('/api/')
  const isAuthRequest = url.pathname.includes('/auth/')
  const isCSSRequest = url.pathname.endsWith('.css')
  const isJSRequest = url.pathname.endsWith('.js')

  if (isAPIRequest || isAuthRequest) {
    // Critical API requests - network first with enhanced error handling
    event.respondWith(enhancedNetworkFirst(event.request, API_CACHE))
  } else if (isCSSRequest || isJSRequest) {
    // Static assets - stale while revalidate
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE))
  } else {
    // HTML pages - network first with offline fallback
    event.respondWith(enhancedNetworkFirst(event.request, CACHE_NAME))
  }
})

// Enhanced caching strategies
async function enhancedNetworkFirst(request, cacheName) {
  try {
    const networkResponse = await fetch(request)
    
    if (networkResponse.status === 200 && networkResponse.ok) {
      const cache = await caches.open(cacheName)
      // Clone response before caching
      const responseClone = networkResponse.clone()
      cache.put(request, responseClone).catch(err => {
        console.warn('Failed to cache response:', err)
      })
    }
    
    return networkResponse
  } catch (error) {
    console.log('🌐 Service Worker: Network failed, trying cache:', error.message)
    
    const cachedResponse = await caches.match(request)
    if (cachedResponse) {
      return cachedResponse
    }
    
    // Enhanced offline fallback
    if (request.destination === 'document') {
      const offlineResponse = await caches.match('/offline.html')
      if (offlineResponse) {
        return offlineResponse
      }
      
      // Create a simple offline page if none exists
      return new Response(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Harmony - Offline</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: #1e1f22; 
                color: white; 
                text-align: center; 
                padding: 50px 20px;
                margin: 0;
              }
              .offline-container {
                max-width: 400px;
                margin: 0 auto;
              }
              .offline-icon {
                font-size: 48px;
                margin-bottom: 20px;
              }
              h1 { color: #5865f2; margin-bottom: 10px; }
              p { color: #b5bac1; line-height: 1.5; }
              button {
                background: #5865f2;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 16px;
                cursor: pointer;
                margin-top: 20px;
              }
            </style>
          </head>
          <body>
            <div class="offline-container">
              <div class="offline-icon">📱</div>
              <h1>You're Offline</h1>
              <p>Check your internet connection and try again.</p>
              <button onclick="window.location.reload()">Try Again</button>
            </div>
          </body>
        </html>
      `, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    }
    
    return new Response('Offline', { 
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
