---
title: Push notifications
description: Configure Web Push, UnifiedPush and Firebase Cloud Messaging on a self-hosted Harmony instance.
---

# Push notifications

This page is for operators. Push delivers notifications to devices where
Harmony is closed. The federation worker sends every push; this page covers
what the server needs for each transport and how to check it. How people turn
push on for their devices is in
[Notifications and apps](/use/notifications-apps).

## Transports

| Transport | Reaches | The server needs |
|---|---|---|
| Web Push | Browsers and the installed web app (PWA): desktop, Android, and iOS or iPadOS 16.4 and later when added to the home screen | A VAPID key pair |
| UnifiedPush | The Android app, through a distributor app the user installs | The same VAPID key pair |
| FCM | The Android app on a device with Google Play services | A Firebase service account of the project the app build was made with |
| FCM through a relay | The official Android app on a device with Google Play services, on any instance | The same VAPID key pair; the relay holds the Firebase service account |

The desktop app shows system notifications itself while it runs and needs no
server setting.

Push needs the instance on HTTPS: browsers offer Web Push only to secure
pages.

## Web Push and UnifiedPush

### On an installer-based instance

`configure.sh` generates the VAPID key pair on the first run and writes it to
`self-host/federation.env`, with `VAPID_SUBJECT` set to the admin email.
Nothing else is needed: Web Push and UnifiedPush work from the start.

```bash
VAPID_PUBLIC_KEY=BL...      # 87 characters, base64url
VAPID_PRIVATE_KEY=...       # 43 characters, base64url
VAPID_SUBJECT=admin@example.com
```

`VAPID_SUBJECT` follows the admin email: changing the email with
`harmony config` changes it too. Push services use it as the contact address.

::: warning
Never replace the key pair. Every browser and phone subscription is bound to
the public key that created it; a new pair leaves every existing
subscription undeliverable until each device subscribes again.
`configure.sh` keeps an existing pair, and `harmony backup` saves
`federation.env`.
:::

### On a manual deployment

Generate a pair:

```bash
cd federation-backend
npx web-push generate-vapid-keys
```

Put it in `federation-backend/.env`:

```bash
VAPID_PUBLIC_KEY=public-key
VAPID_PRIVATE_KEY=private-key
VAPID_SUBJECT=admin@example.com
```

`VAPID_SUBJECT` takes `admin@example.com` or `mailto:admin@example.com`. A
value that is not an email address stops the backend at start. Restart both
the server and the worker: the server hands out the public key and stores
subscriptions, the worker sends.

The web app needs no push setting. It fetches the public key from
`GET /api/federation/push/vapid-key`, so the reverse proxy must forward
`/api/federation/` to the backend.

### UnifiedPush distributors on your network

A UnifiedPush subscription is a URL on the distributor's push server, which
the backend posts to. The backend refuses URLs that are not `https` or that
resolve to private, loopback or link-local addresses, both when a device
registers and before each send.

For a distributor server reachable only on your local network, set in
`federation.env`:

```bash
PUSH_ALLOW_PRIVATE_ENDPOINTS=true
```

and apply it with `docker compose up -d`. This turns the address check off
for every endpoint.

## Firebase Cloud Messaging (Android)

FCM delivers to the Android app through Google Play services. A registration
token belongs to one Firebase project, so FCM reaches only an app build whose
`google-services.json` names the same Firebase project as the service account
the backend holds. Users whose app comes from another project's build, or
from a build without `google-services.json`, use UnifiedPush instead.

To use FCM with an app build you make yourself:

1. In the Firebase console, create a project and add an Android app with the
   package name `online.knowmad.harmony`. Download its `google-services.json`
   and build the app with it (it goes in `src-tauri/gen/android/app/`).
2. In the project settings, under service accounts, generate a private key.
   This downloads the service account JSON. Firebase Cloud Messaging API (V1)
   must be enabled for the project.
3. Give the backend the service account. In the self-host stack, put it in
   `federation.env` as base64 on one line:

   ```bash
   echo "FCM_SERVICE_ACCOUNT_JSON=$(base64 -w 0 service-account.json)" >> /opt/harmony/self-host/federation.env
   cd /opt/harmony/self-host && docker compose up -d
   ```

| Variable | What it holds |
|---|---|
| `FCM_SERVICE_ACCOUNT_JSON` | The service account JSON, raw or base64 |
| `FCM_SERVICE_ACCOUNT_FILE` | A path to that file inside the container. The self-host stack mounts no file into the federation containers, so use `FCM_SERVICE_ACCOUNT_JSON` there |

`FCM_SERVICE_ACCOUNT_JSON` wins when both are set. Without either, FCM is
off and the Android app offers UnifiedPush only. With FCM configured, the
backend logs `FCM enabled for project` followed by the project id.

## The push relay (official Android app)

An FCM token works only with the service account of the app build's Firebase
project, and that account is never handed out: it could push to every install.
An instance without it still reaches the official app through the relay that
the app's publisher runs:

1. The app asks the relay's `/api/federation/push/status` whether it forwards
   for the app's Firebase project (`relay: true` and a matching `fcmProject`).
2. It subscribes on your instance as an ordinary UnifiedPush device, with the
   endpoint `https://<relay>/api/federation/push/relay/fcm/<FCM token>` and
   Web Push keys the app made.
3. Your worker encrypts each notification to those keys (RFC 8291) and signs
   the request with your VAPID key, as for any UnifiedPush distributor.
4. The relay checks the VAPID signature, forwards the ciphertext through FCM
   unread, and the app decrypts it.

Your instance needs nothing beyond its VAPID key pair. The relay learns the
device's FCM token, your instance's VAPID public key, and the size and time of
each message, not its content. It limits each sending key and each device, and
answers 413 for a message over 3060 bytes; the worker keeps app payloads below
that. Where your instance holds the service account of the app's own project,
the app uses FCM directly and the relay is not involved.

To run a relay for an app you build yourself: give the instance the build's
FCM service account, set `PUSH_RELAY_ENABLED=true` in `federation.env`, and
build the app with `VITE_PUSH_RELAY_ORIGIN` set to that instance's https
origin.

## Check push

`harmony doctor` reports push in its **Services** section. It passes when
`federation.env` holds a complete key pair and a subject, and the backend
serves that public key at `/api/federation/push/vapid-key`.

The public status route shows which transports the instance offers:

```bash
curl https://chat.example.com/api/federation/push/status
```

```json
{ "available": true, "configured": true, "fcm": false, "unifiedpush": true, "fcmProject": null, "relay": false }
```

| Field | Means |
|---|---|
| `available` | At least one transport works |
| `configured` | The VAPID key pair is set (Web Push) |
| `unifiedpush` | Same as `configured` |
| `fcm` | A valid FCM service account is loaded |
| `fcmProject` | That account's Firebase project; the app uses FCM directly only when its own project matches |
| `relay` | This instance relays Web Push to FCM for its app build (`PUSH_RELAY_ENABLED=true` and an FCM service account) |

To send a real notification, open **User settings** → **Notifications** on a
device with push turned on and select **Test push**.

| Symptom | Look at |
|---|---|
| Turning push on fails in the browser | `/api/federation/push/vapid-key` answers 503: the backend has no VAPID keys |
| Pushes stopped on every device at once | The VAPID key pair changed; devices must subscribe again |
| Subscribed, nothing arrives | `harmony logs federation-worker`: the worker sends every push. A user active on another device gets no push by default |
| A distributor on the LAN is refused | `PUSH_ALLOW_PRIVATE_ENDPOINTS=true` |
| Android FCM never delivers | `"fcm": true` in `/push/status`, and the service account belongs to the app build's Firebase project |
| The official app gets nothing on an instance without FCM | `"unifiedpush": true` on the instance, `"relay": true` on the relay's `/push/status`, and `harmony logs federation-worker` for the relay's answer (401 VAPID, 413 size, 429 limit) |

A push endpoint that answers 404 or 410, and an FCM token Firebase rejects,
are deleted from `push_subscriptions` at once. Other failures are counted on
the subscription row (`failure_count`, `last_failure_reason`).
