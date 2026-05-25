# Harmony Bot Gateway

Discord-like Bot API Gateway for Harmony.

## Features

- **WebSocket Gateway**: Real-time event streaming to bots
- **REST API**: Discord-compatible endpoints for bot actions
- **Authentication**: Secure token-based authentication
- **Rate Limiting**: Per-bot rate limits and quotas
- **Event System**: Subscribe to server/channel events
- **Permission System**: Granular bot permissions per server

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configuration

Create `.env` file:

```env
# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Server Configuration
PORT=3002
NODE_ENV=development

# Instance Configuration
INSTANCE_DOMAIN=localhost:3000
```

### 3. Start Development Server

```bash
npm run dev
```

The gateway will start on `http://localhost:3002` (default port; federation-backend uses port 3001)

- WebSocket Gateway: `ws://localhost:3002/gateway`
- REST API: `http://localhost:3002/api/v1`

## Bot Connection

### WebSocket Protocol

1. **Connect** to `ws://localhost:3002/gateway`
2. **Identify** with bot token:
```json
{
  "op": 2,
  "d": {
    "token": "your_bot_token"
  }
}
```
3. **Receive READY** event:
```json
{
  "op": 0,
  "t": "READY",
  "d": {
    "bot": {
      "id": "bot_id",
      "username": "bot_username"
    }
  }
}
```
4. **Heartbeat** every 30 seconds:
```json
{
  "op": 1
}
```

### REST API

All REST API requests require the `Authorization` header:

```
Authorization: Bot YOUR_BOT_TOKEN
```

#### Send Message

```http
POST /api/v1/channels/:channelId/messages
Content-Type: application/json

{
  "content": "Hello from bot!"
}
```

#### Get Server Members

```http
GET /api/v1/guilds/:guildId/members
```

## Event Types

- `MESSAGE_CREATE` - New message in channel
- `MESSAGE_UPDATE` - Message edited
- `MESSAGE_DELETE` - Message deleted
- `MEMBER_JOIN` - User joined server
- `MEMBER_LEAVE` - User left server
- `CHANNEL_CREATE` - Channel created
- `CHANNEL_UPDATE` - Channel updated
- `CHANNEL_DELETE` - Channel deleted

## Production Deployment

### Build

```bash
npm run build
```

### Start

```bash
npm start
```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
EXPOSE 3002
CMD ["npm", "start"]
```

## Architecture

```
bot-gateway/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config/
│   │   └── supabase.ts       # Supabase client
│   ├── gateway/
│   │   ├── WebSocketGateway.ts    # WebSocket server
│   │   ├── EventDispatcher.ts     # Event routing
│   │   └── BotConnection.ts       # Connection management
│   ├── api/
│   │   ├── BotRestAPI.ts          # REST API routes
│   │   ├── routes/                # API endpoints
│   │   └── middleware/            # Express middleware
│   ├── auth/
│   │   └── BotAuthMiddleware.ts   # Token verification
│   └── utils/
│       ├── logger.ts              # Logging
│       └── rateLimit.ts           # Rate limiting
```

## License

Same as the Harmony repository: **GNU AGPL-3.0** (see root `LICENSE`).

