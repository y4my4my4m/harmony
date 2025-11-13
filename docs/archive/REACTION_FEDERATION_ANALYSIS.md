# ActivityPub Emoji Reaction Federation Analysis & Implementation Plan

## Current State Analysis

### Database Schema ✅
- **Posts table**: Correctly structured with `is_local`, `is_federated`, `ap_id` columns
- **Post_interactions table**: Has emoji_reaction support with `emoji_id` and `custom_emoji_content`
- **Constraints**: Fixed to allow multiple emoji reactions per user per post
- **Functions**: `add_post_emoji_reaction()`, `get_post_emoji_reactions()` exist

### Missing Federation Components ❌
1. **No federation trigger for reactions** - reactions are not sent to ActivityPub
2. **No incoming reaction processing** - can't receive Misskey/Pleroma reactions
3. **No reaction conversion logic** - no mapping between ActivityPub and local reactions
4. **No federation queue integration** - reactions not added to delivery system

## ActivityPub Compatibility Issues

### 1. Misskey/Pleroma Reaction Format
**Misskey Format:**
```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", "https://misskey-hub.net/ns"],
  "type": "Like",
  "actor": "https://misskey.example/users/alice",
  "object": "https://harmony.example/posts/123",
  "content": "❤️",
  "_misskey_reaction": "❤️"
}
```

**Pleroma Format:**
```json
{
  "@context": ["https://www.w3.org/ns/activitystreams"],
  "type": "EmojiReact", 
  "actor": "https://pleroma.example/users/bob",
  "object": "https://harmony.example/posts/123",
  "content": "🎉",
  "tag": [
    {
      "type": "Emoji",
      "name": ":party:",
      "icon": {
        "type": "Image",
        "url": "https://pleroma.example/emoji/party.png"
      }
    }
  ]
}
```

### 2. Current Harmony Limitations
- **No ActivityPub reaction activity creation** - when user adds emoji reaction
- **No incoming activity processing** - for EmojiReact/Like with emoji content
- **No emoji conversion** - between ActivityPub custom emojis and local format
- **No federation delivery** - reactions stay local only

## Implementation Plan

### Phase 1: Database Federation Functions
Create trigger functions following existing naming conventions:

#### 1.1 Outgoing Reaction Federation
```sql
CREATE OR REPLACE FUNCTION handle_post_interaction_federation()
RETURNS TRIGGER AS $$
```
**Responsibilities:**
- Trigger on `post_interactions` INSERT/DELETE for emoji_reaction type
- Create ActivityPub EmojiReact activity for outgoing reactions
- Add to `federation_delivery_queue` for remote delivery
- Support both unicode emojis and custom server emojis

#### 1.2 Reaction Activity Builder
```sql
CREATE OR REPLACE FUNCTION build_emoji_reaction_activity()
RETURNS JSONB AS $$
```
**Responsibilities:**
- Convert local emoji reaction to ActivityPub EmojiReact format
- Handle custom emoji metadata (name, URL, domain)
- Support Misskey compatibility with `_misskey_reaction` field
- Generate proper activity IDs and URLs

### Phase 2: Incoming Reaction Processing
Extend existing ActivityPub inbox processing:

#### 2.1 Reaction Activity Handler
```sql
CREATE OR REPLACE FUNCTION process_incoming_emoji_reaction()
RETURNS BOOLEAN AS $$
```
**Responsibilities:**
- Parse EmojiReact and Like activities with emoji content
- Convert ActivityPub emoji format to local `post_interactions` format  
- Handle custom emoji resolution (download/cache if needed)
- Deduplicate existing reactions from same actor

#### 2.2 Emoji Resolution System
```sql
CREATE OR REPLACE FUNCTION resolve_activitypub_emoji()
RETURNS UUID AS $$
```
**Responsibilities:**
- Map incoming custom emojis to local `emojis` table
- Download and cache remote custom emoji images
- Handle unicode emoji standardization
- Return `emoji_id` or set `custom_emoji_content`

### Phase 3: Real-time Integration
Ensure federated reactions appear in UI instantly:

#### 3.1 Realtime Trigger Updates
- Modify existing realtime triggers to include federated reactions
- Ensure `post_reactions` store receives federated reaction updates
- Handle optimistic UI updates vs federated confirmations

#### 3.2 Federation Status Tracking
- Add federation status to reaction metadata
- Track delivery success/failure per instance
- Implement retry logic for failed deliveries

### Phase 4: Testing & Validation

#### 4.1 Federation Compatibility Tests
- **Misskey**: Send/receive emoji reactions with various emoji types
- **Pleroma**: Test EmojiReact activity processing both ways
- **Mastodon**: Ensure graceful fallback (reactions as likes)
- **Other Harmony instances**: Full bidirectional emoji reaction support

#### 4.2 Performance Tests  
- Batch reaction federation for popular posts
- Rate limiting for reaction spam prevention
- Database performance with high reaction volume

## Technical Implementation Details

### File Changes Required

#### Database Functions (`db_schema/all_db_functions.sql`)
```sql
-- Add after existing reaction functions
CREATE OR REPLACE FUNCTION handle_post_interaction_federation()
CREATE OR REPLACE FUNCTION build_emoji_reaction_activity()  
CREATE OR REPLACE FUNCTION process_incoming_emoji_reaction()
CREATE OR REPLACE FUNCTION resolve_activitypub_emoji()
```

#### Migration Files
```sql
-- Add federation trigger
CREATE TRIGGER trigger_post_interaction_federation
  AFTER INSERT OR DELETE ON post_interactions
  FOR EACH ROW 
  WHEN (NEW.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'emoji_reaction')
  EXECUTE FUNCTION handle_post_interaction_federation();
```

#### Edge Function Updates (`supabase/functions/inbox/index.ts`)
- Add EmojiReact activity type handling
- Integrate with `process_incoming_emoji_reaction()` function
- Update activity validation for emoji content

### Federation Activity Flow

#### Outgoing Reactions
1. User adds emoji reaction via UI → `add_post_emoji_reaction()`
2. Trigger `handle_post_interaction_federation()` fires
3. Creates EmojiReact activity in proper format
4. Adds to `federation_delivery_queue` with target instances
5. Background worker delivers to remote instances
6. Remote instances process and display reaction

#### Incoming Reactions  
1. Remote instance sends EmojiReact activity to `/inbox`
2. Inbox function validates and queues activity
3. `process_incoming_emoji_reaction()` processes activity
4. Resolves emoji and creates local `post_interactions` record
5. Realtime trigger notifies connected clients
6. UI updates to show new reaction

### Error Handling & Edge Cases

#### Failed Federation Scenarios
- **Network timeouts**: Retry with exponential backoff
- **Invalid emoji**: Log error, continue processing
- **Duplicate reactions**: Idempotent processing, ignore duplicates
- **Post not found**: Return 404, log for debugging

#### Emoji Compatibility Issues
- **Unicode variation**: Normalize to standard Unicode form
- **Custom emoji unavailable**: Show generic fallback or text name
- **Large emoji files**: Implement size limits and compression
- **Animated emojis**: Support for GIF/APNG where possible

## Success Metrics

### Federation Compatibility
- ✅ Misskey emoji reactions federate bidirectionally
- ✅ Pleroma EmojiReact activities processed correctly  
- ✅ Graceful fallback for non-supporting instances
- ✅ Custom emoji resolution works across instances

### Performance Targets
- ⚡ Reaction federation delivery < 2 seconds
- ⚡ Incoming reaction processing < 500ms
- ⚡ UI updates in real-time via WebSocket
- ⚡ No N+1 queries in batch reaction loading

### User Experience
- 🎉 Emoji reactions appear instantly (optimistic UI)
- 🎉 Real-time updates when others react
- 🎉 Custom emojis from other instances display correctly
- 🎉 Audio feedback and smooth animations maintained

## Next Steps

1. **Implement database functions** following existing naming conventions
2. **Add federation triggers** for automatic reaction delivery
3. **Update inbox processing** for incoming reaction activities
4. **Test with real Misskey/Pleroma instances** for compatibility
5. **Performance optimization** and error handling refinement

This implementation will make Harmony's emoji reactions fully compatible with the broader ActivityPub ecosystem while maintaining the excellent UX already implemented in the frontend.
