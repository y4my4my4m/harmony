# Harmony Installation Guide

Complete guide for installing and deploying Harmony.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Vercel Deployment](#vercel-deployment)
3. [Docker Deployment](#docker-deployment)
4. [Manual Installation](#manual-installation)
5. [Post-Installation](#post-installation)
6. [Troubleshooting](#troubleshooting)

---

## Quick Start

The fastest way to get Harmony running:

### Option 1: Vercel (Recommended for beginners)
```bash
# Click the deploy button in DEPLOY_TO_VERCEL.md
# Or use Vercel CLI:
vercel deploy
```

### Option 2: Docker Compose
```bash
# Clone the repository
git clone https://github.com/your-username/harmony.git
cd harmony

# Copy environment file
cp .env.example .env
# Edit .env with your configuration

# Start with Docker Compose
docker-compose -f docker-compose.full.yml up -d
```

### Option 3: Development Mode
```bash
# Clone and install
git clone https://github.com/your-username/harmony.git
cd harmony
npm install
cd backend && npm install

# Configure environment
cp .env.example .env
cd backend && cp .env.example .env
# Edit both .env files

# Start development servers
npm run dev                    # Terminal 1: Frontend
cd backend && npm run dev      # Terminal 2: Backend
```

---

## Vercel Deployment

### Prerequisites
- Vercel account (free tier works)
- Supabase account (free tier works)
- GitHub account
- Custom domain (optional)

### Step 1: Prepare Supabase

1. **Create Supabase Project**
   - Visit [supabase.com](https://supabase.com)
   - Click "New Project"
   - Fill in project details
   - Wait for database to initialize

2. **Import Database Schema**
   ```bash
   # Download schema
   wget https://raw.githubusercontent.com/your-username/harmony/main/harmonious/supabase_schema_backup_latest.sql
   
   # In Supabase Dashboard:
   # SQL Editor → New Query → Paste schema → Run
   ```

3. **Get Credentials**
   - Settings → API
   - Copy `URL`, `anon key`, and `service_role key`

### Step 2: Deploy to Vercel

1. **Fork Repository**
   - Fork harmony repository to your GitHub

2. **Create Vercel Project**
   - Visit [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your forked repository

3. **Configure Environment Variables**
   ```env
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   INSTANCE_DOMAIN=your-domain.com
   INSTANCE_NAME=Harmony
   INSTANCE_DESCRIPTION=My federated social platform
   CORS_ORIGIN=https://your-domain.com
   NODE_ENV=production
   ```

4. **Deploy**
   - Click "Deploy"
   - Wait for build to complete
   - Visit your deployment URL

### Step 3: Custom Domain (Optional)

1. In Vercel Dashboard → Settings → Domains
2. Add your custom domain
3. Configure DNS records:
   ```
   Type: CNAME
   Name: www
   Value: cname.vercel-dns.com
   
   Type: A
   Name: @
   Value: 76.76.21.21
   ```

### Step 4: Enable Features

1. **WebFinger**
   - Verify: `https://your-domain.com/.well-known/webfinger?resource=acct:admin@your-domain.com`

2. **NodeInfo**
   - Verify: `https://your-domain.com/.well-known/nodeinfo`

---

## Docker Deployment

### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+
- 2GB RAM minimum
- 10GB disk space

### Full Stack (Postgres + Redis + Backend + Frontend)

1. **Clone Repository**
   ```bash
   git clone https://github.com/your-username/harmony.git
   cd harmony
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   nano .env  # Edit configuration
   ```

3. **Start Services**
   ```bash
   docker-compose -f docker-compose.full.yml up -d
   ```

4. **Initialize Database**
   ```bash
   # Import schema
   docker exec -i harmony-postgres psql -U harmony harmony < harmonious/supabase_schema_backup_latest.sql
   ```

5. **Verify**
   - Frontend: http://localhost:8080
   - Backend API: http://localhost:3001
   - Health: http://localhost:3001/health

### Development Mode (Hot Reload)

```bash
# Start development stack
docker-compose -f docker-compose.dev.yml up

# Logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop
docker-compose -f docker-compose.dev.yml down
```

### With External Supabase

If using Supabase cloud instead of local Postgres:

1. Update `docker-compose.yml`:
   ```yaml
   # Remove postgres service
   # Update backend environment:
   SUPABASE_URL: https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY: your-key
   ```

2. Start without Postgres:
   ```bash
   docker-compose up backend frontend redis
   ```

---

## Manual Installation

For advanced users who want full control.

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- Redis 7+
- Nginx (for production)

### Step 1: Clone and Install

```bash
# Clone repository
git clone https://github.com/your-username/harmony.git
cd harmony

# Install frontend dependencies
npm install

# Install backend dependencies
cd backend
npm install
cd ..
```

### Step 2: Database Setup

```bash
# Create database
createdb harmony

# Import schema
psql harmony < harmonious/supabase_schema_backup_latest.sql

# Or use Supabase cloud (recommended)
```

### Step 3: Configure Environment

```bash
# Frontend (.env)
cp .env.example .env
nano .env
```

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_API_URL=http://localhost:3001
```

```bash
# Backend (backend/.env)
cd backend
cp .env.example .env
nano .env
```

```env
NODE_ENV=production
PORT=3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
INSTANCE_DOMAIN=your-domain.com
REDIS_URL=redis://localhost:6379
```

### Step 4: Build

```bash
# Build frontend
npm run build

# Build backend
cd backend
npm run build
```

### Step 5: Start Services

```bash
# Start Redis
redis-server

# Start backend
cd backend
npm start

# Serve frontend with nginx or similar
```

### Step 6: Nginx Configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Frontend
    location / {
        root /path/to/harmony/dist;
        try_files $uri $uri/ /index.html;
    }

    # Backend API
    location /api {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # ActivityPub endpoints
    location ~ ^/(\.well-known|users|nodeinfo) {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
    }
}
```

---

## Post-Installation

### Step 1: Create Admin Account

1. Visit your instance URL
2. Click "Register"
3. Create your account
4. First user gets admin privileges

### Step 2: Configure Instance

1. Go to Settings → Admin Panel
2. Set instance details:
   - Name
   - Description
   - Rules
   - Contact email

### Step 3: Test Federation

1. **Test WebFinger**:
   ```bash
   curl https://your-domain.com/.well-known/webfinger?resource=acct:admin@your-domain.com
   ```

2. **Test NodeInfo**:
   ```bash
   curl https://your-domain.com/.well-known/nodeinfo
   ```

3. **Test Following**:
   - Search for a Mastodon user: `@user@mastodon.social`
   - Click Follow
   - Check if follow request appears on their end

### Step 4: Set Up Cron Jobs

For delivery queue processing:

```bash
# Add to crontab
*/5 * * * * curl -X POST http://localhost:3001/api/activitypub/process-delivery
```

Or use a cron service like cron-job.org.

### Step 5: Enable HTTPS

Use Let's Encrypt:

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo certbot renew --dry-run
```

---

## Troubleshooting

### Frontend Won't Load

**Check:**
- Is backend running? `curl http://localhost:3001/health`
- Are environment variables set correctly?
- Check browser console for errors

**Fix:**
```bash
# Rebuild frontend
npm run build

# Clear cache
rm -rf node_modules/.vite
npm run dev
```

### Backend Errors

**Check:**
- Database connection: `psql -h localhost -U harmony`
- Supabase credentials in `.env`
- Redis running: `redis-cli ping`

**Fix:**
```bash
# View logs
cd backend
npm run dev  # See detailed logs

# Test database
curl http://localhost:3001/health
```

### Federation Not Working

**Check:**
- Is INSTANCE_DOMAIN correct? (no http://, no trailing slash)
- Is your instance publicly accessible?
- Are HTTP signatures working?

**Debug:**
```bash
# Test WebFinger
curl -v https://your-domain.com/.well-known/webfinger?resource=acct:admin@your-domain.com

# Check logs
docker-compose logs -f backend
```

### Database Migration Fails

**Fix:**
```bash
# Backup current database
pg_dump harmony > backup.sql

# Drop and recreate
dropdb harmony
createdb harmony

# Re-import schema
psql harmony < harmonious/supabase_schema_backup_latest.sql
```

### Performance Issues

**Optimize:**
- Enable Redis caching
- Add database indexes
- Use CDN for assets
- Enable compression in nginx

```bash
# Check slow queries
psql harmony -c "SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;"
```

---

## Upgrade Guide

### From Previous Version

1. **Backup**
   ```bash
   # Database
   pg_dump harmony > backup_$(date +%Y%m%d).sql
   
   # Files
   tar -czf harmony_backup.tar.gz dist backend/dist .env
   ```

2. **Pull Updates**
   ```bash
   git pull origin main
   npm install
   cd backend && npm install
   ```

3. **Run Migrations**
   ```bash
   # Apply any new schema changes
   psql harmony < db_schema/migrations/latest.sql
   ```

4. **Rebuild**
   ```bash
   npm run build
   cd backend && npm run build
   ```

5. **Restart**
   ```bash
   docker-compose down
   docker-compose up -d
   ```

---

## Support

- **Documentation**: Check ARCHITECTURE.md and README.md
- **Issues**: [GitHub Issues](https://github.com/your-username/harmony/issues)
- **Community**: Join our Discord (link in README)

---

## Next Steps

1. Customize your instance appearance
2. Invite users
3. Set up moderation tools
4. Join the fediverse!

Happy federating! 🎵

