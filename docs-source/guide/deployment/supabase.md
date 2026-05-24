# Supabase Setup

Harmony uses Supabase as its backend for PostgreSQL, authentication, realtime subscriptions, and file storage.

## Hosted vs Self-Hosted

| Option | Pros | Cons |
|--------|------|------|
| **Supabase Cloud** | Managed, easy setup, automatic backups | Monthly cost, data on third-party servers |
| **Self-hosted** | Full control, no recurring cost | More setup, you manage backups and updates |

Both are fully supported. The Docker deployment supports either via `docker-compose.prod.yml` (cloud) or `docker-compose.full.yml` (self-hosted).

## Database Schema

### Fresh Installation

The schema for a fresh install lives in `db_schema/init/`. Files are loaded in order by `init.sql`:

| Phase | Files | Purpose |
|-------|-------|---------|
| Extensions & Types | `00_extensions.sql`, `01_types.sql` | pg extensions, custom enums |
| Tables | `02_tables_core.sql` through `09_tables_encryption.sql` | All tables (core, social, servers, federation, misc, trending, bots, encryption) |
| Functions | `10_functions_core.sql` through `13_functions_rpc_extended.sql` | Database functions and RPCs |
| RLS Policies | `30_rls_policies.sql`, `31_rls_policies_extended.sql` | Row Level Security |
| Triggers | `40_triggers.sql` | Event triggers |
| Realtime | `50_realtime.sql` | Realtime publications |
| Views | `70_views.sql`, `71_views_performance.sql` | Database views |
| Federation | `90_federation_functions.sql` | Federation-specific functions |
| LiveKit | `95_livekit_tokens.sql` | Voice/video token functions |
| Seed & Storage | `96_seed_data.sql`, `97_storage_buckets.sql` | Initial data, storage buckets |
| Enable RLS | `98_enable_rls.sql` | Enable RLS on all tables |

### Running Init Scripts

**With Supabase CLI (local development):**

```bash
supabase start
supabase db reset
```

**With Supabase Cloud:**

Run each init file in order via the SQL Editor in the Supabase Dashboard, or use the CLI:

```bash
supabase db push
```

### Migrations

Incremental changes go in `db_schema/migrations/` as dated, idempotent SQL files:

```sql
-- db_schema/migrations/20260306_example.sql
BEGIN;

CREATE OR REPLACE FUNCTION my_function()
RETURNS void AS $$
BEGIN
  -- implementation
END;
$$ LANGUAGE plpgsql;

DROP POLICY IF EXISTS "my_policy" ON my_table;
CREATE POLICY "my_policy" ON my_table
  FOR SELECT USING (true);

COMMIT;
```

Run migrations via the Supabase SQL Editor or CLI.

## Row Level Security (RLS)

Every table has RLS enabled (`98_enable_rls.sql`). Policies are defined in:

- `30_rls_policies.sql` - Core policies
- `31_rls_policies_extended.sql` - Extended policies

Key RLS helper: `get_current_profile_id()` returns the profile ID for the authenticated user, used extensively in policies.

### SECURITY DEFINER Functions

Some functions use `SECURITY DEFINER` to bypass RLS for operations that need elevated access (e.g., `send_notification()`, `queue_federation_job()`). These run as the function owner rather than the calling user.

## Permissions

Permissions use `bigint` bitmasks, not JSONB. See `permissionsService.ts` for bit positions. If your local environment has legacy `jsonb` permission columns, run `convert_permissions_to_bigint.sql`.

## Storage Buckets

`97_storage_buckets.sql` creates the required storage buckets:

- User avatars and banners
- Server icons
- Message attachments
- Custom emoji

## Authentication

Supabase Auth handles user authentication with:

- Email/password registration
- OAuth providers (configurable via `VITE_ENABLED_OAUTH_PROVIDERS`)
- JWT tokens with automatic refresh
- MFA (two-factor authentication) support

A database trigger creates a profile record when a new user registers.

## Realtime

`50_realtime.sql` configures which tables publish realtime events. The frontend subscribes via `RealtimeConnectionManager` for:

- New messages in channels
- Presence updates
- Notification delivery
- Typing indicators

## Reference Backup

`db_schema/latest_dev_backup.sql` contains a full schema dump from a production-like environment. Use it as a reference but not as an installation source - always use `db_schema/init/` for fresh deploys.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/deployment/supabase.md` and run `npm run docs:generate-guide` to update.
