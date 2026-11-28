-- 20261123400004_emojis_domain_name_unique_drop.sql: idx_emojis_unique_federated_domain_name, as
-- production holds it, refuses the rows the copy sync writes; the migration's drop lets them in.
-- The file runs in a transaction, where DROP INDEX CONCURRENTLY is refused: the plain DROP INDEX
-- stands in for it.
--
--   copya338, copyb338   copies of two servers hosted on remote.test, each with an emoji "wave"
--   wave dropped         copya338's "wave" the Group dropped, kept; the host's new "wave" follows
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(7);

CREATE TABLE tests.fed_jobs (name text, data jsonb);
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.fed_jobs VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

SELECT ok(to_regclass('public.idx_emojis_unique_federated_domain_name') IS NULL,
  'a fresh install holds no idx_emojis_unique_federated_domain_name');

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, is_local)
VALUES ('e3380000-0000-0000-0000-0000000000e1', 'remote338', 'Remote 338', 'remote.test', 'https://remote.test/users/remote338', false);
INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, host_domain, ap_id) VALUES
  ('e3380000-0000-0000-0000-0000000000a1', 'Copy A 338', 'e3380000-0000-0000-0000-0000000000e1', false, true,
   'remote.test', 'https://remote.test/servers/e3380000-0000-0000-0000-0000000000a1'),
  ('e3380000-0000-0000-0000-0000000000a2', 'Copy B 338', 'e3380000-0000-0000-0000-0000000000e1', false, true,
   'remote.test', 'https://remote.test/servers/e3380000-0000-0000-0000-0000000000a2');
INSERT INTO public.emojis (id, name, url, server_id, scope, domain, ap_id, deleted_at, ap_removed_at)
VALUES ('e3380000-0000-0000-0000-000000000101', 'wave', 'https://remote.test/e/a-wave.webp',
        'e3380000-0000-0000-0000-0000000000a1', 'server', 'remote.test',
        'https://remote.test/servers/e3380000-0000-0000-0000-0000000000a1/emojis/1', now(), now());

-- As production holds it (schema-prod-20261110a.sql).
CREATE UNIQUE INDEX idx_emojis_unique_federated_domain_name ON public.emojis USING btree (domain, name) WHERE (domain IS NOT NULL);

PREPARE copy_b_wave AS
    INSERT INTO public.emojis (name, url, server_id, scope, domain, ap_id)
    VALUES ('wave', 'https://remote.test/e/b-wave.webp', 'e3380000-0000-0000-0000-0000000000a2', 'server', 'remote.test',
            'https://remote.test/servers/e3380000-0000-0000-0000-0000000000a2/emojis/2');
PREPARE copy_a_new_wave AS
    INSERT INTO public.emojis (name, url, server_id, scope, domain, ap_id)
    VALUES ('wave', 'https://remote.test/e/a-wave2.webp', 'e3380000-0000-0000-0000-0000000000a1', 'server', 'remote.test',
            'https://remote.test/servers/e3380000-0000-0000-0000-0000000000a1/emojis/3');
PREPARE cached_new_image AS
    INSERT INTO public.emojis (name, url, server_id, domain)
    VALUES ('wave', 'https://remote.test/e/a-wave3.webp', NULL, 'remote.test');

SELECT throws_ok('copy_b_wave', '23505', NULL,
  'with the index, the second server''s "wave" is refused on its copy');
SELECT throws_ok('copy_a_new_wave', '23505', NULL,
  'and so is the host''s new "wave" while the dropped one is kept');

-- The migration's statement.
DROP INDEX IF EXISTS public.idx_emojis_unique_federated_domain_name;

SELECT lives_ok('copy_b_wave', 'the second server''s "wave" is stored');
SELECT lives_ok('copy_a_new_wave', 'the host''s new "wave" is stored next to the dropped one');
SELECT lives_ok('cached_new_image', 'an activity''s new image of a cached shortcode is stored');
SELECT is((SELECT count(*)::int FROM public.emojis WHERE domain = 'remote.test' AND name = 'wave'), 4,
  'one instance holds four rows named "wave"');

SELECT * FROM finish();
ROLLBACK;
