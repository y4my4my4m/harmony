# Push Notifications

Harmony delivers notifications to closed apps through three transports, all sent by the federation backend:

| Transport | Clients | Server needs |
|---|---|---|
| Web Push | Browsers and the installed PWA: desktop, Android, and iOS/iPadOS 16.4+ when added to the home screen | A VAPID key pair |
| UnifiedPush | The Android app, through a distributor app (ntfy, NextPush, ...) | The same VAPID key pair: distributors accept Web Push |
| FCM | The Android app on a device with Google Play Services | A Firebase service account of the project the app build carries |

Push needs HTTPS. The web app needs no push setting: it fetches the public key from `GET /api/federation/push/vapid-key`.

## Setup

### Self-host stack

`self-host/configure.sh` generates the VAPID key pair once, writes it to `self-host/federation.env`, and sets `VAPID_SUBJECT` to the admin email. Nothing else is required for Web Push and UnifiedPush.

The pair never rotates. Every subscription is bound to the public key that created it; a new pair leaves every existing subscription undeliverable until each device subscribes again. `federation.env` is part of `harmony backup`.

### Manual setup

```bash
cd federation-backend
npx web-push generate-vapid-keys
```

In `federation-backend/.env`:

```env
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=admin@example.com
```

`VAPID_SUBJECT` takes `admin@example.com` or `mailto:admin@example.com`; it must be an email address, and push services use it as the contact. The server and the worker both read the keys: the server answers `/vapid-key` and stores subscriptions, the worker sends. Restart both after a change.

The reverse proxy forwards `/api/federation/` to the backend with the prefix stripped (`location /api/federation/ { proxy_pass http://localhost:3001/; }`).

### FCM (Android app)

Set one of, in `federation.env` (or `federation-backend/.env`):

- `FCM_SERVICE_ACCOUNT_JSON`: the service account JSON from Firebase console, Project settings, Service accounts, raw or base64
- `FCM_SERVICE_ACCOUNT_FILE`: a path to that file. The self-host compose file mounts no file into the federation containers, so the self-host stack uses `FCM_SERVICE_ACCOUNT_JSON`

An FCM token belongs to one Firebase project. FCM reaches only an app build whose `google-services.json` names the same project as the service account; an instance whose users run another build relies on UnifiedPush. With FCM configured, the log shows `FCM enabled for project <id>` and `GET /api/federation/push/status` reports `"fcm": true`. [Android push](./DEVELOPMENT.md#android-push) covers the Firebase project and the app side.

### UnifiedPush distributor on the LAN

The backend refuses push endpoints on private, loopback and link-local addresses. `PUSH_ALLOW_PRIVATE_ENDPOINTS=true` accepts them, for a self-hosted distributor reachable only on the local network.

## Delivery

1. Inserting an unread row into `notifications` queues a `send-push-notification` job (`trigger_send_push_notification`).
2. The federation worker takes the job and decides whether to push. It skips the push when:
   - the user's preferences turn push off (`push_notifications`), or the toggle for that notification type
   - quiet hours are on (`dnd_enabled`, between `dnd_start_time` and `dnd_end_time`, UTC)
   - the user's status is Do Not Disturb
   - one of the user's devices is viewing the notification's channel or conversation
   - `push_offline_only` is on (the default) and one of the user's devices is active. Security notifications push regardless
3. It sends to every push target of the user: Web Push and UnifiedPush through `web-push`, FCM through the HTTP v1 API.

A device is active when its row in `device_view_contexts` was written in the last 150 seconds and is not `away`. The web app rewrites its view context every 60 seconds while the tab is visible, and writes `away` when the tab hides or goes idle.

With `USE_BULLMQ_QUEUE=false`, the worker's Realtime listener on `notifications` makes the same decision.

The payload carries the notification id, type, target URL and routing ids; the service worker (`public/service-worker.js`) renders it and opens the target on click. Reading a notification elsewhere closes it on the Android app (`dismiss-push-notifications` job); browsers keep theirs, as Web Push requires each push to show a notification.

An endpoint answering 404 or 410, and an FCM token Firebase rejects, are deleted at once. Other failures are counted on the row (`failure_count`, `last_failure_reason`). Push targets registered from a session are deleted with that session (Settings, Sessions).

## Client setup

- **Browsers and the PWA**: Settings, Notifications enables push; the browser asks for permission and the subscription is stored. The same page sends a test push.
- **iOS and iPadOS**: Web Push works only in the installed app. In Safari, Share, Add to Home Screen; open Harmony from the home screen, then enable push in Settings, Notifications.
- **Android app**: Settings, Notifications chooses FCM or UnifiedPush per device.

## API

Mounted at `/push` and `/api/federation/push` on the federation backend. Every route except `vapid-key`, `status` and `resubscribe` requires `Authorization: Bearer <Supabase access token>` and acts for that user.

| Route | Body | Effect |
|---|---|---|
| `GET /vapid-key` | | `{ publicKey }`, or 503 without VAPID keys |
| `GET /status` | | `{ available, configured, fcm, unifiedpush }` |
| `POST /subscribe` | `{ subscription, deviceName?, previousEndpoint?, transport? }` | Stores a Web Push (`webpush`) or UnifiedPush (`unifiedpush`) subscription |
| `POST /resubscribe` | `{ oldEndpoint, oldAuth, subscription }` | Replaces a subscription after `pushsubscriptionchange`; called by the service worker without a session |
| `POST /unsubscribe` | `{ endpoint }` | Removes this user's subscription |
| `POST /fcm/register` | `{ token, previousToken?, deviceName? }` | Stores an FCM token for this user |
| `POST /fcm/unregister` | `{ token }` | Removes it |
| `GET /subscriptions` | | The user's push targets |
| `DELETE /subscriptions/:id` | | Removes one |
| `POST /test` | `{ endpoint? }` or `{ fcmToken? }` | Sends a test push to that target, or to every device |

Write routes other than `/test` are rate limited.

## Database

`push_subscriptions` holds every push target:

| Column | Meaning |
|---|---|
| `user_id` | Profile |
| `transport` | `webpush`, `unifiedpush` or `fcm` |
| `endpoint` | Push service URL; the registration token for `fcm` |
| `p256dh`, `auth` | Web Push encryption keys; null for `fcm` |
| `session_id` | Auth session that registered it |
| `user_agent`, `device_name` | Device description |
| `last_successful_push`, `failure_count`, `last_failure_at`, `last_failure_reason` | Delivery state |

`(user_id, endpoint)` is unique, and an FCM token is unique across accounts. Notification preferences live in `notification_preferences`; view contexts in `device_view_contexts`.

## Troubleshooting

| Symptom | Check |
|---|---|
| The enable switch fails | `GET /api/federation/push/vapid-key` answers 503: the backend has no VAPID keys |
| Subscribed, nothing arrives | The worker runs and logs the job; `push_notifications` is on; the user is not active on another device with `push_offline_only` |
| Pushes stopped for everyone | The VAPID pair changed; devices must subscribe again |
| A LAN distributor is refused | `PUSH_ALLOW_PRIVATE_ENDPOINTS=true` |
| Android FCM never delivers | `"fcm": true` in `/push/status`, and the service account belongs to the app build's Firebase project |
| iOS shows no option | The app is opened from the home screen, on iOS 16.4 or later |
