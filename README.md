# 🎵 Harmony - Federated Social Platform

A modern, federated social platform combining Discord-like servers with ActivityPub federation, built with Vue 3 and Supabase.

> **✨ Just Refactored!** Check **[START_HERE.md](START_HERE.md)** for what's new!

---

## ✨ Features

### 🏠 **Discord-Like Servers**
- **Real-time Messaging**: Organized channels with instant delivery
- **Voice Channels**: Real-time voice communication
- **Video Calls**: Voice + video in channels and DMs
- **Servers & Channels**: Organized communities
- **🚀 FEDERATED SERVERS**: Users from multiple instances in same server!

### 🌐 **ActivityPub Federation** 
- **Cross-Platform**: Connect with Mastodon, Pleroma, Misskey
- **Federated Timeline**: Posts from across the fediverse
- **Remote Follows**: Follow and interact with users everywhere
- **Federated DMs**: Message users on other platforms
- **Multi-Instance Servers**: 🆕 Discord servers spanning instances!

### 🚀 **Innovation: Federated Discord Servers**

**First in the fediverse!** Users from different Harmony instances can join the same server:

```
Server "Gaming Hub" on harmonyB.com:
  ├─ @alice@harmonyA.com  ←──┐
  ├─ @bob@harmonyB.com        │ All chat together!
  └─ @charlie@harmonyC.com ←──┘

Local users: < 50ms (instant via Supabase real-time!)
Remote users: ~ 2s (via ActivityPub federation)
```

---

## 🏗️ **Architecture**

### **The Right Way**

```
Frontend → Supabase (Direct, Fast!)
              ↓
         (triggers)
              ↓
    Federation Backend
       (ActivityPub)
              ↓
         Fediverse
```

### **Tech Stack**
- **Frontend**: Vue 3 + TypeScript + Pinia + Vite
- **Database**: Supabase (PostgreSQL + Real-time)
- **Federation**: Node.js backend (ActivityPub protocol)
- **Deployment**: Vercel / Docker / Manual

---

## 🚀 **Quick Start**

### **Option 1: Development (Recommended)**

```bash
# 1. Clone
git clone <repository-url>
cd harmony

# 2. Install
npm install
cd federation-backend && npm install && cd ..

# 3. Start Supabase (Docker)
cd ../harmonious
docker compose up -d

# 4. Apply migrations (REQUIRED for server federation!)
psql -h localhost -p 54322 -U postgres postgres < \
  ../harmony/db_schema/server_federation.sql
psql -h localhost -p 54322 -U postgres postgres < \
  ../harmony/db_schema/triggers/smart_message_routing.sql

# 5. Start Frontend
cd ../harmony
npm run dev

# 6. Start Federation Backend (optional)
cd federation-backend
npm run dev
```

Visit: `http://localhost:5173`

### **Option 2: One-Click Deploy**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-username%2Fharmony)

See [INSTALLATION.md](INSTALLATION.md)

---

## 📚 **Documentation**

### **Essential Reading**
- [START_HERE.md](START_HERE.md) - What's new after refactor
- [QUICK_START.md](QUICK_START.md) - Get running in 5 minutes
- [INSTALLATION.md](INSTALLATION.md) - Complete deployment guide

### **For Developers**
- [CONTRIBUTING.md](CONTRIBUTING.md) - How to contribute
- [MASTER_SUMMARY.md](MASTER_SUMMARY.md) - Complete architecture overview
- [FEDERATED_SERVERS_COMPLETE.md](FEDERATED_SERVERS_COMPLETE.md) - Server federation details

### **Detailed Docs**
- See `docs/refactor-history/` for complete refactor documentation

---

## 🎯 **What's Different**

### **Architecture**
- ✅ Supabase used correctly (direct access, fast!)
- ✅ Federation backend (TypeScript, easy to maintain!)
- ✅ 15 PostgreSQL functions (down from 124!)
- ✅ Smart local-first optimization

### **Features**
- ✅ Federated Discord servers (NEW in fediverse!)
- ✅ DM video/audio calls
- ✅ Bug fixes (messages, registration, video)
- ✅ Professional codebase

### **Deployment**
- ✅ One-click Vercel
- ✅ Docker Compose
- ✅ Complete documentation

---

## 📊 **Project Status**

### **Complete**
✅ Federation backend (ActivityPub)  
✅ Federated servers (multi-instance!)  
✅ Bug fixes  
✅ Deployment ready  
✅ Community infrastructure  

### **In Progress**
🔄 PostgreSQL cleanup (optional)  
🔄 Frontend UI for remote servers  

---

## 🤝 **Contributing**

See [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 📝 **License**

MIT - See [LICENSE](LICENSE)

---

**Built with ❤️ for the federated social web** 🌐

[⭐ Star](https://github.com/your-username/harmony) | [🐛 Report Bug](https://github.com/your-username/harmony/issues) | [💡 Request Feature](https://github.com/your-username/harmony/issues)
