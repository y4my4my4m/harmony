# Testing Harmony WebRTC Server

This guide covers how to test the LiveKit WebRTC server without requiring multiple users or friends.

## Quick Start

### 1. Start the Server

```bash
cd webrtc
docker-compose up -d
```

### 2. Verify It's Running

```bash
# Check health
curl http://localhost:7880/healthcheck

# Check Docker logs
docker-compose logs -f livekit
```

## Testing Methods

### Method 1: Multiple Browser Tabs (Easiest)

1. **Create test accounts** in your Harmony instance (if you don't have multiple)
2. **Open incognito windows** to log in with different accounts
3. **Join the same voice channel** from each window
4. **Test features**: mute, deafen, video, screen share

Tips:
- Use Chrome and Firefox together to test cross-browser
- Incognito mode prevents session conflicts
- You can use headphones to avoid audio feedback

### Method 2: LiveKit CLI (Best for Quick Tests)

Install the CLI:

```bash
# macOS
brew install livekit/tap/livekit-cli

# Linux
curl -sSL https://get.livekit.io/cli | bash

# Or download from GitHub
# https://github.com/livekit/livekit-cli/releases
```

Join a room as a test participant:

```bash
# Basic join (listen only)
livekit-cli join-room \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret secret \
  --room test-channel \
  --identity test-user

# Join and publish demo audio
livekit-cli join-room \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret secret \
  --room test-channel \
  --identity test-user-audio \
  --publish-demo

# Join and publish video
livekit-cli join-room \
  --url ws://localhost:7880 \
  --api-key devkey \
  --api-secret secret \
  --room test-channel \
  --identity test-user-video \
  --publish-demo \
  --video
```

### Method 3: Load Testing with LiveKit CLI (Recommended)

The official LiveKit CLI runs load tests server-side (no browser APIs needed).
Use the included benchmark wrapper:

```bash
# Interactive - prompts for URL/keys and preset selection
./scripts/benchmark-voice.sh

# Or use a preset directly
./scripts/benchmark-voice.sh --preset audio-small
./scripts/benchmark-voice.sh --preset video-medium
./scripts/benchmark-voice.sh --preset livestream

# Full custom
./scripts/benchmark-voice.sh \
  --url wss://live.yourdomain.com \
  --api-key YOUR_KEY \
  --api-secret YOUR_SECRET \
  --preset audio-large \
  --duration 120s
```

Available presets: `audio-small`, `audio-medium`, `audio-large`, `video-small`, `video-medium`, `livestream`.

Run `./scripts/benchmark-voice.sh --help` for full usage.

> **Important:** Run the load tester from a **different machine** than the LiveKit
> server for accurate results. The tester itself uses significant CPU/bandwidth.
> For 1000+ participants, set `ulimit -n 65535`.

Install the CLI if you don't have it:

```bash
curl -sSL https://get.livekit.io/cli | bash
```

### Method 4: LiveKit Meet (Web Demo)

LiveKit provides a demo web app:

```bash
# Clone the repo
git clone https://github.com/livekit/livekit-meet
cd livekit-meet

# Configure
echo "LIVEKIT_URL=ws://localhost:7880" > .env
echo "LIVEKIT_API_KEY=devkey" >> .env
echo "LIVEKIT_API_SECRET=secret" >> .env

# Run
npm install
npm run dev
```

Open http://localhost:3000 and join rooms with multiple tabs.

### Method 5: Chrome WebRTC Internals

For debugging connection issues:

1. Open `chrome://webrtc-internals/` in Chrome
2. Join a voice channel in Harmony
3. View detailed stats about:
   - ICE candidates
   - Connection state
   - Bandwidth usage
   - Packet loss
   - Jitter/latency

## Testing Scenarios

### Basic Voice Call

1. User A joins voice channel
2. User B joins same channel (different tab/CLI)
3. Verify both can hear each other
4. Test mute/unmute

### Video Call

1. User A joins and enables video
2. User B joins and enables video
3. Verify video streams are visible
4. Test resolution changes with bandwidth

### Screen Share

1. User A starts screen share
2. Verify User B can see it
3. Test audio sharing (if available)
4. Test switching between screen and camera

### Stage Mode

1. Configure a room as "stage" type
2. Speakers (publishers) join with publish permission
3. Listeners (subscribers) join without publish permission
4. Test promoting/demoting speakers

### E2EE (End-to-End Encryption)

1. Enable E2EE in room settings
2. Join with multiple participants
3. Verify media is encrypted (check chrome://webrtc-internals)
4. Test key rotation

### Failover Testing

1. Connect via SFU
2. Stop LiveKit container: `docker-compose stop livekit`
3. Verify P2P fallback engages (if hybrid mode)
4. Restart LiveKit: `docker-compose start livekit`
5. Verify reconnection

### Network Simulation

Test with simulated network conditions:

```bash
# Linux: Add latency
sudo tc qdisc add dev eth0 root netem delay 100ms

# Linux: Simulate packet loss
sudo tc qdisc add dev eth0 root netem loss 5%

# Remove simulation
sudo tc qdisc del dev eth0 root
```

## Performance Benchmarks

### Recommended Hardware

For production (with UDP mux on a single port):
- **Small (1-50 users)**: 2 vCPU, 4GB RAM
- **Medium (50-200 users)**: 4 vCPU, 8GB RAM
- **Large (200-500 users video / 1000+ audio)**: 8 vCPU, 16GB RAM
- **Stage/Livestream (3000+ listeners)**: 16+ vCPU, 32GB+ RAM

### Official LiveKit Benchmarks (16-core c2-standard-16)

| Scenario | Publishers | Subscribers | CPU | Bandwidth out |
|----------|-----------|-------------|-----|---------------|
| Audio rooms | 10 (audio) | 3,000 | 80% | 23 MB/s |
| Large meeting | 150 (720p) | 150 | 85% | 93 MB/s |
| Livestream | 1 (720p) | 3,000 | 92% | 531 MB/s |

### Rough Per-Core Guidelines

- **Audio-only subscriber**: ~200 per core
- **720p video subscriber**: ~50-100 per core (depends on simulcast)
- **Bandwidth** often becomes the bottleneck before CPU

## Troubleshooting

### Connection Fails

1. Check firewall rules (UDP 7882 if using UDP mux)
2. Verify TURN server is accessible
3. Check browser console for ICE errors
4. Try TCP fallback: port 7881

### No Audio

1. Check microphone permissions
2. Verify audio track is publishing (LiveKit dashboard)
3. Check if muted
4. Try different audio device

### High Latency

1. Check server location (should be close to users)
2. Verify dynacast is enabled
3. Check adaptive stream settings
4. Review network conditions

### Video Quality Issues

1. Enable simulcast for adaptive quality
2. Check bandwidth constraints
3. Verify video codec settings
4. Test with different resolutions

## Monitoring

### LiveKit Dashboard

Access the built-in dashboard:
```
http://localhost:7880
```

### Redis Stats

```bash
docker exec harmony-livekit-redis redis-cli info
```

### Prometheus Metrics

LiveKit exposes metrics at `/metrics`:
```bash
curl http://localhost:7880/metrics
```

Key metrics to watch:
- `livekit_room_count` - Active rooms
- `livekit_participant_count` - Connected participants
- `livekit_track_publish_latency` - Publishing latency
- `livekit_packet_loss` - Packet loss rate

## Non-Voice Benchmarks (REST / Realtime / Federation)

For testing message throughput, REST API latency, and federation endpoints,
use the separate API benchmark script:

```bash
# Quick curl-based latency probe (no dependencies)
./scripts/benchmark-api.sh --mode quick

# Full concurrent load test (requires k6)
./scripts/benchmark-api.sh --mode full --vus 100 --duration 60s
```

See `./scripts/benchmark-api.sh --help` for full options.

Install k6 for full load tests:
```bash
# Arch / Manjaro
yay -S k6
# macOS
brew install k6
```

