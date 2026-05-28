# Bot & Encryption Settings - Where Everything Is Located

## 🤖 Bot Settings - Three Different Places

### 1. **Instance Admin Panel** (For Admins Only)
**Location:** `/admin` or Admin Panel view  
**Component:** `BotManagement.vue`  
**Purpose:** Create bot accounts for the instance  
**Who:** Instance administrators only

**What you can do:**
- Create new bot accounts
- Generate bot tokens
- View all bots on instance
- Disable/delete bots
- View bot statistics

### 2. **User Settings** (For Bot Owners)
**Location:** `/settings` → “My Bots” tab  
**Component:** `UserBotsManagement.vue` ✅  
**Purpose:** Manage bots YOU created  
**Who:** Any user who has created bots

**What you can do:**
- View all bots you own
- Regenerate bot tokens
- Update bot metadata (name, type, description, visibility)
- Delete bots you no longer need
- View quick stats (server installs, command usage)

### 3. **Server Settings** (For Server Owners)
**Location:** `/server/:id/settings` → Bots tab  
**Component:** `ServerBotsSettings.vue` ✅ (Just integrated!)  
**Purpose:** Add/remove bots from YOUR server  
**Who:** Server owners/admins

**What you can do:**
- Browse available bots
- Add bots to your server
- Configure bot permissions
- Remove bots from server

---

## 🔐 Encryption Settings - Two Places

### 1. **Server Settings** (For Server Owners)
**Location:** `/server/:id/settings` → Encryption tab  
**Component:** `ServerEncryptionSettings.vue` ✅ (Just integrated!)  
**Purpose:** Set encryption policy for the server  
**Who:** Server owners/admins

**What you can do:**
- Set encryption mode (Disabled/Optional/Required)
- Force key setup prompts
- Enable attachment encryption
- View member coverage statistics

### 2. **User Settings** (For Users)
**Location:** `/settings` → “Privacy & Safety” tab  
**Component:** `EncryptionSettings.vue` ✅  
**Purpose:** Set up YOUR encryption keys  
**Who:** All users

**What you can do:**
- Run the E2EE setup wizard
- Generate and rotate Signal keys
- Monitor available pre-keys & sessions
- Export recovery codes
- Reset encryption (with warning)

---

## 📍 Complete Navigation Map

```
Harmony App
│
├─ Admin Panel (/admin)
│  └─ Bot Management
│     ├─ Create bot accounts
│     ├─ View all instance bots
│     └─ Delete/disable bots
│
├─ User Settings (/settings)
│  ├─ Privacy & Safety (includes EncryptionSettings.vue)
│  │  ├─ Privacy controls
│  │  ├─ Run key setup wizard
│  │  ├─ Rotate keys / export backups
│  │  └─ Reset encryption
│  │
│  └─ My Bots (UserBotsManagement.vue)
│     ├─ View/manage owned bots
│     ├─ Regenerate tokens
│     └─ Delete/update bots
│
└─ Server Settings (/server/:id)
   ├─ Overview
   ├─ Emoji
   ├─ 🤖 Bots
   │  ├─ Browse available bots
   │  ├─ Add to server
   │  └─ Manage permissions
   │
   ├─ 🔐 Encryption
   │  ├─ Set encryption mode
   │  ├─ Force key setup
   │  └─ View coverage
   │
   ├─ Privacy
   └─ Advanced
```

---

## ✅ What I Just Fixed

### 1. Server Settings - Bots Tab
**Status:** ✅ **NOW AVAILABLE**

Added to `ServerSettings.vue`:
- Import `ServerBotsSettings.vue`
- Added "Bots" tab to navigation
- Shows for server owners

### 2. Server Settings - Encryption Tab
**Status:** ✅ **NOW AVAILABLE**

Added to `ServerSettings.vue`:
- Import `ServerEncryptionSettings.vue`
- Added "Encryption" tab to navigation
- Shows for server owners

### 3. User Settings - My Bots
**Status:** ✅ **NOW AVAILABLE**

Users can now manage their own bots directly from settings.

### 4. User Settings - Encryption
**Status:** ✅ **NOW AVAILABLE**

Full E2EE setup workflow lives under “Privacy & Safety”.

---

## 🎯 Quick Integration Guide

### To Add User Bot Management:

1. Create `src/components/settings/user/UserBotsManagement.vue`
2. Add to User Settings router:
```typescript
{
  path: '/settings/bots',
  component: UserBotsManagement
}
```
3. Add nav item in settings sidebar

### To Add User Encryption Setup:

1. Create `src/components/settings/user/EncryptionSetup.vue`
2. Add to User Settings under Security section
3. Import and show in UserSettings.vue

---

## 📝 Summary

### ✅ Working Now:
- Server Settings → Bots tab
- Server Settings → Encryption tab
- User Settings → My Bots
- User Settings → Security (Encryption)
- Admin Panel → Bot Management

### 🎯 User Flow Example:

**Creating and Using a Bot:**
1. User goes to User Settings → My Bots (TODO)
2. Creates a bot → gets token
3. Server owner goes to Server Settings → Bots
4. Adds that bot to their server
5. Bot can now interact with server

**Setting Up Encryption:**
1. User goes to User Settings → Security → E2EE (TODO)
2. Generates encryption keys
3. Server owner goes to Server Settings → Encryption
4. Sets policy to "Required"
5. All messages now encrypted

---

Would you like me to create the missing user-level components (`UserBotsManagement.vue` and `EncryptionSetup.vue`)? 🚀

