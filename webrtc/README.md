# Harmony WebRTC Server (LiveKit)

Centralized WebRTC server for Harmony voice/video channels using [LiveKit](https://livekit.io/).

## Features

- **SFU (Selective Forwarding Unit)** - Efficient media routing for large rooms
- **End-to-End Encryption (E2EE)** - Server only forwards encrypted frames
- **Stage Mode** - Support for 1-3 speakers with 500K+ listeners
- **NAT Traversal** - Built-in TURN server for connectivity
- **Federation Ready** - Cross-instance voice/video calls
- **Recording** - Optional egress service for recording/streaming

## Quick Start

### 1. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

### 2. Start LiveKit Server

```bash
# Start core services (LiveKit + Redis)
docker-compose up -d

# With recording support
docker-compose --profile egress up -d
```

### 3. Verify Installation

```bash
# Check health
curl http://localhost:7880/healthcheck

# View logs
docker-compose logs -f livekit
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Harmony Instance                         │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────┐ │
│  │   Frontend   │────▶│  Fed Backend │────▶│   LiveKit   │ │
│  │  (Browser)   │     │ (Token Gen)  │     │   Server    │ │
│  └──────────────┘     └──────────────┘     └─────────────┘ │
│         │                                         │         │
│         └────────── WebRTC Media ────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## Connection Flow

### Server Voice Channels
1. User joins voice channel in a server
2. Frontend requests token from federation-backend
3. Backend validates permissions, generates LiveKit token
4. Frontend connects to LiveKit with token
5. LiveKit handles all media routing

### DM Calls (Local)
1. Caller initiates call via Supabase Realtime
2. Both users request tokens from their instance's backend
3. Both connect to caller's instance LiveKit

### DM Calls (Federated)
1. Caller's instance sends `harmony:VoiceCallInvite` ActivityPub activity
2. Callee's instance displays incoming call
3. On accept, callee requests federated token from caller's instance
4. Both connect to caller's LiveKit server

## Configuration

### livekit.yaml

Main configuration file. Key settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `keys` | API key/secret pairs | `devkey:secret` |
| `rtc.port_range_*` | UDP ports for media | `50000-50100` |
| `room.max_participants` | Per-room limit | `0` (unlimited) |
| `room.empty_timeout` | Auto-close empty rooms | `300s` |
| `turn.enabled` | Built-in TURN server | `true` |

### Production Configuration

For production deployment:

1. **Generate secure API keys:**
   ```bash
   # Generate API key
   openssl rand -hex 8
   # Generate API secret
   openssl rand -hex 32
   ```

2. **Configure public IP:**
   ```yaml
   rtc:
     use_external_ip: true
     node_ip: YOUR_PUBLIC_IP
   ```

3. **Enable TLS:**
   Use a reverse proxy (nginx/caddy) with SSL termination:
   ```
   wss://livekit.yourdomain.com -> ws://localhost:7880
   ```

4. **Configure TURN domain:**
   ```yaml
   turn:
     enabled: true
     domain: turn.yourdomain.com
     external_tls: true
   ```

## E2EE (End-to-End Encryption)

LiveKit supports E2EE where the server never sees unencrypted media:

1. **Key Exchange**: Clients use Signal Protocol (existing Harmony E2EE)
2. **Frame Encryption**: Each audio/video frame is encrypted client-side
3. **Server Role**: Only forwards encrypted frames (SFU)
4. **Key Rotation**: Supported; rotation bounds the exposure window of a leaked media key (not a per-frame ratchet, so not "perfect forward secrecy")

E2EE is enabled per-room by the LiveKit client SDK.

## Scaling

### Vertical Scaling
- Increase CPU/RAM for single server
- Good for up to ~500 participants

### Horizontal Scaling
- Deploy multiple LiveKit nodes
- Use Redis for coordination
- Configure `region` and `node_id` in livekit.yaml

### Stage Events (Large Audiences)
For events with 500K+ listeners:

1. Enable `dynacast` (default on)
2. Enable `adaptive_stream` (default on)
3. Use `signal_relay` for large rooms
4. Consider multiple regional servers

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 7880 | TCP | HTTP/WebSocket (client API) |
| 7881 | TCP/UDP | RTC (media fallback) |
| 3478 | UDP | TURN server |
| 50000-50100 | UDP | WebRTC media |
| 6379 | TCP | Redis (internal) |

## Monitoring

### Health Check
```bash
curl http://localhost:7880/healthcheck
```

### LiveKit Dashboard
LiveKit provides a built-in dashboard:
```
http://localhost:7880
```

### Redis Stats
```bash
docker exec harmony-livekit-redis redis-cli info
```

## Testing

### Using Multiple Browser Tabs
1. Open 2-4 incognito tabs with different user accounts
2. Join the same voice channel
3. Test audio/video functionality

### Using LiveKit CLI
```bash
# Install
brew install livekit/tap/livekit-cli
# or download from https://github.com/livekit/livekit-cli

# Join as test participant
livekit-cli join-room \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret secret \
  --room test-channel \
  --identity test-user-1

# Publish test audio
livekit-cli join-room \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret secret \
  --room test-channel \
  --identity test-user-2 \
  --publish-demo
```

### Load Testing
```bash
# Run the included load test
npm run test:load

# Or use livekit-cli
livekit-cli load-test \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret secret \
  --room load-test \
  --publishers 10 \
  --subscribers 100 \
  --duration 60s
```

## Troubleshooting

### Connection Failed
- Check firewall rules for UDP ports
- Verify TURN server is accessible
- Check browser console for ICE errors

### No Audio/Video
- Verify microphone/camera permissions
- Check track publishing in LiveKit dashboard
- Review browser WebRTC internals: `chrome://webrtc-internals`

### High Latency
- Check server CPU/bandwidth
- Enable adaptive streaming
- Consider regional deployment

### Federation Issues
- Verify public LiveKit URL is accessible
- Check ActivityPub actor signatures
- Review federation-backend logs

## Files

```
webrtc/
├── docker-compose.yml    # Main Docker configuration
├── livekit.yaml          # LiveKit server configuration
├── egress.yaml           # Recording service configuration
├── .env.example          # Environment template
├── README.md             # This file
└── test/
    └── load-test.ts      # Load testing script
```

## Resources

- [LiveKit Documentation](https://docs.livekit.io/)
- [LiveKit GitHub](https://github.com/livekit/livekit)
- [livekit-client SDK](https://docs.livekit.io/client-sdk-js/)
- [livekit-server-sdk](https://docs.livekit.io/server/server-apis/)

