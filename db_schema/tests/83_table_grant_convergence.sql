-- 20261007900001_table_grant_convergence.sql: default privileges in public and the table
-- privileges of a fresh install. Production had neither; a fresh install has both, so this
-- file holds the state the migration converges to.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(8);

SELECT is_empty(
    $q$SELECT o.owner_role || ' ' || o.objtype || ' ' || g.grantee
         FROM (VALUES ('postgres'), ('supabase_admin')) o0(owner_role)
        CROSS JOIN LATERAL (VALUES (o0.owner_role, 'r'), (o0.owner_role, 'S'), (o0.owner_role, 'f')) o(owner_role, objtype)
        CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) g(grantee)
        WHERE NOT EXISTS (
              SELECT 1
                FROM pg_default_acl d
               CROSS JOIN LATERAL aclexplode(d.defaclacl) a
               WHERE d.defaclrole = o.owner_role::regrole
                 AND d.defaclnamespace = 'public'::regnamespace
                 AND d.defaclobjtype::text = o.objtype
                 AND a.grantee = g.grantee::regrole)$q$,
    'postgres and supabase_admin grant new tables, sequences and functions in public to the API roles');

CREATE TABLE public.tests_default_privilege_probe (id int);
SELECT ok(has_table_privilege('service_role', 'public.tests_default_privilege_probe', 'SELECT,INSERT,UPDATE,DELETE'),
          'a new table is open to service_role');
SELECT ok(has_table_privilege('authenticated', 'public.tests_default_privilege_probe', 'SELECT'),
          'a new table is readable by authenticated, subject to its policies');

SELECT is_empty(
    $q$SELECT c.relname
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind IN ('r', 'p', 'v', 'm')
          AND c.relname <> 'mfa_recovery_codes'
          AND NOT has_table_privilege('service_role', c.oid, 'SELECT')$q$,
    'service_role reads every public relation but mfa_recovery_codes');

SELECT ok(has_table_privilege('service_role', 'public.server_bans', 'SELECT')
          AND has_table_privilege('service_role', 'public.user_blocks', 'SELECT'),
          'service_role reads server_bans and user_blocks (voice token checks)');

SELECT ok(has_table_privilege('authenticated', 'public.server_bans', 'SELECT'),
          'authenticated reads server_bans, subject to its policies');

SELECT ok(NOT has_table_privilege('service_role', 'public.mfa_recovery_codes', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.mfa_recovery_codes', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.mfa_recovery_codes', 'SELECT'),
          'mfa_recovery_codes stays closed to every API role');

SELECT ok(has_sequence_privilege('service_role', 'public.activity_processing_logs_id_seq', 'USAGE'),
          'service_role uses activity_processing_logs_id_seq');

SELECT * FROM finish();
ROLLBACK;
