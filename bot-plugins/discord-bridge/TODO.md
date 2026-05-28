# Discord Bridge - TODO

## High Priority

### Fix Supabase Realtime (replace polling)
Currently using polling for message edits/deletes because Supabase Realtime subscriptions time out:
```
📡 Message updates subscription: TIMED_OUT
📡 Message deletes subscription: TIMED_OUT
```

**Current workaround:** Bot-gateway polls the database every 2 seconds and compares cached content vs DB content.

**Proper fix needed:**
- [ ] Debug why Realtime subscriptions fail (check Supabase config, service role permissions)

### Message mapping persistence
- [ ] Currently message ID mappings (Harmony ↔ Discord) are stored in memory
- [ ] If bridge restarts, all mappings are lost

---

## Medium Priority

### Improve edit/delete tracking
- [ ] Current 72h/10k message cache is arbitrary - consider making configurable
- [ ] Add metrics/logging for cache hit rate
- [ ] Handle edge case: message edited while bridge was offline

### Thread/Reply support
- [ ] Bridge Discord thread messages to Harmony replies
- [ ] Bridge Harmony replies to Discord threads or reply references

### Attachment handling notes
- ✓ Currently just sharing URLs (no re-upload), so no size limits apply
- [ ] Discord CDN URLs can expire - consider proxying or caching for old messages
- [ ] Harmony storage URLs might need authentication - verify they're publicly accessible

---

## Low Priority / Nice to Have

### Performance
- [ ] Batch Discord webhook calls if multiple Harmony messages arrive quickly
- [ ] Implement backoff/retry for Discord rate limits

### Features
- [ ] Bridge Discord embeds to Harmony (link previews)
- [ ] Bridge Harmony link previews to Discord embeds
- [ ] Support Discord stickers
- [ ] Bridge Discord slash commands other than `/m`

### Monitoring
- [ ] Add health check endpoint for bridge status
- [ ] Expose metrics (messages bridged, errors, latency)
- [ ] Alert when bridge disconnects from either side

---

## Completed ✓

- [x] Bi-directional message bridging
- [x] User mentions (both directions)
- [x] Discord user autocomplete via `/m` slash command
- [x] Reaction bridging (Discord → Harmony with user attribution)
- [x] Custom emoji bridging
- [x] Media/attachment bridging
- [x] Webhook puppeting (Harmony users appear with their name/avatar in Discord)
- [x] Discord users in Harmony autosuggest
- [x] Message edits (Harmony → Discord via polling, checks newest 100 messages)
- [x] Message deletes (Harmony → Discord via polling, detects soft-delete flag)
- [x] Message edits (Discord → Harmony)
- [x] Message deletes (Discord → Harmony)

