# Frontend Bot Integration Guide

## 🎯 Overview

There are **TWO** ways to interact with bots in the frontend:

1. **Admin Panel** - Admins create and manage bot accounts
2. **Server Settings** - Server owners add bots to their servers

---

## 1️⃣ Admin Panel - Create Bots

### Step 1: Add Bot Management to Admin Panel

Edit `src/views/AdminPanel.vue`:

```vue
<!-- Around line 75, after the Federation module -->
<div class="admin-module bots-module">
  <div class="module-header">
    <Icon name="robot" :size="20" />
    <h2>Bot Management</h2>
    <button @click="showBotManagement = true" class="primary-btn">
      <Icon name="plus" :size="16" />
      Manage Bots
    </button>
  </div>
  
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">{{ systemStats.totalBots || 0 }}</div>
      <div class="stat-label">Total Bots</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{{ systemStats.activeBots || 0 }}</div>
      <div class="stat-label">Active Bots</div>
    </div>
  </div>
</div>

<!-- Bot Management Modal -->
<BotManagement v-if="showBotManagement" @close="showBotManagement = false" />
```

Add to script section:

```typescript
import BotManagement from '@/components/admin/BotManagement.vue'

const showBotManagement = ref(false)

// Add to systemStats computation
const systemStats = computed(() => ({
  // ... existing stats ...
  totalBots: 0, // Load from bots table
  activeBots: 0, // Load from bots where is_active = true
}))
```

### Step 2: Admin Creates a Bot

Admins can now:
1. Go to Admin Panel → Bot Management
2. Click "Create New Bot"
3. Fill in:
   - Bot username
   - Description (bio)
   - Avatar (optional)
   - Bot type (bot/bridge/integration)
   - Public/Private toggle
4. Click "Create"
5. **Copy the token** (shown once!)

---

## 2️⃣ Server Settings - Add Bots to Servers

### Step 1: Add to Server Settings Navigation

Edit `src/views/ServerSettings.vue`:

```typescript
// Around line 150-200 in the availableSections computation
const availableSections = computed(() => {
  const sections = [
    {
      id: 'overview',
      label: $t('server.overview'),
      component: ServerBasicInfo,
      visible: permissions.value.canViewSettings
    },
    // ... other sections ...
    {
      id: 'bots',
      label: '🤖 Bots',
      component: ServerBotsSettings,  // NEW!
      visible: permissions.value.canManageServer
    },
    // ... rest of sections ...
  ]

  return sections.filter(section => section.visible)
})
```

Import the component:

```typescript
import ServerBotsSettings from '@/components/settings/ServerBotsSettings.vue'
```

### Step 2: Server Owner Adds Bot

Server owners can now:
1. Go to Server Settings → Bots
2. Browse available public bots
3. Click "Add to Server" on a bot
4. Select permissions:
   - Read Messages ✓ (required)
   - Send Messages ✓ (required)
   - Manage Messages ☐ (optional)
   - etc.
5. Click "Add Bot"
6. Bot is now added to the server!

---

## 📝 Complete Integration Checklist

### Admin Panel Integration

- [ ] Import `BotManagement.vue` component
- [ ] Add bot stats to admin dashboard
- [ ] Add "Bot Management" button/module
- [ ] Create modal/route for bot management

### Server Settings Integration

- [ ] Import `ServerBotsSettings.vue` component  
- [ ] Add "Bots" section to settings navigation
- [ ] Ensure proper permissions check
- [ ] Test bot addition flow

### Router (Optional - if you want dedicated routes)

```typescript
// src/router/index.ts
{
  path: '/admin/bots',
  name: 'AdminBots',
  component: () => import('@/components/admin/BotManagement.vue'),
  meta: { requiresAdmin: true }
},
{
  path: '/server/:serverId/bots',
  name: 'ServerBots',
  component: () => import('@/components/settings/ServerBotsSettings.vue'),
  meta: { requiresAuth: true }
}
```

---

## 🎬 User Flow Examples

### Example 1: Admin Creates a Moderation Bot

```
1. Admin logs in
2. Goes to Admin Panel
3. Clicks "Bot Management"
4. Clicks "Create New Bot"
5. Fills in:
   - Username: "ModBot"
   - Bio: "Automated moderation bot"
   - Type: "bot"
   - Public: ✓
6. Clicks "Create"
7. Copies token: "harmony_bot_abc123xyz..."
8. Gives token to bot developer
```

### Example 2: Server Owner Adds Discord Bridge

```
1. Server owner has discord-bridge running
2. Goes to Server Settings → Bots
3. Sees "Discord Bridge" in available bots
4. Clicks "Add to Server"
5. Selects permissions:
   ✓ Read Messages
   ✓ Send Messages
   ✓ Embed Links
   ✓ Attach Files
   ☐ Manage Messages (not needed)
6. Clicks "Add Bot"
7. Bot appears in "Installed Bots" section
8. Bot can now interact with the server
```

### Example 3: Update Bot Permissions

```
1. Server owner goes to Server Settings → Bots
2. Finds installed bot in list
3. Clicks "Permissions"
4. Toggles permissions:
   ✓ Add "Manage Messages"
   ✓ Add "Kick Members"
5. Clicks "Save Changes"
6. Bot now has new permissions
```

---

## 🔑 Key Components

### Components Created

1. **`BotManagement.vue`** - Admin interface (already exists)
   - Create bots
   - Manage tokens
   - View analytics
   - Delete bots

2. **`ServerBotsSettings.vue`** - Server owner interface (just created)
   - Browse available bots
   - Add bots to server
   - Manage bot permissions
   - Remove bots from server

3. **`ServerEncryptionSettings.vue`** - Server encryption policy (already created)
   - Set encryption requirements
   - View member coverage

---

## 🎨 UI/UX Notes

### Admin Panel
- **Location**: `/admin` or Admin Panel view
- **Access**: Admin users only
- **Purpose**: Create and manage bot accounts
- **Style**: Match existing admin panel aesthetic

### Server Settings
- **Location**: Server Settings → Bots tab
- **Access**: Server owners/admins
- **Purpose**: Add/remove bots from specific servers
- **Style**: Match existing settings pages

---

## 🧪 Testing

### Test Admin Bot Creation

```typescript
// In browser console or test:
1. Navigate to admin panel
2. Click "Bot Management"
3. Create a bot
4. Verify bot appears in database:
   SELECT * FROM bots WHERE username = 'YourBotName';
5. Check that token was generated:
   SELECT * FROM bot_tokens WHERE bot_id = 'your-bot-id';
```

### Test Server Bot Addition

```typescript
// In browser console or test:
1. Navigate to server settings
2. Click "Bots" tab
3. Add a bot
4. Verify in database:
   SELECT * FROM bot_server_permissions 
   WHERE server_id = 'your-server-id' 
   AND bot_id = 'your-bot-id';
5. Check permissions are correct
```

---

## 🔗 Database Queries Used

### Load Available Bots
```sql
SELECT * FROM bots 
WHERE is_public = true 
AND is_active = true 
ORDER BY server_count DESC;
```

### Load Installed Bots
```sql
SELECT bsp.*, b.* 
FROM bot_server_permissions bsp
JOIN bots b ON b.id = bsp.bot_id
WHERE bsp.server_id = $1 
AND bsp.is_active = true;
```

### Add Bot to Server
```sql
-- Uses RPC function: add_bot_to_server
CALL add_bot_to_server(
  p_bot_id := 'bot-uuid',
  p_server_id := 'server-uuid',
  p_installed_by := 'user-uuid',
  p_permissions := '{"read_messages": true, ...}'::jsonb
);
```

---

## 🚀 Quick Start

### Minimum Integration (5 minutes)

1. **Add to Admin Panel:**
```vue
<BotManagement v-if="showBotManagement" @close="showBotManagement = false" />
```

2. **Add to Server Settings:**
```typescript
{
  id: 'bots',
  label: 'Bots',
  component: ServerBotsSettings,
  visible: true
}
```

3. **Test**: Create a bot, add it to a server, verify it works!

---

## 📚 Related Documentation

- [Bot API Reference](./BOT_API.md)
- [Plugin System](./PLUGIN_SYSTEM.md)
- [Bot Gateway Setup](./BOT_GATEWAY_SETUP.md)
- [E2EE Implementation](./E2EE_IMPLEMENTATION.md)

---

**That's it! Bot management is now fully integrated in your frontend!** 🎉

