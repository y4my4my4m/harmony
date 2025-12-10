# Deploy Harmony to Vercel

Step-by-step guide to deploy Harmony on Vercel with Supabase.

## Architecture Overview

This deployment method runs:

| Component | Platform | Notes |
|-----------|----------|-------|
| **Frontend** | Vercel CDN | Static Vue/Vite build |
| **Federation Backend** | Vercel Serverless | ActivityPub, WebFinger, link previews |
| **Database** | Supabase | PostgreSQL + Realtime + Auth + Storage |
| **Voice/Video** | ✅ LiveKit Cloud | Tokens generated in Supabase (no VPS!) |
| **Bots** | ❌ Not supported | Requires persistent WebSocket |

**Limitations:**
- ⚠️ **No pg-boss queue** - Vercel serverless doesn't support persistent connections. Federation uses database triggers (less reliable but works).
- ⚠️ **Cold starts** - First request after idle may be slow (1-3s).
- ⚠️ **No bot gateway** - Requires separate VPS deployment.

**What DOES work:**
- ✅ Full chat (servers, channels, DMs)
- ✅ Timeline/social features
- ✅ ActivityPub federation (basic)
- ✅ **Voice/Video** (via LiveKit Cloud + Supabase token generation)
- ✅ File uploads, reactions, threads

**Estimated time**: 15-30 minutes

---

## Step 1: Set Up Supabase (via Vercel Integration)

Vercel has **native Supabase integration** - this is the easiest method!

### Option A: Vercel Supabase Integration (Recommended)

1. Go to [Vercel Integrations Marketplace](https://vercel.com/integrations/supabase)
2. Click **Add Integration**
3. Select your Vercel account/team
4. Follow the prompts to:
   - Create a new Supabase project, OR
   - Link an existing Supabase project
5. The integration **automatically** sets these environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_KEY` (service role)
   - `POSTGRES_URL` (direct database connection)

### Option B: Manual Supabase Setup

If you prefer to set up Supabase separately:

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for database initialization (~2 minutes)
3. Go to **Settings > API** and copy:
   - Project URL
   - `anon` public key
   - `service_role` secret key
4. Go to **Settings > Database** and copy the connection string

### Initialize Database Schema

Regardless of which option you chose:

1. Go to **SQL Editor** in Supabase Dashboard
2. Click **New query**
3. Run each file from `db_schema/init/` in order:
   - `00_extensions.sql`
   - `01_types.sql`
   - `02_tables_core.sql`
   - `03_tables_social.sql`
   - `04_tables_servers.sql`
   - `05_tables_federation.sql`
   - `06_tables_misc.sql`
   - `30_rls_policies.sql`
   - `50_realtime.sql`
   - `98_seed_data.sql` (default instance config)
   - `99_storage_buckets.sql`

4. Update your instance domain:

```sql
UPDATE instance_config 
SET config_value = '"your-app.vercel.app"' 
WHERE config_key = 'domain';
```

---

## Step 2: Deploy to Vercel

### Option A: One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-username%2Fharmony&integration-ids=oac_VqOgBHqhEoFTPzGkPd7L0iH6)

This button clones the repo AND sets up Supabase integration automatically.

### Option B: Manual Deploy

1. Fork this repository to your GitHub account
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click **Add New** > **Project**
4. Select your forked repository
5. Configure build settings:
   - Framework: **Vite**
   - Build Command: `npm run build-only`
   - Output Directory: `dist`
6. Click **Deploy**

---

## Step 3: Configure Environment Variables

Go to Vercel Dashboard > Your Project > **Settings** > **Environment Variables**.

### If Using Vercel Supabase Integration

The integration auto-sets some variables. You only need to add:

| Variable | Value | Description |
|----------|-------|-------------|
| `VITE_SUPABASE_URL` | `$SUPABASE_URL` | Reference the auto-set var |
| `VITE_SUPABASE_ANON_KEY` | `$SUPABASE_ANON_KEY` | Reference the auto-set var |
| `VITE_INSTANCE_DOMAIN` | `your-app.vercel.app` | Your Vercel domain |
| `VITE_INSTANCE_NAME` | `My Harmony` | Instance display name |
| `INSTANCE_DOMAIN` | `your-app.vercel.app` | Same, for backend |
| `INSTANCE_NAME` | `My Harmony` | Same, for backend |
| `CORS_ORIGIN` | `https://your-app.vercel.app` | Full URL with https |
| `USE_PGBOSS_QUEUE` | `false` | **Must be false** for Vercel |
| `VITE_ENABLE_VOICE` | `true` | Voice works! See Step 6 |

### If Setting Up Manually

Add all required variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `VITE_SUPABASE_URL` | `https://xxxxx.supabase.co` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` | Supabase anon key |
| `VITE_INSTANCE_DOMAIN` | `your-app.vercel.app` | Your Vercel domain |
| `VITE_INSTANCE_NAME` | `My Harmony` | Instance display name |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | Same as VITE_SUPABASE_URL |
| `SUPABASE_ANON_KEY` | `eyJ...` | Same as VITE_SUPABASE_ANON_KEY |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Service role key (SECRET!) |
| `INSTANCE_DOMAIN` | `your-app.vercel.app` | Same as VITE_INSTANCE_DOMAIN |
| `INSTANCE_NAME` | `My Harmony` | Same |
| `CORS_ORIGIN` | `https://your-app.vercel.app` | Full URL with https |
| `USE_PGBOSS_QUEUE` | `false` | **Must be false** for Vercel |
| `VITE_ENABLE_VOICE` | `true` | Voice works! See Step 6 |

---

## Step 4: Redeploy

After adding environment variables:

1. Go to **Deployments** tab
2. Click the three dots (⋮) on the latest deployment
3. Click **Redeploy**

---

## Step 5: Add Custom Domain (Optional)

### 5.1 Add Domain in Vercel

1. Go to **Settings** > **Domains**
2. Enter your domain: `harmony.yourdomain.com`
3. Click **Add**

### 5.2 Configure DNS

Add DNS records as shown by Vercel:

**For subdomain (harmony.yourdomain.com):**
```
Type: CNAME
Name: harmony
Value: cname.vercel-dns.com
```

**For root domain (yourdomain.com):**
```
Type: A
Name: @
Value: 76.76.21.21
```

### 5.3 Update Environment Variables

Update these variables with your custom domain:
- `VITE_INSTANCE_DOMAIN` → `harmony.yourdomain.com`
- `INSTANCE_DOMAIN` → `harmony.yourdomain.com`
- `CORS_ORIGIN` → `https://harmony.yourdomain.com`

Also update in Supabase SQL:
```sql
UPDATE instance_config 
SET config_value = '"harmony.yourdomain.com"' 
WHERE config_key = 'domain';
```

Then redeploy.

---

## Step 6: Add Voice/Video (Optional)

**Good news!** Voice works with Vercel + Supabase — **no VPS needed!**

Harmony generates LiveKit tokens directly in Supabase using the `pgjwt` extension. You just need a LiveKit Cloud account (free tier available).

### Step 6.1: Set Up LiveKit Cloud

1. Sign up at [livekit.io](https://livekit.io) (free tier: 500 participant-minutes/month)
2. Create a new project
3. Get your:
   - **API Key** (looks like `APIxxxx`)
   - **API Secret** (looks like `xxxxxxxxxxxxxxxxxxxx`)
   - **WebSocket URL** (looks like `wss://your-project.livekit.cloud`)

### Step 6.2: Add to Vercel Environment Variables

| Variable | Value |
|----------|-------|
| `VITE_LIVEKIT_URL` | `wss://your-project.livekit.cloud` |
| `VITE_ENABLE_VOICE` | `true` |

### Step 6.3: Configure LiveKit in Supabase

Run this SQL in Supabase SQL Editor (or use the Admin Panel after first login):

```sql
-- First, enable pgjwt extension if not already
CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;

-- Run the LiveKit token functions
-- (Copy content from db_schema/init/95_livekit_tokens.sql)

-- Then configure LiveKit credentials:
UPDATE instance_webrtc_settings SET
  livekit_url = 'wss://your-project.livekit.cloud',
  livekit_api_key = 'APIxxxx',
  livekit_api_secret = 'your-secret-here',
  webrtc_mode = 'sfu',
  allow_federated_voice = false;
```

**Important:** The API Secret is stored securely in the database and never exposed to the frontend. Token generation happens server-side via RPC.

### Step 6.4: Redeploy

Redeploy your Vercel app to pick up the new environment variables.

### How It Works

1. User joins a voice channel
2. Frontend calls `supabase.rpc('generate_livekit_token', { room_name: '...' })`
3. Supabase generates a JWT signed with your API secret (using pgjwt)
4. Token is returned to frontend
5. Frontend connects to LiveKit Cloud with the token

**No backend server required!** 🎉

### Alternative: Self-Hosted LiveKit

If you prefer to run your own LiveKit server:

```yaml
# On a VPS with docker-compose
services:
  livekit:
    image: livekit/livekit-server:latest
    ports:
      - "7880:7880"
      - "7881:7881"
      - "50000-50100:50000-50100/udp"
    volumes:
      - ./livekit.yaml:/livekit.yaml:ro
    command: --config /livekit.yaml
```

Then update your `instance_webrtc_settings` with your VPS's LiveKit URL.

---

## Step 7: Verify Deployment

### Test Frontend

Visit your deployment URL. You should see the Harmony login page.

### Test Federation Endpoints

```bash
# WebFinger
curl https://your-domain.vercel.app/.well-known/webfinger?resource=acct:test@your-domain.vercel.app

# NodeInfo
curl https://your-domain.vercel.app/.well-known/nodeinfo

# Health check
curl https://your-domain.vercel.app/health
```

---

## Limitations & Workarounds

### No pg-boss Queue

**Problem**: Vercel serverless doesn't support persistent database connections.

**Impact**: Federation uses Supabase Realtime triggers instead. Slightly less reliable, but works for most use cases.

**Workaround**: If you need reliable federation, deploy the federation-backend separately on a VPS using `docker-compose.prod.yml`.

### Cold Starts

**Problem**: Serverless functions spin down after ~15 minutes of inactivity.

**Impact**: First request after idle may take 1-3 seconds.

**Workaround**: Set up a cron job to ping `/health` every 5 minutes to keep warm.

### No Bot Gateway

**Problem**: Bot gateway requires persistent WebSocket connections.

**Workaround**: Deploy bot-gateway separately on a VPS if needed.

### No Background Jobs

**Problem**: Vercel functions timeout after 10-30 seconds.

**Impact**: Large federation deliveries may fail.

**Workaround**: For high-traffic instances, use VPS deployment with pg-boss.

---

## Troubleshooting

### "Invalid API Key" Error
- Verify `VITE_SUPABASE_ANON_KEY` is correct
- Ensure it's the `anon` key, not `service_role`
- Check that the Vercel integration variables are properly linked

### Federation Not Working
- Check `INSTANCE_DOMAIN` doesn't include `https://`
- Verify `CORS_ORIGIN` includes `https://`
- Test `/health` endpoint returns 200
- Check Vercel Function logs for errors

### Database Connection Errors
- If using Vercel Supabase integration, verify `POSTGRES_URL` is set
- For manual setup, verify all Supabase credentials are correct

### Build Failures
- Ensure all required environment variables are set
- Check Vercel build logs for specific errors
- Try running `npm run build-only` locally first

---

## Upgrading

When updates are available:

1. Sync your fork with the upstream repository:
   ```bash
   git fetch upstream
   git merge upstream/main
   git push
   ```
2. Vercel automatically redeploys on push

Or merge via GitHub's "Sync fork" button.

---

## Alternative: Full Self-Hosted

For production instances that need:
- Cross-instance ActivityPub federation
- Link previews
- Bot gateway
- No cold starts

See [HOW_TO_SELF_HOST.md](HOW_TO_SELF_HOST.md) → **Path B: Full Self-Hosting on VPS**

---

## Next Steps

1. **Register an account** on your instance (first user gets admin)
2. **Configure settings** in Admin Panel
3. **Follow users** from Mastodon, Misskey, etc.
4. **Create your first post!**

---

## Support

- [GitHub Issues](https://github.com/y4my4my4m/harmony/issues)
- [Documentation](docs/)
