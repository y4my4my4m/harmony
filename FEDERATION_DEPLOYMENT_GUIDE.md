# Federation Backend Deployment Guide

## The Architecture

```
Internet
  ↓
Nginx (Port 80/443)
  ├─→ / → Frontend (static files)
  ├─→ /.well-known/* → Federation Backend
  ├─→ /users/* → Federation Backend
  ├─→ /servers/* → Federation Backend
  └─→ /inbox → Federation Backend
```

**Federation backend MUST be publicly accessible!**

---

## Why Federation Backend Needs Public Access

Remote instances need to:
- **POST** to your `/inbox` (receive activities)
- **GET** your `/users/:username` (fetch Actor)
- **GET** your `/.well-known/webfinger` (discover users/servers)
- **POST** to `/servers/:serverId/inbox` (server federation)

**Without public access**: Federation doesn't work!

---

## Deployment Options

### Option 1: Nginx Proxy (Recommended)

**Setup**:
```bash
# 1. Install nginx
sudo apt install nginx

# 2. Copy config
sudo cp nginx-federation.conf /etc/nginx/sites-available/harmony
sudo ln -s /etc/nginx/sites-available/harmony /etc/nginx/sites-enabled/

# 3. Edit config
sudo nano /etc/nginx/sites-available/harmony
# Change: server_name, root path

# 4. Test config
sudo nginx -t

# 5. Reload
sudo systemctl reload nginx
```

**What it does**:
- Serves frontend static files
- Proxies ActivityPub endpoints to federation backend
- Handles SSL termination (with Let's Encrypt)

---

### Option 2: All-in-One Docker

Create `docker-compose.full.yml` with nginx + frontend + federation:

```yaml
version: "3.8"

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf
      - ../dist:/var/www/harmony/dist
    depends_on:
      - federation-backend

  federation-backend:
    build: .
    env_file:
      - .env
    expose:
      - "3001"

  # Optional: Supabase (if self-hosting everything)
```

---

### Option 3: Vercel + Federation Backend

**Vercel handles**: Frontend + some routes  
**Your server handles**: Federation backend

```nginx
# On your server (just federation):
server {
    listen 80;
    server_name api.yourdomain.com;  # Subdomain for federation
    
    location / {
        proxy_pass http://localhost:3001;
    }
}
```

**Then in federation backend `.env`**:
```bash
INSTANCE_DOMAIN=yourdomain.com  # Main domain (not api subdomain!)
```

**Vercel config** (`vercel.json`):
```json
{
  "rewrites": [
    {
      "source": "/.well-known/:path*",
      "destination": "https://api.yourdomain.com/.well-known/:path*"
    },
    {
      "source": "/users/:path*",
      "destination": "https://api.yourdomain.com/users/:path*"
    },
    {
      "source": "/servers/:path*",
      "destination": "https://api.yourdomain.com/servers/:path*"
    },
    {
      "source": "/inbox",
      "destination": "https://api.yourdomain.com/inbox"
    }
  ]
}
```

---

## URL Configuration

### Federation Backend `.env`

**CRITICAL**: Set the correct domain!

```bash
# Production:
INSTANCE_DOMAIN=yourdomain.com  # NO http://, NO port!

# Development:
INSTANCE_DOMAIN=localhost:5173  # Include port for dev
```

**Why**: This is used to generate ActivityPub IDs:
- `https://yourdomain.com/users/alice`
- `https://yourdomain.com/servers/server-123`

---

## Testing Federation Endpoints

### WebFinger (User Discovery)
```bash
curl https://yourdomain.com/.well-known/webfinger?resource=acct:username@yourdomain.com
```

Should return JSON with user's ActivityPub URL.

### NodeInfo (Instance Info)
```bash
curl https://yourdomain.com/.well-known/nodeinfo
```

Should return nodeinfo discovery document.

### User Actor
```bash
curl -H "Accept: application/activity+json" https://yourdomain.com/users/username
```

Should return ActivityPub Person actor.

### Server as Group
```bash
curl -H "Accept: application/activity+json" https://yourdomain.com/servers/server-id
```

Should return ActivityPub Group actor.

---

## Security Considerations

### Rate Limiting

Add to nginx:
```nginx
limit_req_zone $binary_remote_addr zone=federation:10m rate=10r/s;

location /inbox {
    limit_req zone=federation burst=20;
    proxy_pass http://localhost:3001;
}
```

### Firewall

```bash
# Allow only necessary ports
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# Don't expose 3001 directly!
```

---

## Common Issues

### Federation Not Working

**Check**:
1. Is federation backend running? `curl http://localhost:3001/health`
2. Is nginx proxying? `curl https://yourdomain.com/health`
3. Is `INSTANCE_DOMAIN` correct in `.env`?
4. Are endpoints publicly accessible?

### URLs Wrong

**If ActivityPub IDs are**:
- `https://localhost/users/...` ❌ Wrong!
- `http://yourdomain.com/users/...` ❌ Should be https!
- `https://yourdomain.com/users/...` ✅ Correct!

**Fix**: Set `INSTANCE_DOMAIN=yourdomain.com` (no protocol, no port!)

**In code**: URLs are built as `https://${INSTANCE_DOMAIN}/users/...`

---

## Production Deployment Checklist

- [ ] Federation backend running (Docker or npm start)
- [ ] Nginx configured and running
- [ ] SSL certificate installed (Let's Encrypt)
- [ ] `.env` has correct `INSTANCE_DOMAIN`
- [ ] Firewall allows 80/443
- [ ] Port 3001 NOT exposed directly (nginx proxy only)
- [ ] Test WebFinger: `curl https://yourdomain.com/.well-known/webfinger?resource=acct:user@yourdomain.com`
- [ ] Test NodeInfo: `curl https://yourdomain.com/.well-known/nodeinfo`
- [ ] Test inbox (from remote): Works!

---

## Smart Routing (Already Implemented!)

**Yes! We have smart routing:**

### For Messages:
- Database trigger checks if server has remote members
- If yes → federation backend notifies
- If no → skip federation (local only!)

### For URLs:
- Federation backend uses `INSTANCE_DOMAIN` from `.env`
- Generates correct URLs: `https://${INSTANCE_DOMAIN}/users/...`
- As long as nginx proxies correctly, it works!

---

## Summary

**YES, you need**:
1. ✅ Nginx config to proxy federation endpoints
2. ✅ Public access to federation backend (via nginx)
3. ✅ Correct `INSTANCE_DOMAIN` in `.env`
4. ✅ SSL certificate (Let's Encrypt)

**NO, you don't**:
5. ❌ Expose port 3001 directly (nginx proxies it!)
6. ❌ Change URLs everywhere (uses INSTANCE_DOMAIN!)

**I created**: `nginx-federation.conf` - copy and use!

---

**Check the nginx config I created - it's ready to use!** 🚀

