---
title: Activities
description: Turn play-together activities on or off for an instance, and what the proxy needs to carry them.
---

# Activities

Activities are the multiplayer apps members start with **Play together** (see [Play together](/use/play-together)). This page is for instance admins and operators.

## Turn an activity on or off

**Admin** → **Activities** lists every activity this instance ships, with a switch each. Built-in activities start switched on. Turning one off ends its running sessions at once and hides it from every launcher.

| Activity | Players | Runs in |
| --- | --- | --- |
| DrawinPhone | 2–16 | DMs, groups, text channels, voice channels |

## Install an activity package

Besides the built-in activities, an admin can install packages: **Admin** → **Activities** → **Install an activity**, then choose a `.zip` or paste its `https://` address and select **Preview**. The preview shows the name, version, players, where it runs, its size and the package's SHA-256. **Install** stores exactly the previewed file; a package from an address that changed since the preview is refused. A new package starts switched off.

An installed package is served by this instance from its own copy, at `/api/federation/activities/pkg/<id>/<sha256>.js`; nothing is fetched from the author afterwards. **Check for update** previews the package at its address again. **Remove** ends its sessions and deletes it. An instance holds at most 50 packages.

A package runs in the same sandbox as a built-in. It is still code from its author running on your members' devices: install the ones you trust, as you would add a bot.

## What the proxy carries

Three paths serve activities. The bundled Caddy proxy (`self-host/Caddyfile`) carries all of them as installed.

| Path | Served by | Notes |
| --- | --- | --- |
| `/activities/index.json`, `/activities/<id>/…` | web container | The catalog and the built scripts. The catalog carries `Access-Control-Allow-Origin: *` for the desktop and mobile apps, and `Cache-Control: no-cache`; scripts are named by content hash and cached for a year. |
| `/api/federation/activities/frame/<id>` | federation backend | The sandboxed document each activity runs in. |
| `/api/federation/activities/socket` | federation backend | The relay, a WebSocket. |
| `/api/federation/activities/pkg/<id>/<sha256>.<ext>` | federation backend | Installed packages' scripts and icons, served sandboxed and cached for a year. |

Behind your own nginx, the relay needs a location that passes the WebSocket upgrade, ahead of the general `/api/federation/` location:

```nginx
location = /api/federation/activities/socket {
    proxy_pass http://localhost:3001/activities/socket;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
}
```

`dev/nginx-harmony.template.conf` in the repository holds this location and the two `/activities/` locations.

The frame names the web app as its only script source: the backend reads it from `APP_URL`, which defaults to `https://<INSTANCE_DOMAIN>`. Set `APP_URL` when the web app is served from another origin.

## Isolation

- Each activity runs in an `<iframe sandbox="allow-scripts allow-pointer-lock">`: an opaque origin with no access to the account's session, storage, messages or the page around it. The frame's own `Content-Security-Policy` repeats the sandbox, so the document stays isolated even when opened directly.
- The policy refuses every network connection (`connect-src 'none'`), form, popup, plugin and frame, and loads scripts, styles and images only from the activity's own folder.
- Players talk through the relay in the federation backend. The Harmony client holds the account's token and forwards what the activity sends after checking its size and rate; the activity never sees a token.
- The relay admits only accounts of this instance that belong to the conversation or channel (and, in a voice channel, are in the call). Every 30 seconds it checks each member's token and membership again and removes those who signed out or left. It limits each connection to 40 messages a second and 1 MB a second, counting a message once per recipient, and holds no game data after a session ends.
- A frame that navigates itself to another page is detached at once (Harmony's loader reports the document leaving) and receives nothing further.

What the sandbox cannot stop: an activity sees what its players send it and can pass that to any player, and browsers apply no content policy to WebRTC or DNS prefetching. Enable activities you trust, as you would install a bot.

## Limits

| Limit | Value |
| --- | --- |
| Message between players | 256 KB |
| Shared state | 64 KB |
| Host store | 8 MB, 1,024 keys, 256 KB a value |
| Connections | 5,000 per backend process, 24 per address, new ones at 1 a second per address (bursts of 20) |
| Sessions | 2,000 per backend process; host stores share 256 MB |
| Sessions started | 6 per account in 10 minutes |
| Idle session | ends 1 minute after its last player leaves; 3 minutes without the relay counts as ended |

A restart of the federation backend loses the game in progress: players reconnect on their own and start again from the activity's lobby.
