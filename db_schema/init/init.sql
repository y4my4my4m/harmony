-- =============================================================================
-- Harmony Database Schema - Complete Initialization Script
-- =============================================================================
-- This script initializes a fresh Supabase database with the Harmony schema.
--
-- USAGE:
--   psql -h localhost -p 54322 -U postgres -d postgres -f init.sql
--
-- Or run each file individually in the Supabase SQL Editor.
-- =============================================================================

\echo '=============================================='
\echo 'Harmony Database Initialization'
\echo '=============================================='

-- ---------------------------------------------------------------------------
-- PHASE 1: Extensions and Types
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 00_extensions.sql - Installing extensions...'
\i 00_extensions.sql

\echo ''
\echo '>>> 01_types.sql - Creating custom types...'
\i 01_types.sql

-- ---------------------------------------------------------------------------
-- PHASE 2: Tables (in dependency order)
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 02_tables_core.sql - Creating core tables (profiles, instance_config)...'
\i 02_tables_core.sql

\echo ''
\echo '>>> 03_tables_social.sql - Creating social tables (posts, follows, timeline)...'
\i 03_tables_social.sql

\echo ''
\echo '>>> 04_tables_servers.sql - Creating server tables (servers, channels, messages)...'
\i 04_tables_servers.sql

\echo ''
\echo '>>> 05_tables_federation.sql - Creating federation tables (ActivityPub)...'
\i 05_tables_federation.sql

\echo ''
\echo '>>> 06_tables_misc.sql - Creating miscellaneous tables (notifications, files, bots)...'
\i 06_tables_misc.sql

\echo ''
\echo '>>> 07_tables_trending.sql - Creating trending/discovery tables...'
\i 07_tables_trending.sql

\echo ''
\echo '>>> 08_tables_bots_extended.sql - Creating extended bot tables...'
\i 08_tables_bots_extended.sql

\echo ''
\echo '>>> 09_tables_encryption.sql - Creating E2E encryption tables...'
\i 09_tables_encryption.sql

\echo ''
\echo '>>> 71_views_performance.sql - Creating performance/monitoring tables, views, functions...'
\i 71_views_performance.sql

-- ---------------------------------------------------------------------------
-- PHASE 3: Functions
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 10_functions_core.sql - Creating core helper functions...'
\i 10_functions_core.sql

\echo ''
\echo '>>> 11_functions_triggers.sql - Creating trigger functions...'
\i 11_functions_triggers.sql

\echo ''
\echo '>>> 12_functions_rpc.sql - Creating RPC functions...'
\i 12_functions_rpc.sql

\echo ''
\echo '>>> 13_functions_rpc_extended.sql - Creating extended RPC functions...'
\i 13_functions_rpc_extended.sql

-- ---------------------------------------------------------------------------
-- PHASE 4: RLS Policies
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 30_rls_policies.sql - Creating core RLS policies...'
\i 30_rls_policies.sql

\echo ''
\echo '>>> 31_rls_policies_extended.sql - Creating extended RLS policies...'
\i 31_rls_policies_extended.sql

-- ---------------------------------------------------------------------------
-- PHASE 5: Triggers
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 40_triggers.sql - Creating triggers...'
\i 40_triggers.sql

-- ---------------------------------------------------------------------------
-- PHASE 6: Realtime
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 50_realtime.sql - Configuring realtime publications...'
\i 50_realtime.sql

-- ---------------------------------------------------------------------------
-- PHASE 7: Views
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 70_views.sql - Creating views...'
\i 70_views.sql

-- ---------------------------------------------------------------------------
-- PHASE 8: Additional Functions (Federation, LiveKit)
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 90_federation_functions.sql - Creating federation helper functions...'
\i 90_federation_functions.sql

\echo ''
\echo '>>> 95_livekit_tokens.sql - Creating LiveKit token functions...'
\i 95_livekit_tokens.sql

-- ---------------------------------------------------------------------------
-- PHASE 9: Seed Data, Storage, and RLS Activation
-- ---------------------------------------------------------------------------
\echo ''
\echo '>>> 96_seed_data.sql - Inserting default configuration...'
\i 96_seed_data.sql

\echo ''
\echo '>>> 97_storage_buckets.sql - Creating storage buckets...'
\i 97_storage_buckets.sql

\echo ''
\echo '>>> 98_enable_rls.sql - Enabling Row Level Security on all tables...'
\i 98_enable_rls.sql

\echo ''
\echo '>>> 99_performance_hardening.sql - Pinning function search_path + FK indexes...'
\i 99_performance_hardening.sql

\echo ''
\echo '>>> 99_cron_jobs.sql - Scheduling recurring jobs (pg_cron)...'
\i 99_cron_jobs.sql

\echo ''
\echo '>>> 99_migration_tracking.sql - Creating migration tracking table...'
\i 99_migration_tracking.sql

\echo ''
\echo 'Harmony database initialization complete.'
\echo ''
