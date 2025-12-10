# Harmony Database Initialization

This folder contains the organized database schema for Harmony, designed to be run on a fresh Supabase instance.

## Quick Start

### For Supabase Cloud

1. Go to your Supabase Dashboard
2. Navigate to SQL Editor
3. Run `00_extensions.sql` first (may require enabling extensions in Dashboard)
4. Run the remaining files in order (01, 02, 03, etc.)
5. Run `99_storage_buckets.sql` last

### For Self-Hosted Supabase

```bash
# Connect to your database
psql -h localhost -p 54322 -U postgres -d postgres

# Run all files in order
\i 00_extensions.sql
\i 01_types.sql
\i 02_tables_core.sql
\i 03_tables_social.sql
\i 04_tables_servers.sql
\i 05_tables_federation.sql
\i 06_tables_misc.sql
\i 10_functions_core.sql
\i 11_functions_federation.sql
\i 12_functions_triggers.sql
\i 20_indexes.sql
\i 30_rls_policies.sql
\i 40_triggers.sql
\i 50_realtime.sql
\i 99_storage_buckets.sql
```

### Using the Combined Script

For convenience, you can also run the combined `init.sql` script:

```bash
psql -h localhost -p 54322 -U postgres -d postgres -f init.sql
```

## File Order

| Order | File | Description |
|-------|------|-------------|
| 00 | extensions.sql | PostgreSQL extensions (pgcrypto, uuid-ossp, pg_trgm, pg_net) |
| 01 | types.sql | Custom types and enums |
| 02 | tables_core.sql | Core tables: profiles, auth integration |
| 03 | tables_social.sql | Social tables: posts, follows, interactions |
| 04 | tables_servers.sql | Server tables: servers, channels, messages |
| 05 | tables_federation.sql | Federation tables: instances, activities |
| 06 | tables_misc.sql | Miscellaneous tables: bots, encryption, etc. |
| 10 | functions_core.sql | Core functions |
| 11 | functions_federation.sql | Federation functions |
| 12 | functions_triggers.sql | Trigger functions |
| 20 | indexes.sql | Performance indexes |
| 30 | rls_policies.sql | Row Level Security policies |
| 40 | triggers.sql | Database triggers |
| 50 | realtime.sql | Supabase Realtime publications |
| 98 | seed_data.sql | Default instance configuration |
| 99 | storage_buckets.sql | Storage buckets and policies |

## Important Notes

1. **Extensions**: Some extensions (like `pg_net`) may need to be enabled via the Supabase Dashboard first
2. **Order matters**: Files must be run in numerical order due to dependencies
3. **Idempotent**: Most statements use `IF NOT EXISTS` for safe re-runs
4. **RLS**: Row Level Security is enabled on all tables by default

## Troubleshooting

### Extension errors
If you get errors about extensions, go to Supabase Dashboard > Database > Extensions and enable the required extensions first.

### Permission errors
Make sure you're connected as the postgres superuser for the initial setup.

### Foreign key errors
If you get FK constraint errors, ensure you're running files in the correct order.

