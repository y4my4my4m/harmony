-- posts reply counting after 20261005800001_drop_legacy_reply_count_triggers.sql.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(2);

SELECT is((SELECT array_agg(t.tgname ORDER BY t.tgname)
             FROM pg_trigger t
            WHERE t.tgrelid = 'public.posts'::regclass AND NOT t.tgisinternal
              AND t.tgfoid = 'public.update_post_reply_count()'::regprocedure),
          ARRAY['trg_update_post_reply_count']::name[],
          'one trigger maintains replies_count');

-- A remote parent moves by one per reply.
INSERT INTO public.profiles (id, username, display_name, domain, is_local, federated_id)
VALUES ('59000000-0000-0000-0000-0000000000a1', 'origin59', 'Origin', 'remote.example', false,
        'https://remote.example/users/origin59');
INSERT INTO public.posts (id, author_id, content, is_local, visibility, replies_count, ap_id)
VALUES ('59000000-0000-0000-0000-000000000001', '59000000-0000-0000-0000-0000000000a1',
        '[{"type":"text","text":"remote parent"}]', false, 'public', 5, 'https://remote.example/notes/59');
INSERT INTO public.posts (id, author_id, content, is_local, visibility, in_reply_to)
VALUES ('59000000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
        '[{"type":"text","text":"local reply"}]', true, 'public', '59000000-0000-0000-0000-000000000001');
SELECT is((SELECT replies_count FROM public.posts WHERE id = '59000000-0000-0000-0000-000000000001'), 6,
          'a reply to a remote parent adds one to its origin figure');

SELECT * FROM finish();
ROLLBACK;
