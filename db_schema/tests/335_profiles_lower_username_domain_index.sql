-- 20261123400001_profiles_lower_username_domain_index.sql: public_profile_page finds an account by
-- lower(username) and lower(domain) through an index.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

CREATE FUNCTION pg_temp.plan_of(p_query text) RETURNS SETOF text LANGUAGE plpgsql AS
  $$ DECLARE l text; BEGIN FOR l IN EXECUTE 'EXPLAIN ' || p_query LOOP RETURN NEXT l; END LOOP; END $$;

SELECT ok((SELECT x.indisvalid FROM pg_index x WHERE x.indexrelid = to_regclass('public.idx_profiles_lower_username_domain')),
  'idx_profiles_lower_username_domain exists and is valid');
SELECT is((SELECT pg_get_indexdef(to_regclass('public.idx_profiles_lower_username_domain'))),
  'CREATE INDEX idx_profiles_lower_username_domain ON public.profiles USING btree (lower(username), lower(domain))',
  'it keys lower(username), lower(domain) over every profile');

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('e3350000-0000-0000-0000-0000000000d1', 'Modiie335', 'Modiie', false, 'piaille335.test',
   'https://piaille335.test/users/Modiie335');

SET LOCAL enable_seqscan = off;
SELECT ok(EXISTS (
    SELECT 1 FROM pg_temp.plan_of($q$
        SELECT * FROM public.profiles p
         WHERE p.is_local IS FALSE
           AND lower(p.username) = lower(btrim('MODIIE335'))
           AND lower(p.domain) = 'piaille335.test'
         ORDER BY (p.username = btrim('MODIIE335')) DESC, p.created_at
         LIMIT 1$q$) AS line
     WHERE line LIKE '%idx_profiles_lower_username_domain%'),
  'the remote branch of public_profile_page reads the index');
SELECT ok(EXISTS (
    SELECT 1 FROM pg_temp.plan_of($q$
        SELECT * FROM public.profiles p
         WHERE p.is_local IS NOT FALSE
           AND lower(p.username) = lower(btrim('alice'))
         ORDER BY (p.username = btrim('alice')) DESC, p.created_at
         LIMIT 1$q$) AS line
     WHERE line LIKE '%idx_profiles_lower_username_domain%'),
  'the local branch reads it by its leading column');
RESET enable_seqscan;

SELECT is((public.public_profile_page('modiie335', NULL, NULL, 'PIAILLE335.test') #>> '{account,id}'),
  'e3350000-0000-0000-0000-0000000000d1', 'the page still finds the account without case');

SELECT * FROM finish();
ROLLBACK;
