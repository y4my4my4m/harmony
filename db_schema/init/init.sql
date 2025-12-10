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

\echo ''
\echo '>>> 00_extensions.sql - Installing extensions...'
\i 00_extensions.sql

\echo ''
\echo '>>> 01_types.sql - Creating custom types...'
\i 01_types.sql

\echo ''
\echo '>>> 02_tables_core.sql - Creating core tables...'
\i 02_tables_core.sql

\echo ''
\echo '>>> 03_tables_social.sql - Creating social tables...'
\i 03_tables_social.sql

\echo ''
\echo '>>> 04_tables_servers.sql - Creating server tables...'
\i 04_tables_servers.sql

\echo ''
\echo '>>> 05_tables_federation.sql - Creating federation tables...'
\i 05_tables_federation.sql

\echo ''
\echo '>>> 06_tables_misc.sql - Creating miscellaneous tables...'
\i 06_tables_misc.sql

\echo ''
\echo '>>> 30_rls_policies.sql - Creating RLS policies...'
\i 30_rls_policies.sql

\echo ''
\echo '>>> 50_realtime.sql - Configuring realtime...'
\i 50_realtime.sql

\echo ''
\echo '>>> 95_livekit_tokens.sql - Creating LiveKit token functions...'
\i 95_livekit_tokens.sql

\echo ''
\echo '>>> 98_seed_data.sql - Inserting default configuration...'
\i 98_seed_data.sql

\echo ''
\echo '>>> 99_storage_buckets.sql - Creating storage buckets...'
\i 99_storage_buckets.sql

\echo ''
\echo '=============================================='
\echo 'Harmony Database Initialization Complete!'
\echo '=============================================='
\echo ''
\echo 'Next steps:'
\echo '  1. Update instance_config.domain with your domain:'
\echo '     UPDATE instance_config SET config_value=''"your-domain.com"'' WHERE config_key=''domain'';'
\echo '  2. Configure storage bucket URLs if using custom domain'
\echo '  3. Set up federation backend environment variables'
\echo ''

