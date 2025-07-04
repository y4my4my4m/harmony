// Enhanced Service Worker for Discord-like Notifications
// Version: 2.0 - Professional notification handling

const CACHE_NAME = 'harmony-v2'
const NOTIFICATION_CACHE = 'harmony-notifications-v1'

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
      actions: getNotificationActions(data.type, data.data),
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
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Check if Harmony is already open
      const harmonyClient = clients.find(client => 
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
function getNotificationActions(type, data) {
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

// Cache management
self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker: Installing...')
  
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        '/',
        '/harmony_icon1.png',
        '/manifest.json'
      ])
    })
  )
  
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker: Activated')
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME && cacheName !== NOTIFICATION_CACHE) {
            console.log('🗑️ Service Worker: Deleting old cache:', cacheName)
            return caches.delete(cacheName)
          }
        })
      )
    })
  )
  
  self.clients.claim()
})

// Enhanced fetch handling with offline support
self.addEventListener('fetch', (event) => {
  // Only handle same-origin requests
  if (!event.request.url.startsWith(self.location.origin)) {
    return
  }

  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).catch(() => {
        // Return offline fallback for important resources
        if (event.request.destination === 'document') {
          return caches.match('/')
        }
        return new Response('Offline', { status: 503 })
      })
    })
  )
})

// Handle messages from main thread
self.addEventListener('message', (event) => {
  console.log('📧 Service Worker: Message received', event.data)
  
  switch (event.data.type) {
    case 'SKIP_WAITING':
      self.skipWaiting()
      break
    case 'CLEAR_NOTIFICATIONS':
      clearStoredNotifications()
      break
    case 'UPDATE_NOTIFICATION_SETTINGS':
      updateNotificationSettings(event.data.settings)
      break
    default:
      console.log('⚠️ Service Worker: Unknown message type:', event.data.type)
  }
})

async function clearStoredNotifications() {
  try {
    const cache = await caches.open(NOTIFICATION_CACHE)
    const requests = await cache.keys()
    
    await Promise.all(
      requests.map(request => cache.delete(request))
    )
    
    console.log('🧹 Service Worker: Cleared stored notifications')
  } catch (error) {
    console.error('❌ Service Worker: Error clearing notifications:', error)
  }
}

function updateNotificationSettings(settings) {
  // Store notification settings for use in push handling
  self.notificationSettings = settings
  console.log('⚙️ Service Worker: Updated notification settings:', settings)
}

console.log('🚀 Service Worker: Script loaded successfully')
