# Deploy Harmony to Vercel

Step-by-step guide to deploy Harmony on Vercel with Supabase.

## Overview

This deployment method runs:
- **Frontend**: Vite-built Vue app on Vercel CDN
- **Federation Backend**: Node.js serverless functions on Vercel
- **Database**: Supabase Cloud (PostgreSQL + Realtime + Storage)

**Estimated time**: 15-30 minutes

---

## Prerequisites

- GitHub account
- Vercel account (free tier works)
- Supabase account (free tier works)

---

## Step 1: Set Up Supabase Project

### 1.1 Create Project

1. Go to [supabase.com](https://supabase.com) and sign in
2. Click **New Project**
3. Fill in:
   - Project name: `harmony` (or your choice)
   - Database password: Generate a strong password and **save it**
   - Region: Choose closest to your users
4. Click **Create new project**
5. Wait 2-3 minutes for setup

### 1.2 Get API Credentials

1. Go to **Settings** (gear icon) > **API**
2. Copy and save:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: Long JWT starting with `eyJ...`
   - **service_role secret key**: Another long JWT (keep this secret!)

### 1.3 Get Database Connection String

1. Go to **Settings** > **Database**
2. Scroll to **Connection string** > **URI**
3. Copy the connection string
4. Replace `[YOUR-PASSWORD]` with your database password

Example: `postgresql://postgres.xxxxx:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres`

### 1.4 Initialize Database Schema

1. Go to **SQL Editor** in Supabase Dashboard
2. Click **New query**
3. For each file in `db_schema/init/` (in order):
   - Paste the file contents
   - Click **Run**
   - Wait for completion

Run in this order:
1. `00_extensions.sql`
2. `01_types.sql`
3. `02_tables_core.sql`
4. `03_tables_social.sql`
5. `04_tables_servers.sql`
6. `05_tables_federation.sql`
7. `06_tables_misc.sql`
8. `30_rls_policies.sql`
9. `50_realtime.sql`
10. `99_storage_buckets.sql`

### 1.5 Configure Instance Domain

After creating the schema, update the instance config:

```sql
UPDATE instance_config 
SET config_value = '"your-domain.vercel.app"' 
WHERE config_key = 'domain';
```

---

## Step 2: Deploy to Vercel

### Option A: One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-username%2Fharmony)

### Option B: Manual Deploy

1. Fork this repository to your GitHub account
2. Go to [vercel.com](https://vercel.com) and sign in
3. Click **Add New** > **Project**
4. Select your forked repository
5. Configure build settings:
   - Framework: Vite
   - Build Command: `npm run build-only`
   - Output Directory: `dist`
6. Click **Deploy**

---

## Step 3: Configure Environment Variables

In Vercel Dashboard > Your Project > **Settings** > **Environment Variables**, add:

### Required Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `VITE_SUPABASE_URL` | `https://xxxxx.supabase.co` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` | Supabase anon key |
| `VITE_INSTANCE_DOMAIN` | `your-project.vercel.app` | Your Vercel domain |
| `VITE_INSTANCE_NAME` | `My Harmony` | Instance display name |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | Same as VITE_SUPABASE_URL |
| `SUPABASE_ANON_KEY` | `eyJ...` | Same as VITE_SUPABASE_ANON_KEY |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Supabase service role key |
| `INSTANCE_DOMAIN` | `your-project.vercel.app` | Same as VITE_INSTANCE_DOMAIN |
| `INSTANCE_NAME` | `My Harmony` | Same as VITE_INSTANCE_NAME |
| `CORS_ORIGIN` | `https://your-project.vercel.app` | Full URL with https |
| `USE_PGBOSS_QUEUE` | `false` | Disable pg-boss for serverless |

### Optional Variables

| Variable | Value | Description |
|----------|-------|-------------|
| `VITE_ENABLE_FEDERATION` | `true` | Enable ActivityPub federation |
| `VITE_ENABLE_VOICE` | `false` | Disable voice (requires LiveKit) |
| `DATABASE_URL` | Connection string | For pg-boss (if enabled) |

---

## Step 4: Redeploy

After adding environment variables:

1. Go to **Deployments** tab
2. Click the three dots on the latest deployment
3. Click **Redeploy**

---

## Step 5: Add Custom Domain (Optional)

### 5.1 Add Domain in Vercel

1. Go to **Settings** > **Domains**
2. Enter your domain: `harmony.yourdomain.com`
3. Click **Add**

### 5.2 Configure DNS

Add DNS records as shown by Vercel:

**For root domain (yourdomain.com):**
```
Type: A
Name: @
Value: 76.76.21.21
```

**For subdomain (harmony.yourdomain.com):**
```
Type: CNAME
Name: harmony
Value: cname.vercel-dns.com
```

### 5.3 Update Environment Variables

Update these variables with your custom domain:
- `VITE_INSTANCE_DOMAIN`
- `INSTANCE_DOMAIN`
- `CORS_ORIGIN`

Then redeploy.

---

## Step 6: Verify Deployment

### Test Frontend

Visit your deployment URL. You should see the Harmony login page.

### Test Federation

```bash
# WebFinger
curl https://your-domain.vercel.app/.well-known/webfinger?resource=acct:test@your-domain.vercel.app

# NodeInfo
curl https://your-domain.vercel.app/.well-known/nodeinfo
```

### Test Health

```bash
curl https://your-domain.vercel.app/health
```

---

## Limitations on Vercel

### No pg-boss Queue

Vercel serverless functions don't support persistent connections, so pg-boss can't run. Federation uses database triggers instead.

**Impact**: Slightly less reliable federation delivery. Most activities still work via triggers.

### Cold Starts

Serverless functions may have cold starts (1-3 seconds) on first request after idle period.

**Impact**: First ActivityPub request after idle may be slower.

### No Voice/Video

LiveKit requires a persistent WebSocket server, which Vercel doesn't support.

**Workaround**: Deploy LiveKit separately on a VPS, update `VITE_LIVEKIT_URL`.

### No Bot Gateway

Bot gateway requires persistent WebSocket connections.

**Workaround**: Deploy bot-gateway separately on a VPS.

---

## Upgrading

To update your deployment:

1. Pull latest changes to your fork
2. Vercel will automatically redeploy

Or manually:
```bash
git fetch upstream
git merge upstream/main
git push
```

---

## Troubleshooting

### "Invalid API Key" Error

- Verify `VITE_SUPABASE_ANON_KEY` is correct
- Check it's the `anon` key, not `service_role`

### Federation Not Working

- Check `INSTANCE_DOMAIN` doesn't include `https://`
- Verify `CORS_ORIGIN` includes `https://`
- Test `/health` endpoint returns 200

### Database Errors

- Verify schema was initialized (all SQL files run)
- Check `instance_config` has correct domain

### Build Failures

- Ensure all environment variables are set
- Check Vercel build logs for specific errors

---

## Next Steps

1. **Register an account** on your instance
2. **Configure settings** in Admin Panel
3. **Follow users** from other Mastodon/Misskey instances
4. **Create your first post!**

---

## Support

- [GitHub Issues](https://github.com/your-username/harmony/issues)
- [Discord Community](#)
- [Documentation](docs/)

