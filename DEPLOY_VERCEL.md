# Deploy Harmony to Vercel

Deploy the Harmony frontend to Vercel with Supabase Cloud.

## What This Guide Covers

Vercel hosts **only the frontend** (static Vue build). This is the simplest deployment:

```
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│    Vercel     │       │   Supabase    │       │ LiveKit Cloud │
│  (Frontend)   │◄─────►│   (Database)  │◄─────►│  (Voice)      │
│    FREE       │       │    FREE       │       │    FREE       │
└───────────────┘       └───────────────┘       └───────────────┘
```

### What Works

| Feature | Status |
|---------|--------|
| Chat, Servers, DMs | ✅ |
| Timeline (local posts) | ✅ |
| Voice/Video | ✅ (via LiveKit Cloud) |
| File uploads, reactions, threads | ✅ |
| User settings, admin panel | ✅ |

### What Requires VPS

| Feature | Why |
|---------|-----|
| Cross-instance federation | Requires federation-backend (persistent service) |
| Link previews | Requires federation-backend |
| Bot gateway | Requires persistent WebSocket connections |

**Want federation?** See [HOW_TO_SELF_HOST.md](HOW_TO_SELF_HOST.md) → Path B (VPS)

---

## Step 1: Set Up Supabase

### Option A: Via Vercel Integration (Recommended)

1. Go to [Vercel Integrations Marketplace](https://vercel.com/integrations/supabase)
2. Click **Add Integration**
3. Follow prompts to create/link a Supabase project
4. Integration auto-sets environment variables

### Option B: Manual Setup

1. Go to [supabase.com](https://supabase.com) and create a project
2. Go to **Settings > API** and copy:
   - Project URL: `https://xxxxx.supabase.co`
   - Anon key: `eyJ...`

### Initialize Database

1. Go to **SQL Editor** in Supabase Dashboard
2. Run each file from `db_schema/init/` in order:

```
00_extensions.sql
01_types.sql
02_tables_core.sql → 06_tables_misc.sql
30_rls_policies.sql
50_realtime.sql
90_federation_functions.sql
95_livekit_tokens.sql
98_seed_data.sql
99_storage_buckets.sql
```

3. Enable extensions in **Database > Extensions**:
   - `pgcrypto` ✅
   - `pgjwt` ✅ (for voice tokens)
   - `uuid-ossp` ✅

4. Update your domain:
```sql
UPDATE instance_config 
SET config_value = '"your-app.vercel.app"' 
WHERE config_key = 'domain';
```

---

## Step 2: Deploy to Vercel

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fy4my4my4m%2Fharmony&integration-ids=oac_VqOgBHqhEoFTPzGkPd7L0iH6)

### Manual Deploy

1. Fork the repository to your GitHub
2. Go to [vercel.com](https://vercel.com) and import your fork
3. Vercel auto-detects Vite framework
4. Click **Deploy**

---

## Step 3: Configure Environment Variables

In Vercel Dashboard > **Settings** > **Environment Variables**:

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your anon key |
| `VITE_INSTANCE_DOMAIN` | `your-app.vercel.app` |
| `VITE_INSTANCE_NAME` | `My Harmony` |
| `VITE_ENABLE_VOICE` | `true` (if using LiveKit) |
| `VITE_ENABLE_FEDERATION` | `false` |

> **Note:** `VITE_ENABLE_FEDERATION=false` since there's no federation backend.

---

## Step 4: Add Voice/Video (Optional)

Voice works without a VPS! Tokens are generated in Supabase using `pgjwt`.

1. Sign up at [cloud.livekit.io](https://cloud.livekit.io) (free: 500 mins/month)
2. Create a project and get credentials
3. Add to Vercel:

| Variable | Value |
|----------|-------|
| `VITE_LIVEKIT_URL` | `wss://your-project.livekit.cloud` |

4. Configure in Supabase SQL Editor:

```sql
UPDATE instance_webrtc_settings SET
  livekit_url = 'wss://your-project.livekit.cloud',
  livekit_api_key = 'APIxxxx',
  livekit_api_secret = 'your-secret-here',
  webrtc_mode = 'sfu';
```

5. Redeploy Vercel

---

## Step 5: Add Custom Domain (Optional)

1. Go to **Settings > Domains**
2. Add your domain: `harmony.yourdomain.com`
3. Configure DNS as shown by Vercel
4. Update environment variables with your domain
5. Update in Supabase:

```sql
UPDATE instance_config 
SET config_value = '"harmony.yourdomain.com"' 
WHERE config_key = 'domain';
```

---

## Verify Deployment

Visit your deployment URL. You should see the Harmony login page.

```bash
# Test the frontend
curl https://your-app.vercel.app
```

---

## Troubleshooting

### "Invalid API Key" Error
- Verify `VITE_SUPABASE_ANON_KEY` is correct
- Ensure it's the `anon` key, not `service_role`

### Storage/Upload Issues
- Verify storage buckets exist in Supabase Dashboard
- Check RLS policies on storage.objects

### Voice Not Working
- Ensure `pgjwt` extension is enabled
- Verify `instance_webrtc_settings` has LiveKit credentials
- Check `VITE_LIVEKIT_URL` in Vercel env vars

---

## Want Federation?

This Vercel-only setup is **local-only** (no cross-instance communication).

For full ActivityPub federation, you need a VPS to run:
- Federation backend (persistent Node.js service)
- Bot gateway (optional)
- Self-hosted LiveKit (optional)

See [HOW_TO_SELF_HOST.md](HOW_TO_SELF_HOST.md) → **Path B: Full Self-Hosting on VPS**

---

## Next Steps

1. **Register an account** (first user gets admin)
2. **Configure settings** in Admin Panel
3. **Disable federation UI** in Admin Panel (since no backend)
4. **Invite users** to your local instance
