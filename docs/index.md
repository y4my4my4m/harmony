---
layout: home

hero:
  name: "Harmony"
  text: "Federated chat and social, in one app"
  tagline: "Discord-style servers and DMs with ActivityPub federation"
  image:
    src: /logo.png
    alt: Harmony Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: Source on GitHub
      link: https://github.com/y4my4my4m/harmony

features:
  - icon: 💬
    title: Chat
    details: Discord-style servers, channels, DMs, threads, plus voice and video calls.
  - icon: 🌐
    title: Federation
    details: ActivityPub-compatible - federate with Mastodon, Pleroma, and other instances. Members from multiple Harmony instances can co-exist in one server.
  - icon: 🔒
    title: End-to-end encryption
    details: Megolm-style per-room session keys, recovery-key backup, cross-device key sharing.
  - icon: 📱
    title: Web and desktop
    details: Same codebase as a Vite web app and a Tauri desktop app. PWA support for mobile install.
  - icon: 🛠️
    title: Self-hostable
    details: Supabase + a Node federation backend. See the self-hosting guide for a one-command install.
  - icon: ⚡
    title: Realtime
    details: Live messages, reactions, presence, typing, voice state - broadcast via three core channels (per-user, per-server-structure, per-server-presence).
---

## What is Harmony?

Harmony is a federated social app. It looks like Discord (servers, channels, DMs, voice) and talks like Mastodon (ActivityPub), so the same account can post into a private server, into a public timeline, and across the wider fediverse.

## Quick start

```bash
git clone https://github.com/y4my4m/harmony.git
cd harmony
npm install
cp .env.example .env
# fill in Supabase URL + anon key + instance domain
npm run dev
```

Federation backend (optional for chat-only dev):

```bash
cd federation-backend
npm install
cp env.template .env
npm run dev
```

## What's under the hood

- Vue 3 (Composition + Options API), Pinia, Vite, TypeScript
- Supabase (Postgres + RLS, auth, realtime, storage)
- Node.js federation service (`federation-backend/`) for ActivityPub
- Tauri (`src-tauri/`) for the desktop builds
- Megolm-style E2EE (`src/services/encryption/`)

## More

- [Architecture overview](/guide/architecture/)
- [Self-hosting](./self-hosting.md)
- [Bot API](./bot-api.md)
- [Federation](./FEDERATION.md)
- [E2EE](./E2EE_IMPLEMENTATION.md)
