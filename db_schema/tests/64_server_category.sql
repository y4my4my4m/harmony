-- servers.category and update_server after 20261006400001_server_category.sql.
--
-- Server A (public) and Server P (private) are alice's. On A: carol holds "managers"
-- (MANAGE_SERVER), bob is a plain member, dave holds "managers" with a banned membership.
-- Server E is alice's with bob a member; its @everyone carries MANAGE_SERVER. Server R is a
-- remote row. mallory is a member of nothing.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(77);

-- Fixture ---------------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('ca720000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol64@test.local'),
  ('ca720000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave64@test.local');

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('ca730000-0000-0000-0000-000000000001', 'ca720000-0000-0000-0000-000000000001', 'carol64', 'Carol', true),
  ('ca730000-0000-0000-0000-000000000002', 'ca720000-0000-0000-0000-000000000002', 'dave64', 'Dave', true);

INSERT INTO public.servers (id, name, description, owner, public) VALUES
  ('ca700000-0000-0000-0000-000000000001', 'Category A', 'About A', '11111111-0000-0000-0000-000000000001', true),
  ('ca700000-0000-0000-0000-000000000002', 'Category P', NULL, '11111111-0000-0000-0000-000000000001', false),
  ('ca700000-0000-0000-0000-000000000003', 'Category E', NULL, '11111111-0000-0000-0000-000000000001', true);
INSERT INTO public.servers (id, name, owner, is_local_server, host_domain) VALUES
  ('ca700000-0000-0000-0000-000000000004', 'Category R', '11111111-0000-0000-0000-000000000001', false, 'remote.example');

-- MANAGE_SERVER is bit 7.
INSERT INTO public.server_roles (id, server_id, name, position, permissions) VALUES
  ('ca710000-0000-0000-0000-000000000001', 'ca700000-0000-0000-0000-000000000001', 'managers', 1, 128);
UPDATE public.server_roles SET permissions = permissions | 128
 WHERE server_id = 'ca700000-0000-0000-0000-000000000003' AND is_default;

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'ca700000-0000-0000-0000-000000000001', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'ca700000-0000-0000-0000-000000000002', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'ca700000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'ca700000-0000-0000-0000-000000000002', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'ca700000-0000-0000-0000-000000000003', 'accepted'),
  ('ca730000-0000-0000-0000-000000000001', 'ca700000-0000-0000-0000-000000000001', 'accepted'),
  ('ca730000-0000-0000-0000-000000000002', 'ca700000-0000-0000-0000-000000000001', 'banned')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('ca730000-0000-0000-0000-000000000001', 'ca710000-0000-0000-0000-000000000001', 'ca700000-0000-0000-0000-000000000001'),
  ('ca730000-0000-0000-0000-000000000002', 'ca710000-0000-0000-0000-000000000001', 'ca700000-0000-0000-0000-000000000001');

CREATE FUNCTION pg_temp.srv(p_server uuid) RETURNS public.servers
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT * FROM public.servers WHERE id = p_server
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.srv(uuid) TO authenticated, anon;

CREATE FUNCTION pg_temp.ctid_of(p_server uuid) RETURNS tid
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT ctid FROM public.servers WHERE id = p_server
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.ctid_of(uuid) TO authenticated, anon;

CREATE TEMP TABLE before_a AS
SELECT * FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000001';
GRANT SELECT ON before_a TO authenticated;

-- Shape -----------------------------------------------------------------------------------
SELECT has_column('public', 'servers', 'category', 'servers.category exists');
SELECT col_type_is('public', 'servers', 'category', 'text', 'servers.category is text');
SELECT col_is_null('public', 'servers', 'category', 'servers.category is nullable');
SELECT col_hasnt_default('public', 'servers', 'category', 'servers.category has no default');
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).category, NULL,
          'a server created without a category has none');

SELECT ok((SELECT p.prosecdef FROM pg_proc p
            WHERE p.oid = 'public.update_server(uuid, jsonb)'::regprocedure),
          'update_server is SECURITY DEFINER');
SELECT ok((SELECT 'search_path=public, pg_temp' = ANY (p.proconfig) FROM pg_proc p
            WHERE p.oid = 'public.update_server(uuid, jsonb)'::regprocedure),
          'update_server pins search_path to public, pg_temp');
SELECT ok(NOT has_function_privilege('anon', 'public.update_server(uuid, jsonb)', 'EXECUTE'),
          'anon holds no EXECUTE on update_server');
SELECT ok(has_function_privilege('authenticated', 'public.update_server(uuid, jsonb)', 'EXECUTE'),
          'authenticated holds EXECUTE on update_server');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                       WHERE p.oid = 'public.update_server(uuid, jsonb)'::regprocedure
                         AND a.grantee = 0),
          'PUBLIC holds no EXECUTE on update_server');

-- MANAGE_SERVER holder --------------------------------------------------------------------
SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000001');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "Renamed A"}') ->> 'name',
          'Renamed A', 'a MANAGE_SERVER holder renames the server');
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).name, 'Renamed A',
          'the new name is stored');
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).owner,
          '11111111-0000-0000-0000-000000000001'::uuid, 'the rename leaves the owner');
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).description, 'About A',
          'keys absent from the changes keep their value');
SELECT ok((SELECT (s.slug, s.is_featured, s.featured_order, s.created_at, s.ap_id, s.federation_metadata)
                  IS NOT DISTINCT FROM (b.slug, b.is_featured, b.featured_order, b.created_at, b.ap_id, b.federation_metadata)
             FROM public.servers s, before_a b WHERE s.id = b.id),
          'the rename leaves columns outside the settings');

SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001',
        '{"description": "New about", "icon": "ca700000-0000-0000-0000-000000000001/icon-1.png",
          "banner": "ca700000-0000-0000-0000-000000000001/banner-1.png", "public": false,
          "federation_enabled": true, "allow_cross_server_emojis": false,
          "rules": ["Be kind", "No spam"], "category": "science"}')$q$,
    'a MANAGE_SERVER holder writes every settings column');
SELECT tests.clear_authentication();
SELECT ok((SELECT (description, icon, banner, public, federation_enabled, allow_cross_server_emojis,
                   rules, category)
                  = ('New about', 'ca700000-0000-0000-0000-000000000001/icon-1.png',
                     'ca700000-0000-0000-0000-000000000001/banner-1.png', false, true, false,
                     '["Be kind", "No spam"]'::jsonb, 'science'::text)
             FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000001'),
          'every settings column is stored');

SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001',
        '{"owner": "ca730000-0000-0000-0000-000000000001"}')$q$,
    '22023', 'server setting owner is not writable', 'the owner column is not writable');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001',
        '{"name": "Sneaky", "is_featured": true}')$q$,
    '22023', NULL, 'a key outside the settings refuses the whole change');
UPDATE public.servers SET name = 'Hijacked', owner = 'ca730000-0000-0000-0000-000000000001'
 WHERE id = 'ca700000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).owner,
          '11111111-0000-0000-0000-000000000001'::uuid, 'the owner is unchanged');
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).name, 'Renamed A',
          'a MANAGE_SERVER holder''s direct UPDATE reaches no row');

SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000002', '{"name": "Other"}')$q$,
    '42501', NULL, 'MANAGE_SERVER on one server does not reach another');
SELECT tests.clear_authentication();

-- Owner -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001', '{"category": "gaming"}') ->> 'category',
          'gaming', 'the owner sets a category through update_server');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "Owner A"}') ->> 'name',
          'Owner A', 'the owner renames through update_server');
UPDATE public.servers SET category = 'music' WHERE id = 'ca700000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).category, 'music',
          'the owner still writes through the servers UPDATE policy');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.servers (id, name, owner, category)
       VALUES ('ca700000-0000-0000-0000-000000000005', 'Category New',
               '11111111-0000-0000-0000-000000000001', 'education')$q$,
    'the owner creates a server with a category');
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000005')).category, 'education',
          'the category chosen at creation is stored');

-- Unchanged values ------------------------------------------------------------------------
CREATE TEMP TABLE probe (ctid_before tid);
GRANT ALL ON probe TO authenticated;
INSERT INTO probe SELECT pg_temp.ctid_of('ca700000-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000001');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001',
          '{"name": "  Owner A ", "category": "music", "public": false}') ->> 'name',
          'Owner A', 'changes equal to the stored values succeed');
SELECT is(pg_temp.ctid_of('ca700000-0000-0000-0000-000000000001'), (SELECT ctid_before FROM probe),
          'changes equal to the stored values write nothing');
SELECT lives_ok($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{}')$q$,
                'an empty change succeeds');
SELECT is(pg_temp.ctid_of('ca700000-0000-0000-0000-000000000001'), (SELECT ctid_before FROM probe),
          'an empty change writes nothing');
SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"public": true}');
SELECT isnt(pg_temp.ctid_of('ca700000-0000-0000-0000-000000000001'), (SELECT ctid_before FROM probe),
            'a changed value writes the row');
SELECT tests.clear_authentication();

-- Refused callers -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "Bob A"}')$q$,
    '42501', 'Missing permission: MANAGE_SERVER', 'a plain member cannot rename the server');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"category": "gaming"}')$q$,
    '42501', 'Missing permission: MANAGE_SERVER', 'a plain member cannot set the category');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"owner": "x"}')$q$,
    '42501', 'Missing permission: MANAGE_SERVER', 'a plain member is refused before key checks');
UPDATE public.servers SET name = 'Bob A' WHERE id = 'ca700000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).name, 'Owner A',
          'a plain member''s direct UPDATE reaches no row');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "Mallory A"}')$q$,
    '42501', 'Missing permission: MANAGE_SERVER', 'a non-member cannot rename the server');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000003', '{"name": "Mallory E"}')$q$,
    '42501', 'Missing permission: MANAGE_SERVER',
    'a non-member cannot rename where @everyone carries MANAGE_SERVER');
UPDATE public.servers SET name = 'Mallory A' WHERE id = 'ca700000-0000-0000-0000-000000000001';
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).name, 'Owner A',
          'a non-member''s direct UPDATE reaches no row');
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000003')).name, 'Category E',
          'the @everyone server keeps its name');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000003', '{"name": "Bob E", "category": "community"}') ->> 'name',
          'Bob E', 'an accepted member holding MANAGE_SERVER through @everyone renames');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "Dave A"}')$q$,
    '42501', NULL, 'a banned member holding MANAGE_SERVER cannot rename the server');
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000001')).name, 'Owner A',
          'the banned member''s rename is not stored');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "Anon A"}')$q$,
    '42501', NULL, 'anon cannot call update_server');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000004', '{"name": "Remote"}')$q$,
    '42501', NULL, 'a remote server row is refused, even to its owner');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000004', '{"category": "gaming"}')$q$,
    '42501', NULL, 'a remote server row takes no category');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-0000000000ff', '{"name": "Ghost"}')$q$,
    '42501', NULL, 'an unknown server is refused');
SELECT tests.clear_authentication();
SELECT is((pg_temp.srv('ca700000-0000-0000-0000-000000000004')).name, 'Category R',
          'the remote row keeps its name');

-- Values ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('ca720000-0000-0000-0000-000000000001');
SELECT lives_ok(
    format($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "%s"}')$q$,
           repeat('n', 100)),
    'a 100-character name is accepted');
SELECT throws_ok(
    format($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "%s"}')$q$,
           repeat('n', 101)),
    '23514', NULL, 'a 101-character name is refused');
SELECT lives_ok(
    format($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": " %s "}')$q$,
           repeat('m', 100)),
    'surrounding whitespace does not count toward the name length');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": "   "}')$q$,
    '23514', 'server name must not be blank', 'a blank name is refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": null}')$q$,
    '22023', NULL, 'a null name is refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"name": 7}')$q$,
    '22023', NULL, 'a numeric name is refused');
SELECT lives_ok(
    format($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"description": "%s"}')$q$,
           repeat('d', 500)),
    'a 500-character description is accepted');
SELECT throws_ok(
    format($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"description": "%s"}')$q$,
           repeat('d', 501)),
    '23514', NULL, 'a 501-character description is refused');
SELECT throws_ok(
    format($q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"rules": %s}')$q$,
           (SELECT jsonb_agg('r' || g) FROM generate_series(1, 26) g)),
    '23514', NULL, 'more than 25 rules are refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"rules": ["ok", 3]}')$q$,
    '22023', NULL, 'a non-string rule is refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"rules": "Be kind"}')$q$,
    '22023', NULL, 'rules that are not an array are refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"public": "yes"}')$q$,
    '22023', NULL, 'a non-boolean public is refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"public": null}')$q$,
    '22023', NULL, 'a null public is refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '["name"]')$q$,
    '22023', NULL, 'changes that are not an object are refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"category": "crafts"}')$q$,
    '23514', NULL, 'an unknown category is refused');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"category": "Gaming"}')$q$,
    '23514', NULL, 'category ids are case-sensitive');
SELECT throws_ok(
    $q$SELECT public.update_server('ca700000-0000-0000-0000-000000000001', '{"category": ""}')$q$,
    '23514', NULL, 'an empty category is refused');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001', '{"category": null}') -> 'category',
          'null'::jsonb, 'a null category clears it');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001', '{"icon": "", "banner": ""}') -> 'icon',
          'null'::jsonb, 'an empty icon is stored as NULL');
SELECT is(public.update_server('ca700000-0000-0000-0000-000000000001', '{"description": ""}') -> 'description',
          'null'::jsonb, 'an empty description is stored as NULL');
SELECT tests.clear_authentication();
SELECT ok((SELECT category IS NULL AND icon IS NULL AND banner IS NULL AND description IS NULL
             FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000001'),
          'cleared columns are NULL');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.servers SET category = 'crafts' WHERE id = 'ca700000-0000-0000-0000-000000000001'$q$,
    '23514', NULL, 'the owner''s direct UPDATE refuses an unknown category');
SELECT throws_ok(
    $q$INSERT INTO public.servers (name, owner, category)
       VALUES ('Category Bad', '11111111-0000-0000-0000-000000000001', 'Art & Design')$q$,
    '23514', NULL, 'creating a server with an unknown category is refused');
SELECT tests.clear_authentication();

-- Reads -----------------------------------------------------------------------------------
UPDATE public.servers SET category = 'technology', public = true WHERE id = 'ca700000-0000-0000-0000-000000000001';
UPDATE public.servers SET category = 'education' WHERE id = 'ca700000-0000-0000-0000-000000000002';

SELECT tests.authenticate_as_anon();
SELECT is((SELECT category FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000001'),
          'technology', 'anon reads the category of a public server');
SELECT is_empty(
    $q$SELECT category FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000002'$q$,
    'anon does not see a private server');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT category FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000001'),
          'technology', 'a non-member reads the category of a public server');
SELECT is_empty(
    $q$SELECT category FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000002'$q$,
    'a non-member does not see a private server');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT category FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000002'),
          'education', 'a member reads the category of a private server');
SELECT is((SELECT name FROM public.servers WHERE id = 'ca700000-0000-0000-0000-000000000001'),
          repeat('m', 100), 'a member reads the name a MANAGE_SERVER holder wrote');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
