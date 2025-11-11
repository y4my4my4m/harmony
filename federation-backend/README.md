# Harmony Federation Backend

**ActivityPub federation server for Harmony - FEDERATION ONLY!**

## Purpose

This backend handles ONLY ActivityPub federation. It does NOT handle:
- ❌ Creating messages (frontend → Supabase)
- ❌ Creating posts (frontend → Supabase)
- ❌ User authentication (Supabase handles this)
- ❌ CRUD operations (frontend → Supabase)

## What It DOES Handle

✅ **ActivityPub Protocol**
- Inbox/Outbox endpoints
- WebFinger discovery
- NodeInfo metadata
- HTTP signature signing/verification

✅ **Federation Delivery**
- Listen for database events
- Convert to ActivityPub format
- Queue for delivery
- Send to remote instances
- Handle retries

✅ **Incoming Activities**
- Receive from remote instances
- Verify signatures
- Process activities
- Write to database

## Getting Started

### Prerequisites

- Node.js 18+ or Bun
- Supabase project
- Redis (optional, for queue processing)

### Installation

```bash
cd backend
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key from Supabase
- `INSTANCE_DOMAIN` - Your instance domain

### Development

```bash
npm run dev
```

Server runs on `http://localhost:3001`

### Build

```bash
npm run build
npm start
```

## Project Structure

```
backend/
├── src/
│   ├── config/          # Configuration and Supabase client
│   ├── controllers/     # Request handlers
│   ├── services/        # Business logic
│   ├── routes/          # API routes
│   ├── middleware/      # Express middleware
│   ├── utils/           # Utilities (logger, cache)
│   ├── types/           # TypeScript types
│   └── index.ts         # App entry point
├── dist/                # Compiled output
├── logs/                # Log files
└── package.json
```

## Endpoints

### ActivityPub (Federation)
- `GET /.well-known/webfinger` - WebFinger discovery
- `GET /.well-known/nodeinfo` - NodeInfo metadata
- `GET /nodeinfo/2.0` - NodeInfo 2.0
- `GET /users/:username` - Actor endpoint
- `POST /inbox` - Shared inbox
- `POST /users/:username/inbox` - User inbox
- `GET /users/:username/outbox` - User outbox
- `GET /users/:username/followers` - Followers collection
- `GET /users/:username/following` - Following collection

### Management
- `GET /health` - Health check
- `POST /api/activitypub/process-delivery` - Manually trigger delivery queue

## Authentication

All authenticated endpoints require a Bearer token:

```
Authorization: Bearer <supabase-jwt-token>
```

## Rate Limits

- General API: 100 requests per 15 minutes
- Auth endpoints: 5 requests per 15 minutes
- Profile updates: 10 per minute
- Messages: 20 per 10 seconds
- Posts: 10 per minute

## Error Handling

All errors return JSON:

```json
{
  "success": false,
  "error": "Error message"
}
```

## Logging

Logs are written to:
- `logs/combined.log` - All logs
- `logs/error.log` - Error logs only
- Console (development)

## License

MIT

