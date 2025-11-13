# Frontend → Backend API Migration Status

## Current Status: BACKEND RUNNING ✅, FRONTEND NOT MIGRATED ❌

### What's Working Now

✅ **Backend API is running** at `http://localhost:3001`
- All endpoints functional
- Authentication working
- Database connected to self-hosted Supabase

✅ **Frontend still works** (using old Postgres functions)
- Messages work via direct Supabase RPC
- Everything functions as before
- No disruption to current functionality

### What Needs to Happen

❌ **Frontend needs to call the new API instead of Postgres functions**

---

## The Migration Plan

### Created Files

1. **`src/api/client.ts`** ✅
   - API client ready to use
   - Handles authentication automatically
   - All endpoints mapped

2. **`backend/.env`** ✅  
   - Configured for self-hosted Supabase
   - Backend connects to `http://localhost:8000`

### What You Need To Do

#### Option 1: Quick Test (See if API works)

Add this to your frontend `.env` or `.env.local`:

```env
VITE_API_URL=http://localhost:3001
```

Then create a test file `src/test-api.ts`:

```typescript
import { api } from '@/api/client'

// Test the API
async function testAPI() {
  try {
    const me = await api.users.me()
    console.log('✅ API Working!', me)
  } catch (error) {
    console.error('❌ API Error:', error)
  }
}

// Call it from somewhere (like a button click)
testAPI()
```

#### Option 2: Full Migration (What I was starting)

To fully migrate, we need to update these services to use the new API client instead of Supabase RPC:

**Services to Update:**

1. **`src/services/core/CoreMessageService.ts`**
   - Replace Supabase RPC calls with `api.messages.*`
   - Keep the same interface/methods
   - Just change the implementation

2. **`src/services/core/CorePostService.ts`**
   - Replace Supabase calls with `api.posts.*`

3. **`src/services/core/CoreProfileService.ts`** 
   - Replace Supabase calls with `api.users.*`

**Example Migration:**

```typescript
// BEFORE (current - using Supabase RPC):
const { data, error } = await supabase
  .from('messages')
  .insert({ content, channel_id: channelId })
  .select()
  .single()

// AFTER (using new API):
import { api } from '@/api/client'

const message = await api.messages.create({
  content,
  channelId
})
```

---

## Why This Matters

### Current Architecture (What you have now):
```
Frontend → Supabase (Postgres Functions) → Database
```

### New Architecture (What we're moving to):
```
Frontend → Backend API → Supabase (Database only) → Database
                ↓
         Federation Logic
         ActivityPub
         Queue Processing
```

### Benefits:
- ✅ Professional architecture
- ✅ Easier to maintain
- ✅ Testable business logic
- ✅ Federation built-in
- ✅ Can add features without SQL
- ✅ API can be deployed separately

---

## Testing the Backend API Manually

You can test the backend API right now without touching the frontend:

### 1. Get an auth token:

```bash
# Open browser console on your running app
# Run this:
const { data: { session } } = await supabase.auth.getSession()
console.log(session.access_token)
# Copy the token
```

### 2. Test API endpoints:

```bash
# Replace YOUR_TOKEN with the token from above

# Get your profile
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/users/me

# Get servers
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/servers

# Create a message (replace IDs)
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":[{"type":"text","text":"Test from API!"}],"channelId":"YOUR_CHANNEL_ID"}' \
  http://localhost:3001/api/messages
```

---

## Decision Point

You have 3 options:

### Option A: Continue with Migration (Recommended)
**What happens:** I finish migrating the services to use the new API
**Time:** ~1-2 hours of work
**Risk:** Medium (might find bugs, but fixable)
**Benefit:** Full professional architecture

### Option B: Test First, Migrate Later
**What happens:** You test the API manually, verify it works, then we migrate
**Time:** ~30 min testing, then Option A
**Risk:** Low (you validate before switching)
**Benefit:** More confidence before migration

### Option C: Keep Both (Hybrid)
**What happens:** Keep using Postgres functions, use API for new features only
**Time:** Minimal
**Risk:** Low
**Benefit:** Gradual migration, but maintains technical debt

---

## Quick Win: Test One Endpoint

Want to see the API working without breaking anything?

Add this to any component temporarily:

```vue
<script setup>
import { api } from '@/api/client'
import { ref } from 'vue'

const testResult = ref(null)

async function testBackend() {
  try {
    const result = await api.users.me()
    testResult.value = result
    console.log('✅ Backend API works!', result)
  } catch (error) {
    console.error('❌ Backend error:', error)
    testResult.value = { error: error.message }
  }
}
</script>

<template>
  <button @click="testBackend">Test Backend API</button>
  <pre v-if="testResult">{{ testResult }}</pre>
</template>
```

---

## What I Recommend

**Do this now:**
1. Test the backend API with curl (see above)
2. Verify your backend is properly connected
3. Then decide: full migration or gradual?

**For full migration:**
- I can continue and update all the services
- Takes ~1-2 hours
- You'll have a complete professional system

**For gradual:**
- Keep using current system
- Add new features using the API
- Migrate old features one by one over time

What would you like to do? 🚀

