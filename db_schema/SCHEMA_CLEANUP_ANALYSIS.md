# Database Schema Cleanup Analysis

This document analyzes the current production database (`supabase_minimal.sql`) to identify unused, duplicate, or legacy tables that may be candidates for removal or consolidation.

## Analysis Date: December 2024

---

## ✅ COMPLETED WORK

### Functions & Triggers (HIGH PRIORITY - DONE)

All critical functions and triggers have been added to the init folder:

- ✅ `10_functions_core.sql` - Core helper functions (get_current_profile_id, conversation helpers, status helpers)
- ✅ `11_functions_triggers.sql` - All trigger functions (timeline, reactions, federation queuing)
- ✅ `12_functions_rpc.sql` - RPC functions called from frontend (conversations, timelines, encryption)
- ✅ `40_triggers.sql` - All CREATE TRIGGER statements

### Tables Added to Init Folder

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
- ✅ `encryption_sessions` → `09_tables_encryption.sql`
- ✅ `encryption_audit_log` → `09_tables_encryption.sql`
- ✅ `notification_rate_limits` → `06_tables_misc.sql`
- ✅ `user_view_contexts` → `06_tables_misc.sql`
- ✅ `message_search_index` → `06_tables_misc.sql`
- ✅ `remote_emojis_cache` → `06_tables_misc.sql`

### RLS Policies Added

- ✅ `31_rls_policies_extended.sql` - All RLS policies for new tables

### Views Added

- ✅ `70_views.sql` - Database views
- ✅ `71_views_performance.sql` - Performance monitoring views and functions

### Security Fixes

- ✅ Fixed `webrtc_settings_select_all` RLS policy exposing LiveKit API secret
- ✅ Fixed `set_instance_config` admin authorization bypass
- ✅ Added `get_livekit_config()` function for safe public access

---

## Current Init Folder Structure

| File | Description |
|------|-------------|
| `00_extensions.sql` | PostgreSQL extensions |
| `01_types.sql` | Custom types and enums |
| `02_tables_core.sql` | Core tables (profiles, instance_config) |
| `03_tables_social.sql` | Social tables (posts, follows, timeline) |
| `04_tables_servers.sql` | Server tables (servers, channels, messages) |
| `05_tables_federation.sql` | Federation tables (ActivityPub) |
| `06_tables_misc.sql` | Misc tables (notifications, files, bots, search) |
| `07_tables_trending.sql` | Trending/discovery tables |
| `08_tables_bots_extended.sql` | Extended bot functionality |
| `09_tables_encryption.sql` | E2E encryption tables |
| `10_functions_core.sql` | Core helper functions |
| `11_functions_triggers.sql` | Trigger functions |
| `12_functions_rpc.sql` | RPC functions |
| `30_rls_policies.sql` | Core RLS policies |
| `31_rls_policies_extended.sql` | Extended RLS policies |
| `40_triggers.sql` | Trigger definitions |
| `50_realtime.sql` | Realtime publications |
| `70_views.sql` | Database views |
| `71_views_performance.sql` | Performance views & functions |
| `90_federation_functions.sql` | Federation helper functions |
| `95_livekit_tokens.sql` | LiveKit token generation |
| `98_seed_data.sql` | Default configuration |
| `99_storage_buckets.sql` | Storage buckets |
| `init.sql` | Combined init script |
| `README.md` | Documentation |

---

## Tables Potentially UNUSED (Low Priority Investigation)

These tables exist in production but may not be actively used:

| Table | Reason | Recommendation |
|-------|--------|----------------|
| `conversation_backup_pre_cleanup` | Backup table from migration | **REMOVE** - Temporary table |
| `hashtag_archive` | No code references | **REMOVE** - Not implemented |
| `activity_processing_logs` | Check federation-backend | **REVIEW** |
| `emoji_usage` | Limited analytics use | **REVIEW** |
| `v_has_permission` | Named like a view | **INVESTIGATE** - Naming issue |

---

## Duplicate/Overlapping Federation Tables

The federation health tracking has multiple tables that serve different purposes:

| Table | Purpose | Status |
|-------|---------|--------|
| `federated_instances` | Master list of known instances | KEEP |
| `federation_endpoint_health` | Per-endpoint health (inbox URLs) | KEEP |
| `federation_health` | Overall health metrics | KEEP - Used by federation-backend |
| `federation_delivery_queue` | Outgoing activity queue | KEEP |
| `federation_delivery_stats` | Delivery statistics | REVIEW |
| `activitypub_processing_stats` | Processing statistics | REVIEW |

**Note:** These are NOT duplicates - they track different aspects of federation:
- Instances (overall)
- Endpoints (specific URLs)  
- Health (status over time)
- Queue (pending deliveries)

---

## Schema Sync Status

The init folder should now be functionally complete for fresh installations:

### ✅ Complete:
- All core tables
- All social tables  
- All server tables
- All federation tables
- All encryption tables
- All trending tables
- All bot tables
- All core functions
- All trigger functions
- All RPC functions
- All triggers
- All RLS policies
- All views

### ⚠️ May Need Updates:
- Some advanced federation functions (complex ActivityPub processing)
- Some performance optimization functions
- Link preview functions (require external services)

---

## Testing

To test the init folder on a fresh Supabase instance:

```bash
cd db_schema/init
psql -h localhost -p 54322 -U postgres -d postgres -f init.sql
```

Or run files individually in order via Supabase Dashboard SQL Editor.

---

## Next Steps (Low Priority)

1. **Production comparison** - Diff remaining column-level differences
2. **Cleanup unused tables** - Remove confirmed unused tables from prod
3. **Advanced functions** - Port remaining complex federation functions if needed
4. **Performance testing** - Test on fresh instance with sample data
