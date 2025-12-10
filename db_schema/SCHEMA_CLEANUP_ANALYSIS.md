# Database Schema Cleanup Analysis

This document analyzes the current production database (`supabase_minimal.sql`) to identify unused, duplicate, or legacy tables that may be candidates for removal or consolidation.

## Analysis Date: December 2024

---

## Tables Potentially UNUSED (No Code References)

These tables exist in production but have **no references in the frontend codebase**:

| Table | Reason | Recommendation |
|-------|--------|----------------|
| `encryption_sessions` | No code references found | **REMOVE** - Legacy from older encryption implementation |
| `encryption_audit_log` | No code references found | **REMOVE** - Was never implemented |
| `conversation_backup_pre_cleanup` | Backup table from migration | **REMOVE** - Temporary table, no longer needed |
| `message_search_index` | No code references | **KEEP** - May be used for future full-text search |
| `activity_processing_logs` | No frontend references | **REVIEW** - May be used by federation-backend |
| `hashtag_archive` | No code references | **REMOVE** - Not implemented |
| `user_timeline_cache` | No code references | **REMOVE** - Timeline uses different approach |
| `user_view_contexts` | No code references | **REMOVE** - Never implemented |
| `emoji_usage` | Limited use | **REVIEW** - May want for emoji analytics |

## Tables That Are Actually TABLES But Should Be VIEWS

| Table | Issue | Recommendation |
|-------|-------|----------------|
| `v_has_permission` | Named like a view, is a table | **INVESTIGATE** - Should probably be a view or renamed |

## Internal/System Tables (Don't Remove)

These are internal PostgreSQL or Supabase tables:

| Table | Purpose |
|-------|---------|
| `schedule_result` | pg_cron job results |
| `pg_background_job` | Background job tracking |
| `storage.*` tables | Supabase storage internals |

---

## Duplicate/Overlapping Federation Tables

The federation health tracking has some overlap. Here's the breakdown:

### Current State:
1. **`federated_instances`** - Master list of known instances with basic health stats
2. **`federation_endpoint_health`** - Per-endpoint health (individual inbox URLs) with dead endpoint tracking
3. **`federation_health`** - Additional health metrics table (seems redundant)
4. **`federation_delivery_stats`** - Delivery statistics
5. **`activitypub_processing_stats`** - Processing statistics

### Recommendation:
- **KEEP**: `federated_instances`, `federation_endpoint_health`, `federation_delivery_queue`
- **CONSOLIDATE**: `federation_health` data into `federated_instances`
- **REVIEW**: `federation_delivery_stats`, `activitypub_processing_stats` - determine if used

---

## Schema Differences: Production vs Init Folder

### Now Fixed (Added to init folder):
- ✅ `trending_posts` → `07_tables_trending.sql`
- ✅ `trending_users` → `07_tables_trending.sql`
- ✅ `trending_refresh_queue` → `07_tables_trending.sql`
- ✅ `server_folders` → `07_tables_trending.sql`
- ✅ `server_settings` → `07_tables_trending.sql`
- ✅ `channel_permission_overrides` → `07_tables_trending.sql`
- ✅ `user_mutes` → `07_tables_trending.sql`
- ✅ `bot_commands` → `08_tables_bots_extended.sql`
- ✅ `bot_webhooks` → `08_tables_bots_extended.sql`
- ✅ `bot_presence` → `08_tables_bots_extended.sql`
- ✅ `bot_rate_limits` → `08_tables_bots_extended.sql`
- ✅ `bot_audit_log` → `08_tables_bots_extended.sql`
- ✅ `megolm_room_sessions` → `09_tables_encryption.sql`
- ✅ `megolm_session_shares` → `09_tables_encryption.sql`
- ✅ `megolm_key_requests` → `09_tables_encryption.sql`
- ✅ `megolm_key_backups` → `09_tables_encryption.sql`
- ✅ `recovery_key_metadata` → `09_tables_encryption.sql`
- ✅ `mfa_recovery_codes` → `09_tables_encryption.sql`
- ✅ `conversation_encryption_settings` → `09_tables_encryption.sql`
- ✅ `server_encryption_settings` → `09_tables_encryption.sql`
- ✅ `user_private_keys` → `09_tables_encryption.sql`
- ✅ Views → `70_views.sql`

### Still Missing (Low Priority):
- `remote_emojis_cache` - Used by EmojiImporter, could add
- `notification_channels` - Not currently used
- `notification_rate_limits` - Not currently used
- `slow_queries` - Admin/debugging table
- `performance_metrics_hourly` - Performance aggregations

---

## Column Differences

Some tables have evolved in production with additional columns. Key differences:

### `user_blocks` (Production has more features):
- `block_type` (full, posts_only, interactions_only)
- `reason`
- `expires_at`
- `metadata`
- `ap_id`, `is_federated`, `federation_status`

### `hashtags` (Production has trending columns):
- `normalized_tag`
- `trending_score`
- `trending_rank`
- `daily_uses`, `weekly_uses`
- `total_uses`
- `peak_daily_uses`, `peak_daily_date`
- `first_used_at`, `last_used_at`

### `posts` (Production has more fields):
- `url`
- `in_reply_to`
- `media_attachments`
- `is_sensitive`
- `edit_history`
- `voice_attachments`
- `federated_to`
- `last_federated_at`
- `conversation_root_id`
- `is_favorited`, `is_reblogged`, `is_bookmarked` (denormalized)
- `reblog`, `reblog_author` (JSONB for reblog data)
- `is_pinned`

---

## Recommended Cleanup Actions

### High Priority (Safe to Remove):
1. `encryption_sessions` - Legacy, unused
2. `encryption_audit_log` - Never implemented
3. `conversation_backup_pre_cleanup` - Temporary backup table
4. `hashtag_archive` - Never implemented
5. `user_timeline_cache` - Not used
6. `user_view_contexts` - Not used

### Medium Priority (Investigate First):
1. ~~`federation_health`~~ - **KEEP** - Used by federation-backend PerformanceMonitor.ts
2. `activity_processing_logs` - Check if used by federation-backend
3. `v_has_permission` - Determine if this should be a view

**Note:** Federation-backend PerformanceMonitor.ts uses:
- `federation_health` - Used for tracking instance health
- `performance_metrics` - Metrics storage
- `performance_metrics_hourly` - Hourly aggregations
- `slow_queries` - Slow query tracking
- `metrics_summary_view` - Admin dashboard view
- `slow_queries_summary` - Admin dashboard view

### Low Priority (Consider Later):
1. Consolidate federation health tables
2. Add missing columns to init folder tables
3. Add RLS policies for new tables

---

## Next Steps

1. **Test the new init files** on a fresh Supabase instance
2. **Compare column definitions** more carefully
3. **Add RLS policies** for the new tables (07, 08, 09)
4. **Review federation-backend** for references to unused tables
5. **Create migration** to remove confirmed unused tables from production

