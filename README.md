# 🎵 Harmony - Federated Social Platform

A modern, federated social platform combining Discord-like servers with ActivityPub federation, built with Vue 3 and Supabase.

## ✨ Features

### 🏠 **Local-First Social Platform**
- **Posts & Timeline**: Create posts, follow users, build your personalized timeline
- **Discord-like Servers**: Real-time messaging in organized channels with voice chat
- **Direct Messages**: Private conversations with rich content support
- **Reactions & Interactions**: Custom emoji reactions on messages and posts

### 🌐 **ActivityPub Federation** 
- **Cross-Platform**: Connect with Mastodon, Pleroma, Misskey, and other federated platforms
- **Remote Follows**: Follow and interact with users from other instances
- **Federated Timeline**: Discover content from across the fediverse
- **Universal Compatibility**: Full ActivityPub protocol implementation

### 🚀 **Advanced Features**
- **Voice Channels**: Real-time voice communication in servers
- **Rich Content**: Images, videos, files with intelligent preview handling  
- **Custom Emojis**: Server-specific emojis with usage analytics
- **Trending Discovery**: Hashtag trends and popular content
- **Professional Moderation**: User blocking, content muting, instance-level controls

## 🏗️ **Architecture**

### **Local-First Design**
```
User Action → Local Database → Immediate UI Update
                   ↓
            Optional Federation (async, background)
                   ↓  
            Remote Delivery (with retry and health monitoring)
```

### **Tech Stack**
- **Frontend**: Vue 3 + TypeScript + Pinia + Vite
- **Backend**: Supabase (PostgreSQL + Edge Functions + Realtime)
- **Federation**: ActivityPub + HTTP Signatures + WebFinger
- **Content**: Unified JSONB format with universal converters

## 🚀 **Quick Start**

### **Prerequisites**
- Node.js 18+ (or Bun)
- Supabase project
- PostgreSQL database

### **Installation**
```bash
# 1. Clone and install
git clone <repository-url>
cd harmony
bun install  # or npm install

# 2. Environment setup
cp .env.example .env
# Edit .env with your Supabase credentials

# 3. Apply database migrations
./test-system.sh  # Automated migration and testing

# 4. Start development
bun dev          # Web only
bun tauri dev    # Desktop development
```

### **Production Build**
```bash
bun tauri build  # Desktop production build
npm run build    # Web production build
```

## 🎯 **Key Improvements**

### **Database Optimization**
| **Metric** | **Before** | **After** | **Improvement** |
|------------|------------|-----------|-----------------|
| **Triggers** | 32 scattered | 4 unified | **87% reduction** |
| **Functions** | 147 scattered | ~60 organized | **59% reduction** |
| **Converters** | 3 specific | 2 universal | **100% universal** |

### **Unified Systems**
- **Content Conversion**: `convert_ap_to_jsonb()` ↔ `convert_jsonb_to_ap()` (universal)
- **Notifications**: `create_notification_unified()` (handles all types + spam prevention)
- **Federation**: 4 unified triggers with federation control checks
- **Real-time**: Supabase subscriptions for instant UI updates

## 📊 **System Status**

✅ **Complete & Production-Ready:**
- Posts, messages, DMs, reactions, follows
- Real-time updates and notifications  
- ActivityPub federation (bidirectional)
- User/instance blocking and muting
- Content conversion and validation
- Performance optimization and monitoring

## 🧪 **Testing**

### **Run System Test**
```bash
./test-system.sh  # Tests migrations, functions, triggers, and frontend
```

### **Manual Testing**
1. **Create a post** → Check timeline updates
2. **Send messages** → Check real-time delivery  
3. **Add reactions** → Check emoji reactions work
4. **Follow users** → Check federation queuing
5. **Test federation** → Follow `@user@mastodon.social`

## 📁 **Project Structure**
```
/src/                   # Vue.js frontend
  stores/              # Pinia state management
  services/            # API and federation services  
  components/          # Vue components
  utils/               # Unified content processing
/supabase/functions/   # Edge functions (inbox, outbox, HTTP signing)
/db_migrations/        # Database migrations and refactoring
/docs/                 # Architecture and API documentation
```

## 🔧 **Development**

### **Core Philosophy**
- **Local-First**: Everything works without federation
- **Federation Optional**: Can be enabled/disabled per user/instance
- **Real-time Native**: Supabase subscriptions for instant updates
- **Universal Format**: Single content format for posts, messages, DMs

### **Contributing**
1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Test your changes: `./test-system.sh`
4. Submit pull request

## 🔗 **Resources**

- **Getting Started**: See `GETTING_STARTED.md`
- **Database Analysis**: See `HARMONY_DATABASE_ANALYSIS.md`
- **Refactor Progress**: See `REFACTOR_TODO.md`

---

**Built with ❤️ for the federated social web** 🌐
