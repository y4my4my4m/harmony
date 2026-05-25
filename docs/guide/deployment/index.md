# Production Deployment

This guide covers deploying Harmony to production environments with proper security, scalability, and monitoring.

## Deployment Architecture

```mermaid
graph TB
    subgraph "Client"
        BROWSER[Web Browser]
        PWA[PWA App]
    end
    
    subgraph "Load Balancer"
        CLOUDFLARE[Cloudflare]
        SSL[SSL Termination]
    end
    
    subgraph "Application Server"
        NGINX[Nginx Proxy]
        HARMONY[Harmony App]
        STATIC[Static Files]
    end
    
    subgraph "Backend Services"
        SUPABASE[Supabase]
        POSTGRES[(PostgreSQL)]
        REALTIME[Realtime Engine]
        EDGE_FUNC[Edge Functions]
    end
    
    subgraph "Storage"
        OBJECT_STORAGE[Object Storage]
        MEDIA_CDN[Media CDN]
    end
    
    BROWSER --> CLOUDFLARE
    PWA --> CLOUDFLARE
    CLOUDFLARE --> SSL
    SSL --> NGINX
    NGINX --> HARMONY
    NGINX --> STATIC
    HARMONY --> SUPABASE
    SUPABASE --> POSTGRES
    SUPABASE --> REALTIME
    SUPABASE --> EDGE_FUNC
    HARMONY --> OBJECT_STORAGE
    OBJECT_STORAGE --> MEDIA_CDN
`

## Prerequisites

### Domain & DNS Setup

1. **Domain Registration**
   - Register your domain (e.g., `yourserver.social`)
   - Set up DNS records pointing to your server

2. **SSL Certificate**
   - Use Let's Encrypt for free SSL certificates
   - Configure automatic renewal

3. **Email Service**
   - Set up SMTP for user registration emails
   - Configure SPF/DKIM records

### Server Requirements

**Minimum Specs:**
- 2 CPU cores
- 4GB RAM
- 50GB SSD storage
- Ubuntu 22.04 LTS or similar

**Recommended Specs:**
- 4+ CPU cores
- 8GB+ RAM
- 100GB+ SSD storage
- Dedicated server or VPS

## Docker Deployment

### Production Docker Compose

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
      - ./dist:/usr/share/nginx/html
    depends_on:
      - harmony
    restart: unless-stopped

  harmony:
    build:
      context: .
      dockerfile: Dockerfile.prod
    environment:
      - NODE_ENV=production
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
      - DOMAIN=${DOMAIN}
    restart: unless-stopped
    networks:
      - harmony-network

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_POLL_INTERVAL=3600
    restart: unless-stopped

networks:
  harmony-network:
    driver: bridge
`

### Production Dockerfile

```dockerfile
# Dockerfile.prod
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
`

## Environment Configuration

### Production Environment Variables

```bash
# .env.production
NODE_ENV=production
DOMAIN=yourserver.social
BASE_URL=https://yourserver.social

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Security
JWT_SECRET=your-very-secure-jwt-secret
ENCRYPTION_KEY=your-32-character-encryption-key

# Federation
FEDERATION_ENABLED=true
ACTIVITYPUB_DOMAIN=yourserver.social

# Media Storage
STORAGE_BACKEND=supabase
MAX_FILE_SIZE=50MB
ALLOWED_FILE_TYPES=image/*,video/*,audio/*

# Email
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@mg.yourserver.social
SMTP_PASS=your-smtp-password
FROM_EMAIL=noreply@yourserver.social

# Monitoring
SENTRY_DSN=your-sentry-dsn
LOG_LEVEL=info
`

## Nginx Configuration

### Production Nginx Config

```nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml+rss;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;

    server {
        listen 80;
        server_name yourserver.social;
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name yourserver.social;

        # SSL Configuration
        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
        ssl_prefer_server_ciphers off;

        # Security Headers
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header X-XSS-Protection "1; mode=block";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";

        # Static files
        location / {
            root /usr/share/nginx/html;
            try_files $uri $uri/ /index.html;
            
            # Cache static assets
            location ~* .(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
                expires 1y;
                add_header Cache-Control "public, immutable";
            }
        }

        # API proxy
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://supabase:3000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # WebSocket proxy for real-time
        location /realtime/ {
            proxy_pass http://supabase:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
        }

        # ActivityPub endpoints
        location /.well-known/ {
            limit_req zone=api burst=10 nodelay;
            proxy_pass http://supabase:3000;
            proxy_set_header Host $host;
        }
    }
}
`

## Database Setup

### Supabase Production Setup

1. **Create Production Project**
   ```bash
   # Create new Supabase project
   npx supabase projects create harmony-prod --org-id your-org-id
   
   # Link to local development
   npx supabase link --project-ref your-project-ref
   
   # Deploy database schema
   npx supabase db push
   ```

2. **Configure Database**
   ```sql
   -- Enable required extensions
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS "pgcrypto";
   
   -- Set up Row Level Security
   ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
   ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
   
   -- Create indexes for performance
   CREATE INDEX idx_messages_channel_id ON messages(channel_id);
   CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
   ```

3. **Database Backup**
   ```bash
   # Set up automated backups
   npx supabase db dump --file backup.sql
   ```

## Security Configuration

### SSL/TLS Setup

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain SSL certificate
sudo certbot --nginx -d yourserver.social

# Auto-renewal
sudo systemctl enable certbot.timer
```

### Firewall Configuration

```bash
# Configure UFW firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Block common attack patterns
sudo ufw deny from 192.168.0.0/16
sudo ufw deny from 10.0.0.0/8
```

### Security Headers

```nginx
# Additional security headers
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss: https:";
add_header Referrer-Policy "strict-origin-when-cross-origin";
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()";
```

## Monitoring & Logging

### Application Monitoring

```typescript
// Sentry integration
import * as Sentry from "@sentry/vue"

Sentry.init({
  app,
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
})
```

### System Monitoring

```yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-storage:/var/lib/grafana

volumes:
  grafana-storage:
```

### Log Management

```bash
# Configure log rotation
sudo nano /etc/logrotate.d/harmony

/var/log/harmony/*.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 0644 harmony harmony
}
```

## Performance Optimization

### Caching Strategy

```nginx
# Nginx caching
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=harmony_cache:10m max_size=1g inactive=60m;

location /api/public/ {
    proxy_cache harmony_cache;
    proxy_cache_valid 200 5m;
    proxy_cache_key "$scheme$request_method$host$request_uri";
    add_header X-Cache-Status $upstream_cache_status;
}
```

### Database Optimization

```sql
-- Optimize database queries
ANALYZE;

-- Monitor slow queries
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Set up connection pooling
ALTER SYSTEM SET max_connections = 100;
ALTER SYSTEM SET shared_buffers = '256MB';
```

---

> 📝 **Next Steps**: Learn about [Monitoring](./monitoring.md) for comprehensive monitoring setup.