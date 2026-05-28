# Push Notifications Setup

This document explains how to set up native push notifications for the Harmony PWA on iOS, Android, and desktop browsers.

## Overview

Harmony uses the Web Push API with VAPID (Voluntary Application Server Identification) for authentication. This enables:

- **Android**: Full push notification support via Chrome, Firefox, or any modern browser
- **iOS 16.4+**: Push notifications when the PWA is installed to the home screen
- **Desktop**: Chrome, Firefox, Edge, and Safari support

## Prerequisites

1. HTTPS is required (push notifications only work over secure connections)
2. Service worker must be registered (already configured in Harmony)
3. VAPID keys must be generated and configured

## Setup Instructions

### 1. Generate VAPID Keys

Run this command in the `federation-backend` directory:

```bash
cd federation-backend
npx web-push generate-vapid-keys
```

This will output something like:

```
=======================================

Public Key:
BPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

Private Key:
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

=======================================
```

### 2. Configure Environment Variables

Add these to your `federation-backend/.env` file:

```bash
# Web Push (VAPID) Configuration
# Generate with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=BPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
VAPID_PRIVATE_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
VAPID_SUBJECT=admin@yourdomain.com
```

**Important**: 
- `VAPID_PUBLIC_KEY` - The public key from the generator
- `VAPID_PRIVATE_KEY` - The private key (keep this secret!)
- `VAPID_SUBJECT` - Must be an email address (used for identification)

### 3. Configure Frontend

Add the VAPID public key to your frontend environment. In your `.env` file:

```bash
VITE_FEDERATION_BACKEND_URL=https://your-federation-backend.com
```

The frontend will automatically fetch the VAPID public key from the backend.

### 4. Apply Database Migration

Run the SQL migration to create the `push_subscriptions` table:

```sql
-- Located at: db_schema/improvements/push_subscriptions.sql
\i db_schema/improvements/push_subscriptions.sql
```

Or copy the contents and run in your Supabase SQL editor.

### 5. Restart Services

```bash
# Restart federation-backend
cd federation-backend
npm run dev
```

## How It Works

### Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│   Browser/PWA   │────▶│  Federation Backend │────▶│  Push Service    │
│  (Harmony App)  │     │  (push.ts routes)   │     │  (FCM/APNs/etc)  │
└─────────────────┘     └─────────────────────┘     └──────────────────┘
        │                         │
        │ Heartbeats              │ Check active sessions
        ▼                         ▼
┌─────────────────┐     ┌─────────────────────┐
│ Session Tracker │────▶│    user_sessions    │
│ (30s heartbeat) │     │    (Supabase DB)    │
└─────────────────┘     └─────────────────────┘
        │                         │
        ▼                         ▼
┌─────────────────┐     ┌─────────────────────┐
│ Service Worker  │     │  push_subscriptions │
│ (handles push)  │     │    (Supabase DB)    │
└─────────────────┘     └─────────────────────┘
```

### Smart Push (Discord-like Behavior)

Harmony uses intelligent push notification delivery just like Discord:

1. **If you're active on the website/app** → No push notifications sent
2. **If you're looking at the specific channel/conversation** → No push for that context
3. **If you're offline/away** → Push notifications delivered to mobile/other devices

This is achieved through:
- **Session Heartbeats**: Every 30 seconds, active sessions send a heartbeat
- **View Context Tracking**: Your current channel/conversation is tracked
- **Smart Filtering**: Before sending push, backend checks if user has active sessions

### Flow

1. **User enables push notifications** in Settings > Notifications
2. **Browser requests permission** and creates a subscription
3. **Subscription is sent to backend** and stored in `push_subscriptions` table
4. **Session heartbeat starts** tracking activity and current view context
5. **When a notification is created**, the backend's `PushNotificationHandler`:
   - Checks if user has any active sessions (heartbeat within 90 seconds)
   - Checks if user is viewing the notification's context (channel/DM)
   - Only sends push if user is NOT actively using the app
6. **Service Worker receives push** and displays native notification

### Notification Types Supported

- Direct Messages (DMs)
- Mentions (@username)
- Replies
- Reactions
- Friend Requests
- Server Invites
- ActivityPub notifications (follows, favorites, reblogs, mentions)

## iOS-Specific Notes

### Requirements for iOS Push

1. **iOS 16.4 or later** is required
2. **PWA must be installed** to home screen (Safari > Share > Add to Home Screen)
3. Push notifications **only work when launched from home screen**, not in Safari

### Installing the PWA on iOS

1. Open Harmony in Safari on iPhone/iPad
2. Tap the Share button (rectangle with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add" to confirm
5. Open the app from your home screen
6. Go to Settings > Notifications and enable push notifications

## Troubleshooting

### "Push notifications not supported"

- Check browser compatibility (needs Chrome 50+, Firefox 44+, Safari 16.4+)
- On iOS, ensure you're using the installed PWA, not Safari

### "Permission denied"

- User blocked notifications - must be enabled in browser/OS settings
- On iOS: Settings > Notifications > Harmony

### "Failed to subscribe"

- Check if VAPID keys are correctly configured
- Ensure federation-backend is reachable
- Check browser console for detailed errors

### No notifications received

1. Verify subscription exists in `push_subscriptions` table
2. Check federation-backend logs for push send attempts
3. Verify `notification_preferences` has `push_notifications = true`
4. Check if `push_offline_only` is enabled and user is online

## API Endpoints

### GET /push/vapid-key
Returns the VAPID public key for frontend subscription.

### GET /push/status
Returns push notification availability status.

### POST /push/subscribe
Subscribe a device to push notifications.
- Requires: `Authorization: Bearer <token>`
- Body: `{ subscription: PushSubscription, deviceName?: string }`

### POST /push/unsubscribe
Remove a push subscription.
- Requires: `Authorization: Bearer <token>`
- Body: `{ endpoint: string }`

### GET /push/subscriptions
Get all subscriptions for authenticated user.
- Requires: `Authorization: Bearer <token>`

### DELETE /push/subscriptions/:id
Delete a specific subscription.
- Requires: `Authorization: Bearer <token>`

### POST /push/test
Send a test push notification.
- Requires: `Authorization: Bearer <token>`

## Database Schema

### user_sessions (Smart Push Tracking)

Tracks active sessions for Discord-like push behavior:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | References profiles(id) |
| session_token | TEXT | Unique session identifier |
| platform | TEXT | 'ios', 'android', 'windows', 'macos', 'linux', 'chromeos', 'web' |
| form_factor | TEXT | 'mobile', 'tablet', 'desktop' |
| is_pwa | BOOLEAN | Whether running as installed PWA |
| browser | TEXT | Browser name |
| last_heartbeat | TIMESTAMPTZ | Last heartbeat timestamp |
| is_active | BOOLEAN | Whether session is active |
| current_server_id | UUID | Currently viewing server |
| current_channel_id | UUID | Currently viewing channel |
| current_conversation_id | UUID | Currently viewing DM |

### push_subscriptions (Device Subscriptions)

The `push_subscriptions` table stores:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| user_id | UUID | References profiles(id) |
| endpoint | TEXT | Push service URL |
| p256dh | TEXT | Public encryption key |
| auth | TEXT | Authentication secret |
| user_agent | TEXT | Browser/device info |
| device_name | TEXT | User-friendly device name |
| created_at | TIMESTAMPTZ | Subscription created |
| last_successful_push | TIMESTAMPTZ | Last successful push |
| failure_count | INTEGER | Consecutive failures |

## Security Considerations

1. **VAPID private key** should never be exposed to clients
2. **Subscriptions are scoped** to user via RLS policies
3. **Stale subscriptions** are automatically cleaned up after repeated failures
4. **Rate limiting** is applied to push API endpoints

## Testing

1. Enable push notifications in Settings
2. Click "Test Push" button
3. Should receive a test notification on device
4. If on mobile, ensure app is in background to see notification

## Future Improvements

- [ ] Push notification grouping (collapse multiple notifications)
- [ ] Per-server/channel push preferences
- [ ] Rich push notifications with images
- [ ] Push notification sound customization
- [ ] Web push analytics and delivery tracking

