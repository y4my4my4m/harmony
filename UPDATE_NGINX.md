# Update Nginx for Federation Backend

## What Changed

**OLD**: Supabase Edge Functions (`localhost:8000/functions/v1/...`)  
**NEW**: Federation Backend (`localhost:3001/...`)

---

## Quick Update

```bash
# 1. Backup current config
sudo cp /etc/nginx/sites-available/harmony /etc/nginx/sites-available/harmony.backup

# 2. Copy new config
sudo cp nginx-harmony-updated.conf /etc/nginx/sites-available/harmony

# 3. Test config
sudo nginx -t

# 4. If OK, reload
sudo systemctl reload nginx

# 5. If errors, restore backup
# sudo cp /etc/nginx/sites-available/harmony.backup /etc/nginx/sites-available/harmony
```

---

## What's Different

### Before (Edge Functions):
```nginx
location ~ ^/users/[^/]+$ {
    rewrite ^/users/([^/]+)$ /functions/v1/actor break;
    proxy_pass http://localhost:8000;  # Supabase Edge Function
}
```

### After (Federation Backend):
```nginx
location ~ ^/users/[^/]+$ {
    proxy_pass http://localhost:3001;  # Federation Backend
    # No rewrite needed!
}
```

---

## Key Changes

1. **All `/users/*` routes** → `localhost:3001`
2. **All `/.well-known/*` routes** → `localhost:3001`
3. **All `/servers/*` routes** → `localhost:3001` (NEW!)
4. **Removed `/functions/v1/` rewrites** → Direct proxy
5. **Frontend serving** → Unchanged (still serves from dist/)

---

## What Routes Got Updated

| Endpoint | OLD | NEW |
|----------|-----|-----|
| WebFinger | Edge Function | Federation Backend |
| NodeInfo | Edge Function | Federation Backend |
| Actor | Edge Function | Federation Backend |
| Inbox | Edge Function | Federation Backend |
| Outbox | Edge Function | Federation Backend |
| Followers | Edge Function | Federation Backend |
| Following | Edge Function | Federation Backend |
| Featured | Edge Function | Federation Backend |
| Servers | ❌ Didn't exist | ✅ Federation Backend |

---

## Testing After Update

### 1. Check Nginx Syntax
```bash
sudo nginx -t
# Should say: syntax is ok
```

### 2. Reload Nginx
```bash
sudo systemctl reload nginx
```

### 3. Test WebFinger
```bash
curl https://har.mony.lol/.well-known/webfinger?resource=acct:youruser@har.mony.lol
```

Should return user info!

### 4. Test NodeInfo
```bash
curl https://har.mony.lol/.well-known/nodeinfo
```

Should return nodeinfo links!

### 5. Test User Actor
```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/youruser
```

Should return Actor JSON!

---

## Federation Backend Must Be Running!

**Before updating nginx**, start federation backend:

```bash
cd ~/gits/hobby/harmony/federation-backend

# Option 1: Direct
npm run dev

# Option 2: Docker
docker compose up -d
```

**Verify it's running**:
```bash
curl http://localhost:3001/health
# Should return: {"status":"healthy",...}
```

**Then** update nginx!

---

## Rollback If Needed

```bash
# Restore backup
sudo cp /etc/nginx/sites-available/harmony.backup /etc/nginx/sites-available/harmony

# Reload
sudo systemctl reload nginx
```

---

## Configuration Check

**Federation Backend `.env`**:
```bash
INSTANCE_DOMAIN=har.mony.lol  # NO http://, NO trailing slash!
```

**This is used to generate ActivityPub URLs**:
- `https://har.mony.lol/users/alice`
- `https://har.mony.lol/servers/gaming-hub`

---

## Summary

**Changes**:
- ✅ All federation endpoints → Federation backend (port 3001)
- ✅ Frontend still served from dist/
- ✅ SSL still works
- ✅ Supabase still accessible (port 8000)

**Requirements**:
1. Federation backend running on port 3001
2. Nginx updated with new config
3. `.env` has `INSTANCE_DOMAIN=har.mony.lol`

---

**Follow the Quick Update steps above!** 🚀

