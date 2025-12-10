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

### **Deployment**
- [HOW_TO_SELF_HOST.md](HOW_TO_SELF_HOST.md) - **Complete guide** (Cloud free tier or VPS)
- [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) - Detailed Vercel deployment reference

### **Development**
- [TODO_latest.md](TODO_latest.md) - Technical debt & roadmap
- [db_schema/init/README.md](db_schema/init/README.md) - Database setup

### **For Developers**
- [CONTRIBUTING.md](CONTRIBUTING.md) - How to contribute
- [federation-backend/README.md](federation-backend/README.md) - Federation backend docs

### **Database Setup**
- [db_schema/init/README.md](db_schema/init/README.md) - Database initialization guide

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

[⭐ Star](https://github.com/y4my4my4m/harmony) | [🐛 Report Bug](https://github.com/y4my4my4m/harmony/issues) | [💡 Request Feature](https://github.com/y4my4my4m/harmony/issues)
