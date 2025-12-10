# Harmony Installation Guide

Complete guide for deploying your own Harmony instance.

## Table of Contents

1. [Choose Your Deployment Method](#choose-your-deployment-method)
2. [Method 1: Vercel + Supabase Cloud](#method-1-vercel--supabase-cloud-easiest)
3. [Method 2: Docker Compose](#method-2-docker-compose-recommended)
4. [Method 3: Manual VPS Setup](#method-3-manual-vps-setup)
5. [Database Setup](#database-setup)
6. [Post-Installation](#post-installation)
7. [Troubleshooting](#troubleshooting)

---

## Choose Your Deployment Method

| Method | Best For | Difficulty | Monthly Cost | Features |
|--------|----------|------------|--------------|----------|
| **Vercel + Supabase Cloud** | Quick start, testing | Easy | Free* | ⚠️ No voice, limited federation |
| **Docker Compose + Cloud Services** | Production, medium traffic | Medium | ~$5-10 | ✅ Full features |
| **Full Self-Hosted VPS** | Full control, privacy | Advanced | ~$10-20 | ✅ Full features |

**\*Vercel Limitations**: Serverless architecture means no persistent connections (pg-boss disabled), no WebSocket support (no voice/video, no bot gateway). Good for testing, not recommended for production.

### Recommended Services (with Free Tiers)

| Service | Free Tier | Used For |
|---------|-----------|----------|
| [Supabase Cloud](https://supabase.com) | ✅ 500MB DB, 1GB storage | Database, Auth, Storage |
| [LiveKit Cloud](https://livekit.io) | ✅ Limited minutes | Voice/Video |
| [Resend](https://resend.com) | ✅ 3,000 emails/month | Transactional emails |
| [Railway](https://railway.app) / [Render](https://render.com) | ⚠️ ~$5/mo minimum | Backend hosting |

---

## Method 1: Vercel + Supabase Cloud (Easiest)

Perfect for getting started quickly with minimal configuration.

### Step 1: Set Up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for the database to initialize (~2 minutes)
3. Go to **SQL Editor** and run the database schema:
   - Navigate to `db_schema/init/` in this repository
   - Run each SQL file in order (00, 01, 02, etc.)
   - Or run the combined `init.sql` script

4. Copy your credentials from **Settings > API**:
   - Project URL (e.g., `https://xxxxx.supabase.co`)
   - `anon` public key
   - `service_role` secret key

### Step 2: Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fyour-username%2Fharmony)

Or deploy manually:

```bash
# Install Vercel CLI
npm i -g vercel

# Clone and deploy
git clone https://github.com/your-username/harmony.git
cd harmony
vercel
```

### Step 3: Configure Environment Variables

In Vercel Dashboard > Settings > Environment Variables, add:

```env
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_INSTANCE_DOMAIN=your-vercel-domain.vercel.app
VITE_INSTANCE_NAME=My Harmony Instance

# Federation backend (same deployment)
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
INSTANCE_DOMAIN=your-vercel-domain.vercel.app
INSTANCE_NAME=My Harmony Instance
CORS_ORIGIN=https://your-vercel-domain.vercel.app

# Disable pg-boss for serverless (uses database triggers instead)
USE_PGBOSS_QUEUE=false
```

### Step 4: Add Custom Domain (Optional)

1. In Vercel Dashboard > Settings > Domains
2. Add your custom domain
3. Update DNS records as instructed
4. Update `VITE_INSTANCE_DOMAIN` and `INSTANCE_DOMAIN` to your domain

### Vercel Limitations

- Federation relies on database triggers (no pg-boss queue)
- Cold starts may affect ActivityPub response times
- Voice/video features require separate LiveKit deployment

---

## Method 2: Docker Compose (Recommended)

Full control with easy deployment. Choose between using Supabase Cloud or self-hosting Supabase.

### Option A: With Supabase Cloud

Use Supabase Cloud for the database, Docker for everything else.

```bash
# Clone the repository
git clone https://github.com/your-username/harmony.git
cd harmony

# Install dependencies and build frontend
npm install
npm run build-only

# Configure environment
cp env.example .env
cp federation-backend/env.template federation-backend/.env
# Edit both .env files with your Supabase credentials

# Start services
docker compose -f docker-compose.prod.yml up -d
```

### Option B: Fully Self-Hosted (with Supabase)

Run your own Supabase instance alongside Harmony.

```bash
# 1. Clone and set up Supabase
git clone https://github.com/supabase/supabase.git
cd supabase/docker
cp .env.example .env
# Edit .env with secure passwords

# Start Supabase
docker compose up -d

# 2. Clone and set up Harmony
cd ../..
git clone https://github.com/your-username/harmony.git
cd harmony

# Build frontend
npm install
npm run build-only

# Configure environment
cp env.example .env
cp federation-backend/env.template federation-backend/.env
# Edit .env files - use internal Docker URLs for Supabase

# 3. Initialize database
cd ../supabase/docker
docker exec -i supabase-db psql -U postgres -d postgres < ../../harmony/db_schema/init/init.sql

# 4. Start Harmony
cd ../../harmony
docker compose -f docker-compose.full.yml up -d
```

### Enable Voice/Video (Optional)

```bash
# Start with voice profile
docker compose -f docker-compose.full.yml --profile voice up -d

# Configure LiveKit
cp webrtc/livekit.yaml.example webrtc/livekit.yaml
# Edit livekit.yaml with your API keys
```

### Enable Bot Gateway (Optional)

```bash
# Start with bots profile
docker compose -f docker-compose.full.yml --profile bots up -d
```

---

## Method 3: Manual VPS Setup

For advanced users who want full control.

### Prerequisites

- Ubuntu 22.04+ or Debian 12+
- Node.js 20+
- Nginx
- PostgreSQL 15+ (or Supabase)

### Step 1: Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install nginx
sudo apt install -y nginx

# Install certbot for SSL
sudo apt install -y certbot python3-certbot-nginx
```

### Step 2: Clone and Build

```bash
# Clone repository
git clone https://github.com/your-username/harmony.git
cd harmony

# Install dependencies
npm install
cd federation-backend && npm install && cd ..

# Build frontend
npm run build-only

# Build backend
cd federation-backend && npm run build && cd ..
```

### Step 3: Configure Environment

```bash
# Frontend
cp env.example .env
nano .env

# Federation backend
cp federation-backend/env.template federation-backend/.env
nano federation-backend/.env
```

### Step 4: Set Up Nginx

```bash
# Copy nginx config
sudo cp nginx-harmony.conf /etc/nginx/sites-available/harmony

# Edit with your domain
sudo nano /etc/nginx/sites-available/harmony
# Replace 'har.mony.lol' with your domain
# Update paths as needed

# Enable site
sudo ln -s /etc/nginx/sites-available/harmony /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 5: Get SSL Certificate

```bash
sudo certbot --nginx -d your-domain.com
```

### Step 6: Set Up Services

Create systemd service for federation backend:

```bash
sudo nano /etc/systemd/system/harmony-federation.service
```

```ini
[Unit]
Description=Harmony Federation Backend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/harmony/federation-backend
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable harmony-federation
sudo systemctl start harmony-federation
```

---

## Database Setup

### Running the Schema

The database schema is in `db_schema/init/`. Run files in order:

```bash
# For self-hosted Supabase
psql -h localhost -p 54322 -U postgres -d postgres

# Run each file
\i db_schema/init/00_extensions.sql
\i db_schema/init/01_types.sql
\i db_schema/init/02_tables_core.sql
\i db_schema/init/03_tables_social.sql
\i db_schema/init/04_tables_servers.sql
\i db_schema/init/05_tables_federation.sql
\i db_schema/init/06_tables_misc.sql
\i db_schema/init/30_rls_policies.sql
\i db_schema/init/50_realtime.sql
\i db_schema/init/99_storage_buckets.sql
```

### For Supabase Cloud

1. Go to SQL Editor in Dashboard
2. Create a new query
3. Paste contents of each file and run
4. Or use the Supabase CLI:

```bash
supabase db push
```

---

## Post-Installation

### 1. Create Admin Account

1. Register a new account on your instance
2. The first user automatically gets admin privileges
3. Or manually set admin in database:

```sql
UPDATE profiles SET is_admin = true WHERE username = 'your-username';
```

### 2. Configure Instance

Go to Settings > Admin Panel and configure:
- Instance name and description
- Registration settings
- Federation settings

### 3. Update Instance Config

```sql
UPDATE instance_config SET config_value = '"your-domain.com"' WHERE config_key = 'domain';
UPDATE instance_config SET config_value = '"Your Instance Name"' WHERE config_key = 'name';
```

### 4. Test Federation

```bash
# Test WebFinger
curl https://your-domain.com/.well-known/webfinger?resource=acct:admin@your-domain.com

# Test NodeInfo
curl https://your-domain.com/.well-known/nodeinfo
```

---

## Troubleshooting

### Federation Not Working

1. Check backend is running:
   ```bash
   curl http://localhost:3001/health
   ```

2. Verify `INSTANCE_DOMAIN` is set correctly (no `https://`, no trailing slash)

3. Check nginx is proxying correctly:
   ```bash
   curl -v https://your-domain.com/.well-known/nodeinfo
   ```

### Database Connection Issues

1. Verify `DATABASE_URL` format:
   - Self-hosted: `postgresql://supabase_admin:password@localhost:54322/postgres`
   - Supabase Cloud: `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres`

2. Check pg-boss tables exist:
   ```sql
   SELECT * FROM pgboss.job LIMIT 1;
   ```

### Storage/Upload Issues

1. Verify storage buckets exist in Supabase Dashboard
2. Check RLS policies on storage.objects
3. Verify `VITE_SUPABASE_URL` is accessible from browser

### Voice/Video Not Working

1. Check LiveKit is running:
   ```bash
   curl http://localhost:7880
   ```

2. Verify `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` match in:
   - `federation-backend/.env`
   - `webrtc/livekit.yaml`

3. For production, ensure TURN server is configured

---

## Email Setup (Recommended)

Harmony uses email for:
- User registration confirmations (via Supabase Auth)
- Password reset emails (via Supabase Auth)
- Notification emails (via federation-backend)

### Option 1: Resend (Recommended)

[Resend](https://resend.com) offers 3,000 emails/month free.

**Step 1: Get Resend API Key**
1. Sign up at [resend.com](https://resend.com)
2. Add and verify your domain
3. Create an API key

**Step 2: Configure Supabase Auth Emails**

In Supabase Dashboard:
1. Go to **Authentication** > **Email Templates**
2. Enable **Custom SMTP**
3. Enter:
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: Your API key
   - Sender email: `noreply@yourdomain.com`

**Step 3: Configure Federation Backend**

In `federation-backend/.env`:
```env
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_your_api_key
SMTP_FROM=notifications@yourdomain.com
SMTP_SECURE=true
```

### Option 2: Other SMTP Providers

Any SMTP provider works:
- **SendGrid**: 100 emails/day free
- **Mailgun**: 5,000 emails/month (3 months)
- **AWS SES**: ~$0.10/1000 emails
- **Self-hosted** (Postal, Mailcow): Free but requires setup

---

## Next Steps

- [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md) - Detailed Vercel deployment guide
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contributing guidelines
- [federation-backend/README.md](federation-backend/README.md) - Federation backend documentation

---

**Need help?** Open an issue on GitHub or join our Discord community.
