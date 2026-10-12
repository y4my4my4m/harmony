-- FEP-044f quote stamps after 20261013500001_quote_authorizations.sql.
--
-- Profiles: author138 local; quoter138 remote, md138.test.
-- Posts: 01 author's public post, quoted.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(6);

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('f1380000-0000-0000-0000-0000000000a1', NULL, 'author138', 'Author', true);
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain)
VALUES ('f1380000-0000-0000-0000-0000000000a2', NULL, 'quoter138', 'Quoter', false, 'md138.test');
INSERT INTO public.posts (id, author_id, content, visibility, is_local)
VALUES ('f1380000-0000-0000-0000-000000000001', 'f1380000-0000-0000-0000-0000000000a1',
        '[{"type":"text","text":"quote me"}]', 'public', true);

SET LOCAL ROLE service_role;
INSERT INTO public.quote_authorizations (quoted_post_id, quoting_post_uri, quoting_actor_uri, request_uri)
VALUES ('f1380000-0000-0000-0000-000000000001', 'https://md138.test/users/quoter138/statuses/1',
        'https://md138.test/users/quoter138', 'https://md138.test/users/quoter138/statuses/1/quote');
RESET ROLE;

SELECT throws_ok($q$INSERT INTO public.quote_authorizations (quoted_post_id, quoting_post_uri, quoting_actor_uri)
    VALUES ('f1380000-0000-0000-0000-000000000001', 'https://md138.test/users/quoter138/statuses/1', 'https://md138.test/users/quoter138')$q$,
    '23505', NULL, 'one stamp per quote of a post');
SELECT throws_ok($q$INSERT INTO public.quote_authorizations (quoted_post_id, quoting_post_uri, quoting_actor_uri)
    VALUES ('f1380000-0000-0000-0000-000000000001', 'javascript:alert(1)', 'https://md138.test/users/quoter138')$q$,
    '23514', NULL, 'a quote post uri must be http(s)');
SELECT ok(NOT has_table_privilege('authenticated', 'public.quote_authorizations', 'SELECT'),
    'clients cannot read stamps');
SELECT ok(NOT has_table_privilege('anon', 'public.quote_authorizations', 'SELECT'),
    'anonymous clients cannot read stamps');
SELECT ok(has_table_privilege('service_role', 'public.quote_authorizations', 'INSERT'),
    'the federation backend writes stamps');

DELETE FROM public.posts WHERE id = 'f1380000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM public.quote_authorizations
            WHERE quoted_post_id = 'f1380000-0000-0000-0000-000000000001'), 0,
    'deleting the quoted post deletes its stamps');

SELECT * FROM finish();
ROLLBACK;
