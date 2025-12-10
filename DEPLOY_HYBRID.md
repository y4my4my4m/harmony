# Harmony Hybrid Deployment Guide

The recommended way to deploy Harmony: multiple specialized platforms, each doing what they do best.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Domain                              │
│                    harmony.yourdomain.com                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│    Vercel     │   │    Render     │   │ LiveKit Cloud │
│   (Frontend)  │   │   (Backend)   │   │(Voice/Video)  │
│     FREE      │   │    ~$7/mo     │   │     FREE      │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        └─────────┬─────────┘                   │
                  ▼                             │
        ┌───────────────┐                       │
        │    Supabase   │◄──────────────────────┘
        │    Cloud      │
        │  (Database)   │
        │     FREE      │
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │    Resend     │
        │    (Email)    │
        │     FREE      │
        └───────────────┘
```

## Cost Breakdown

| Service | Plan | Monthly Cost |
|---------|------|--------------|
| Vercel | Hobby | **$0** |
| Supabase | Free | **$0** |
| Render | Starter | **~$7** |
| LiveKit Cloud | Free | **$0** |
| Resend | Free | **$0** |
| **Total** | | **~$7/month** |

---

## Step 1: Set Up Supabase (5 minutes)

### 1.1 Create Project

1. Go to [supabase.com](https://supabase.com) and sign up/in
2. Click **New Project**
3. Enter project name, generate a strong database password, select region
4. Click **Create new project** and wait ~2 minutes

### 1.2 Initialize Database

1. Go to **SQL Editor**
2. Run each file from `db_schema/init/` in order:
   - `00_extensions.sql`
   - `01_types.sql`
   - `02_tables_core.sql` through `06_tables_misc.sql`
   - `30_rls_policies.sql`
   - `50_realtime.sql`
   - `98_seed_data.sql`
   - `99_storage_buckets.sql`

3. Update your domain:
```sql
UPDATE instance_config 
SET config_value = '"harmony.yourdomain.com"' 
WHERE config_key = 'domain';
```

### 1.3 Get Credentials

Go to **Settings > API** and copy:
- **Project URL**: `https://xxxxx.supabase.co`
- **anon public key**: `eyJ...`
- **service_role secret**: `eyJ...`

Go to **Settings > Database** and copy:
- **Connection string** (URI format): `postgresql://postgres.[ref]:[pwd]@...`

---

## Step 2: Set Up Resend (3 minutes)

1. Go to [resend.com](https://resend.com) and sign up
2. **Add Domain** → Add your domain (e.g., `yourdomain.com`)
3. **Add DNS Records** as shown (usually 3 TXT records)
4. Wait for verification (usually instant)
5. **Create API Key** → Copy the key (starts with `re_`)

### Configure Supabase Auth Emails

1. In Supabase, go to **Authentication > Email Templates**
2. Click **Enable Custom SMTP**
3. Enter:
   - **Host**: `smtp.resend.com`
   - **Port**: `465`
   - **Username**: `resend`
   - **Password**: Your Resend API key
   - **Sender email**: `noreply@yourdomain.com`

---

## Step 3: Deploy Backend to Render (5 minutes)

### One-Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_USERNAME/harmony)

### Or Manual Setup

1. Go to [render.com](https://render.com) and sign up
2. Click **New > Blueprint**
3. Connect your GitHub repo
4. Render will detect `render.yaml` and create services

### Configure Environment Variables

In Render Dashboard, go to your `harmony-federation` service > **Environment**:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Your anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service role key |
| `DATABASE_URL` | Your Supabase connection string |
| `INSTANCE_DOMAIN` | `harmony.yourdomain.com` |
| `CORS_ORIGIN` | `https://harmony.yourdomain.com` |
| `SMTP_PASS` | Your Resend API key |
| `SMTP_FROM` | `notifications@yourdomain.com` |

### Note Your Backend URL

After deployment, note your Render URL (e.g., `harmony-federation.onrender.com`)

---

## Step 4: Set Up LiveKit Cloud (3 minutes)

*Skip if you don't need voice/video*

1. Go to [cloud.livekit.io](https://cloud.livekit.io) and sign up
2. Create a new project
3. Go to **Settings > Keys** and create an API key
4. Copy:
   - **API Key**: `API...`
   - **Secret Key**: `...`
   - **WebSocket URL**: `wss://xxx.livekit.cloud`

5. Add to Render environment variables:
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
   - `LIVEKIT_URL`

---

## Step 5: Deploy Frontend to Vercel (5 minutes)

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYOUR_USERNAME%2Fharmony&env=VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY,VITE_INSTANCE_DOMAIN,VITE_INSTANCE_NAME)

### Configure Environment Variables

In Vercel Dashboard > Settings > Environment Variables:

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your anon key |
| `VITE_INSTANCE_DOMAIN` | `harmony.yourdomain.com` |
| `VITE_INSTANCE_NAME` | `My Harmony` |
| `VITE_FEDERATION_API_URL` | `https://harmony-federation.onrender.com` |
| `VITE_LIVEKIT_URL` | `wss://xxx.livekit.cloud` (if using voice) |
| `VITE_ENABLE_VOICE` | `true` or `false` |

### Add Custom Domain

1. In Vercel, go to **Settings > Domains**
2. Add `harmony.yourdomain.com`
3. Configure DNS as shown

---

## Step 6: Configure DNS & Routing

Your domain needs to route to both Vercel (frontend) and Render (backend API).

### Option A: Vercel Handles Everything (Recommended)

Add rewrites in `vercel.json` to proxy API requests to Render:

```json
{
  "rewrites": [
    { "source": "/.well-known/:path*", "destination": "https://harmony-federation.onrender.com/.well-known/:path*" },
    { "source": "/users/:path*", "destination": "https://harmony-federation.onrender.com/users/:path*" },
    { "source": "/inbox", "destination": "https://harmony-federation.onrender.com/inbox" },
    { "source": "/nodeinfo/:path*", "destination": "https://harmony-federation.onrender.com/nodeinfo/:path*" },
    { "source": "/link-preview/:path*", "destination": "https://harmony-federation.onrender.com/link-preview/:path*" },
    { "source": "/api/:path*", "destination": "https://harmony-federation.onrender.com/api/:path*" }
  ]
}
```

### Option B: Cloudflare Workers (Advanced)

Use Cloudflare to route based on path. More complex but more flexible.

---

## Step 7: Verify Deployment

### Test Frontend
Visit `https://harmony.yourdomain.com` - should see login page

### Test Federation
```bash
# WebFinger
curl https://harmony.yourdomain.com/.well-known/webfinger?resource=acct:test@harmony.yourdomain.com

# NodeInfo
curl https://harmony.yourdomain.com/.well-known/nodeinfo

# Health
curl https://harmony-federation.onrender.com/health
```

### Register First User
1. Go to your instance
2. Register an account
3. First user automatically becomes admin

---

## Troubleshooting

### Backend not responding
- Check Render dashboard for errors
- Verify all environment variables are set
- Check health endpoint: `curl https://harmony-federation.onrender.com/health`

### Federation not working
- Verify `INSTANCE_DOMAIN` matches your actual domain
- Check Vercel rewrites are working
- Test WebFinger endpoint directly

### Emails not sending
- Verify Resend domain is verified
- Check `SMTP_PASS` is set correctly
- Test Supabase Auth emails in Dashboard

### Voice not working
- Verify LiveKit credentials are set
- Check `VITE_LIVEKIT_URL` in Vercel env vars
- Ensure `VITE_ENABLE_VOICE=true`

---

## Upgrading

### Frontend (Vercel)
Automatic on push to main branch

### Backend (Render)
Automatic on push to main branch

### Database (Supabase)
Run new migration files in SQL Editor

---

## Cost Optimization Tips

1. **Combine services**: Run bot-gateway in same Render service as federation-backend
2. **Use Supabase for everything**: Edge Functions instead of Render (but less reliable for federation)
3. **Self-host LiveKit**: On a cheap VPS if you have high voice usage

---

## Next Steps

- [Configure Admin Panel](docs/admin-setup.md)
- [Set up Federation](docs/federation.md)
- [Enable Voice/Video](docs/voice-setup.md)

