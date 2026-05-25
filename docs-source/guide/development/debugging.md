# Debugging

## Debug Logging

Harmony includes a configurable logging system via `LoggingService`. Enable debug output with:

```env
VITE_DEBUG_LOGGING=true
VITE_DEBUG_FEDERATION=true
VITE_DEBUG_VOICE=true
```

The `debug` utility in `src/utils/debug.ts` provides scoped console output that can be filtered by feature area.

## Browser DevTools

### Vue DevTools

Install the [Vue DevTools](https://devtools.vuejs.org/) browser extension to inspect:

- Component tree and props
- Pinia store state and history
- Router state and navigation
- Performance timeline

### Supabase Realtime Inspector

Monitor realtime subscriptions in the browser console. `RealtimeConnectionManager` exposes debug info:

```typescript
// In browser console
RealtimeConnectionManager.getInstance().getDebugInfo()
```

This returns per-channel status, connection state, and reconnection history.

## Common Debugging Scenarios

### Messages Not Appearing

1. Check realtime subscription status in `RealtimeConnectionManager.getDebugInfo()`
2. Verify the channel subscription is `connected` (not `reconnecting` or `error`)
3. Check RLS policies -- the user must have access to the channel
4. For encrypted messages, verify encryption keys are loaded via the encryption indicator

### Encryption Issues

- Check `SecureSessionKeyStore` in IndexedDB via DevTools > Application > IndexedDB
- Verify recovery key setup completed (`MegolmMessageEncryptionService.isInitialized()`)
- Look for `megolm-key-received` CustomEvents in the console
- Decryption failures log to console with the session ID and error

### Federation Not Working

1. Check the federation backend health: `GET /health`
2. Verify nginx proxies are routing correctly (WebFinger, actor endpoints)
3. Check pg-boss queue for stuck jobs (if `USE_PGBOSS_QUEUE=true`)
4. Enable `VITE_DEBUG_FEDERATION=true` for frontend federation logging
5. Check federation backend logs in `logs/combined.log`

### Realtime Disconnections

`RealtimeConnectionManager` tracks reconnection attempts:

- Exponential backoff: 1s base, 30s max, factor 2
- Rapid close detection: 3 quick closes triggers a 30-second cooldown
- Health check every 60 seconds resets long-lived error states

Per-channel status can be monitored:

```typescript
const manager = RealtimeConnectionManager.getInstance()
manager.onStatusChange('channelName', (status) => {
  console.log('Channel status:', status)
})
```

### Voice/Video Issues

- Check WebRTC mode (`sfu` vs `p2p`) in environment config
- For LiveKit: verify the LiveKit server is reachable and tokens are generated
- For P2P: check Supabase Realtime signaling channel status
- Browser permissions: ensure microphone/camera access is granted
- Enable `VITE_DEBUG_VOICE=true` for detailed WebRTC logging

## Debug Components

- `UserDataDebugPanel` (`src/components/debug/`) - Inspect cached user data and presence state
- Status lifecycle debugger (`StatusLifecycleDebugger` service) - Track user status transitions

## Supabase Dashboard

For database debugging, use the Supabase dashboard:

- **Table Editor**: Inspect and modify data directly
- **SQL Editor**: Run ad-hoc queries
- **Auth**: Check user sessions and tokens
- **Logs**: View API request logs and errors
- **Realtime Inspector**: Monitor active subscriptions

For local development with `supabase start`, the dashboard is at `http://localhost:54323`.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/development/debugging.md` and run `npm run docs:generate-guide` to update.
