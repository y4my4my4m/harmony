# Harmony - Quick Start Guide

## 🎯 The Architecture (Simplified!)

You now have the CORRECT architecture:

```
Frontend → Supabase (direct, fast!)
Database → Federation Backend (ActivityPub only)
```

---

## 🚀 Running Harmony

### Step 1: Start Supabase (if not running)

```bash
cd ~/gits/hobby/harmonious
docker compose up -d
```

Verify it's running:
```bash
curl http://localhost:8000/health
```

### Step 2: Start Frontend

```bash
cd ~/gits/hobby/harmony
npm run dev
```

Frontend runs on: `http://localhost:5173`

### Step 3: Start Federation Backend (Optional)

```bash
cd ~/gits/hobby/harmony/federation-backend
npm install  # First time only
npm run dev
```

Federation backend runs on: `http://localhost:3001`

**Note**: The app works WITHOUT the federation backend! It's only needed for:
- Federating posts to other instances
- Receiving posts from other instances
- ActivityPub protocol

---

## 🧪 Testing

### Test the App (Without Federation)

1. Visit `http://localhost:5173`
2. Register an account
3. Create a server
4. Send messages ✅
5. Create posts ✅
6. Everything works!

### Test Federation (With Backend)

1. Make sure federation backend is running
2. Create a post
3. Check backend logs - should see:
   ```
   📝 New post detected: post-id
   🌐 Federating new post: post-id
   ```

---

## 📊 What Changed

### Before (What You Had)
```
Frontend → Supabase RPC (124 complex functions) → Database
           └─ Edge Functions for federation
```

### Now (What You Have)
```
Frontend → Supabase (15 simple functions) → Database
                                              ↓ (triggers)
                                         Federation Backend
                                              ↓
                                         Fediverse
```

---

## ✅ What's Fixed

1. **Message Saving** ✅
   - Fixed parameter mismatch in sendChannelMessage
   - Messages now save properly!

2. **Registration** ✅
   - Fixed hardcoded domain
   - Now reads from instance_config
   - Should work on first try!

3. **Video Calls** ✅
   - Fixed track replacement logic
   - Camera works without screenshare workaround
   - Proper cleanup of old tracks

4. **DM Video/Audio Calls** ✅
   - Added call buttons to DM header
   - Voice call button ☎️
   - Video call button 📹
   - Uses WebRTC service

---

## 📁 Important Files

### Documentation (Read These!)
- `CORRECT_ARCHITECTURE.md` - The RIGHT way
- `FINAL_ARCHITECTURE.md` - Visual diagrams
- `POSTGRESQL_CLEANUP_GUIDE.md` - Function cleanup plan
- `REFACTOR_COMPLETE_SUMMARY.md` - What was done

### Database
- `db_schema/essential_functions.sql` - 15 functions you need
- `db_schema/drop_unnecessary_functions.sql` - Cleanup script

### Federation
- `federation-backend/` - ActivityPub server
- `federation-backend/README.md` - How it works

---

## 🔧 Next Steps (Optional)

### 1. Clean Up PostgreSQL Functions

**Only when ready** (creates backup first!):

```bash
# Backup current database
cd ~/gits/hobby/harmonious
docker exec supabase-db pg_dump -U postgres postgres > ../backup_before_cleanup.sql

# Apply cleanup (REVIEW FIRST!)
psql -h localhost -p 54322 -U postgres postgres < ~/gits/hobby/harmony/db_schema/drop_unnecessary_functions.sql
psql -h localhost -p 54322 -U postgres postgres < ~/gits/hobby/harmony/db_schema/essential_functions.sql
```

**Benefits**:
- 124 → 15 functions (88% reduction!)
- Easier to understand
- Easier to maintain
- Federation in TypeScript (not SQL!)

### 2. Test Federation

```bash
# Start federation backend
cd federation-backend
npm run dev

# Create a post in your app
# Check backend console for:
📝 New post detected
🌐 Federating new post
✅ Queued for delivery
```

### 3. Deploy to Production

See `INSTALLATION.md` for:
- Vercel deployment (one-click!)
- Docker deployment
- Manual deployment

---

## 🐛 Debugging

### Frontend not working?
```bash
# Check console in browser
# Common issues:
- Supabase not running (docker compose up)
- Environment variables (.env.local)
```

### Federation not working?
```bash
# Check federation backend logs
cd federation-backend && npm run dev

# Verify endpoints:
curl http://localhost:3001/health
curl http://localhost:3001/.well-known/nodeinfo
```

### Database issues?
```bash
# Check Supabase logs
cd ~/gits/hobby/harmonious
docker compose logs -f db
```

---

## 💡 Tips

### Development Workflow
```bash
# Terminal 1: Supabase
cd ~/gits/hobby/harmonious && docker compose up

# Terminal 2: Frontend
cd ~/gits/hobby/harmony && npm run dev

# Terminal 3: Federation (optional)
cd ~/gits/hobby/harmony/federation-backend && npm run dev
```

### Hot Reload
- Frontend: ✅ Auto-reload on code changes
- Federation Backend: ✅ Auto-reload with tsx watch
- Database: Manual (apply migrations)

### Logs
- Frontend: Browser console
- Backend: Terminal output
- Database: `docker compose logs -f db`

---

## 🎉 You're Ready!

The architecture is now:
- ✅ Professional
- ✅ Scalable
- ✅ Maintainable
- ✅ Community-ready
- ✅ Properly using Supabase
- ✅ Federation separated

**Happy coding!** 🎵

