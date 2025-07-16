# Federation Architecture Refactor Plan

## Current Issues

1. **Duplication**: Inbox writes to both `ap_activities` and `follows` tables
2. **Mixed concerns**: Business logic split between inbox and database triggers  
3. **UX lag**: No immediate updates for local users
4. **No queue fallback**: Failed deliveries aren't properly queued

## Professional Solution

### 1. Inbox Responsibility (Minimal)
- **ONLY** validate and store in `ap_activities` table
- Basic security checks (HTTP signatures, blocked instances)
- No business logic processing

### 2. Database Triggers Handle Everything Else
- Process `ap_activities` table inserts
- Create application-specific records (follows, posts, etc.)
- Send immediate notifications to local users
- Queue federation for remote users

### 3. Queue System for Reliability
- Failed immediate deliveries go to queue
- Background workers process the queue
- Retry logic with exponential backoff

## Implementation Strategy

### Phase 1: Clean up Inbox
Remove business logic from inbox, make it store-only

### Phase 2: Unified Activity Processing Trigger
Single trigger that handles all ActivityPub activity types

### Phase 3: Queue Integration
Ensure reliable federation delivery with fallback queue

## Benefits

✅ **DRY**: Single place for each piece of logic
✅ **Scalable**: Database triggers are fast, queue handles load
✅ **Reliable**: No lost activities, proper retry logic
✅ **Immediate UX**: Local users see updates instantly
✅ **Clean**: Clear separation of concerns
✅ **Maintainable**: Easy to debug and extend
