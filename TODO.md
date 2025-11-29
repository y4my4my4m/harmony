# Harmony - Technical Debt & Future Improvements

## Connection Management Cleanup (Completed 2024)

We removed over-engineered connection management that was causing issues:
- SessionHeartbeat (disabled - use Supabase Presence instead)
- Custom retry/timeout logic in queries
- Visibility change handlers
- Auth event revalidation for same user

**Philosophy:** Trust Supabase to handle its own connections.

---

## Future Considerations

### 1. Smart Push Notifications
**Current state:** SessionHeartbeat disabled, push notifications not configured.

**When implementing:**
- Use Supabase Presence to track user's current view context
- Backend checks presence before sending push (don't notify if user is viewing that chat)
- NO custom heartbeat needed - presence handles it

### 2. Query Retry Logic
**Current state:** Removed timeouts and retries from CoreMessageService/CorePostService.

**If queries genuinely hang in production:**
- Add simple retry (without aggressive timeouts)
- Consider AbortController for user-initiated cancellation
- Don't add visibility-based recovery

### 3. Offline/Away Status Tracking
**Current state:** ActivityTracker works independently, status updates via presence.

**Working flow:**
1. ActivityTracker detects inactivity → emits `status-should-change`
2. userDataService.handleAutomaticStatusChange() updates status
3. Presence channel broadcasts change
4. On activity resume → handleActivityResumed() restores status

---

## Files Simplified

| File | What was removed |
|------|------------------|
| `SessionHeartbeat.ts` | Periodic RPC calls, device detection, context tracking |
| `supabase.ts` | Connection health tracking, recovery functions |
| `RealtimeConnectionManager.ts` | Visibility handlers, aggressive health checks |
| `userDataService.ts` | Presence throttling, heartbeat presence tracking |
| `CoreMessageService.ts` | Query timeouts, retry with connection refresh |
| `CorePostService.ts` | Query retry wrapper |
| `auth.ts` | Auth event revalidation for same user |

---

## Testing Notes

After these changes, verify:
- [ ] Tab switching doesn't break queries
- [ ] Away/Online status transitions work
- [ ] MFA still enforced for new logins
- [ ] Presence shows correct online/offline status
- [ ] Messages load after being idle

