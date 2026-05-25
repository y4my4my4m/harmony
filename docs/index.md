---
layout: home

hero:
  name: "Harmony"
  text: "Federated Social Platform"
  tagline: "Modern chat and social networking with ActivityPub federation"
  image:
    src: /logo.png
    alt: Harmony Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/y4my4my4m/harmony

features:
  - icon: 💬
    title: Advanced Chat System
    details: Discord-like chat with servers, channels, voice/video calls, and real-time messaging
  - icon: 🌐
    title: ActivityPub Federation
    details: Connect with the fediverse - interact with Mastodon, Pleroma, and other ActivityPub platforms
  - icon: 🏗️
    title: Modern Architecture
    details: Built with Vue 3, TypeScript, Supabase, and professional development practices
  - icon: 📱
    title: Progressive Web App
    details: Mobile-first design with offline support and push notifications
  - icon: 🔒
    title: Privacy Focused
    details: Self-hostable with comprehensive privacy controls and data ownership
  - icon: ⚡
    title: Real-time Everything
    details: Live updates for messages, reactions, presence, and social interactions
---

## What is Harmony?

Harmony is a modern federated social platform that combines the best of Discord-style chat with ActivityPub social networking. It's designed for communities that want rich communication features while maintaining connection to the broader fediverse.

## Key Features

### 🚀 **Chat System**
- **Servers & Channels**: Organize conversations like Discord
- **Voice & Video**: Built-in WebRTC calling
- **Rich Media**: File sharing, emojis, reactions
- **Direct Messages**: Private conversations

### 🌍 **Federation**
- **ActivityPub Protocol**: Full fediverse compatibility
- **Cross-Platform Interaction**: Follow users from Mastodon, reply to posts
- **Instance Management**: Run your own federated instance
- **Content Discovery**: Explore trending content across instances

### 🛠️ **Technical Excellence**
- **Vue 3 + TypeScript**: Modern, type-safe frontend
- **Supabase Backend**: Real-time database with auth
- **Professional Architecture**: Clean, scalable, maintainable code
- **Comprehensive Documentation**: Everything you need to contribute

## Quick Start

```bash
# Clone the repository
git clone https://github.com/y4my4my4m/harmony.git

# Install dependencies
cd harmony
npm install

# Setup environment
cp .env.example .env.local
# Edit .env.local with your Supabase credentials

# Start development server
npm run dev
```

## Architecture Overview

Harmony follows modern software architecture principles:

- **Frontend**: Vue 3 with Composition API and TypeScript
- **State Management**: Pinia stores with reactive patterns
- **Backend**: Supabase (PostgreSQL + real-time subscriptions)
- **Federation**: ActivityPub protocol via Node.js federation backend
- **Real-time**: WebSocket subscriptions and WebRTC

## Community & Support

- **Documentation**: [Complete guide](/guide/)
- **API Reference**: [Developer docs](/api/)
- **GitHub**: [Source code & issues](https://github.com/y4my4my4m/harmony)
