-- Storage policies from 20261006500001_server_media_delete_policies.sql: server_banners
-- deletes, bot avatar uploads.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(8);
-- Newer storage schemas refuse direct DELETE unless this is set, as storage-api does;
-- RLS still applies.
SELECT set_config('storage.allow_delete_query', 'true', true);

INSERT INTO public.servers (id, name, owner)
VALUES ('69000000-0000-0000-0000-000000000005', 'Banner Server', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '69000000-0000-0000-0000-000000000005', 'accepted'),
       ('33333333-0000-0000-0000-000000000003', '69000000-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT DO NOTHING;
-- Schema-only clones of live instances carry no bucket rows.
INSERT INTO storage.buckets (id, name, public)
VALUES ('server_banners', 'server_banners', true), ('avatars', 'avatars', true), ('banners', 'banners', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name)
VALUES ('server_banners', '69000000-0000-0000-0000-000000000005/banner-1.webp');

INSERT INTO public.bots (id, username, owner_id)
VALUES ('69000000-0000-0000-0000-0000000000b1', 'alicebot69', '11111111-0000-0000-0000-000000000001'),
       ('69000000-0000-0000-0000-0000000000b2', 'bobbot69', '22222222-0000-0000-0000-000000000002');

-- SERVER BANNERS --------------------------------------------------------------------------
-- mallory: plain member, no MANAGE_SERVER.
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'server_banners'
        AND name = '69000000-0000-0000-0000-000000000005/banner-1.webp' RETURNING id$q$,
    'a member without MANAGE_SERVER cannot delete the server banner');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'server_banners'
        AND name = '69000000-0000-0000-0000-000000000005/banner-1.webp' RETURNING id$q$,
    'a non-member cannot delete the server banner');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT isnt_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'server_banners'
        AND name = '69000000-0000-0000-0000-000000000005/banner-1.webp' RETURNING id$q$,
    'the owner deletes a replaced server banner');

-- BOT AVATARS -----------------------------------------------------------------------------
-- The pre-existing avatars policies read auth.role(), which tests.authenticate_as leaves unset.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('avatars', 'bots/69000000-0000-0000-0000-0000000000b1/avatar-1.webp')$q$,
    'a bot owner uploads under bots/<own bot>/');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('avatars', 'bots/69000000-0000-0000-0000-0000000000b2/avatar-1.webp')$q$,
    '42501'::char(5), NULL, 'a user cannot upload under another owner''s bot');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('avatars', 'bots/not-a-uuid/avatar-1.webp')$q$,
    '42501'::char(5), NULL, 'a folder that names no bot is refused, not an error');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('banners', 'bots/69000000-0000-0000-0000-0000000000b1/banner-1.webp')$q$,
    '42501'::char(5), NULL, 'bot uploads are admitted in avatars only');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('avatars', 'bots/69000000-0000-0000-0000-0000000000b1/avatar-2.webp')$q$,
    '42501'::char(5), NULL, 'a user who owns no bot cannot upload under bots/');

SELECT * FROM finish();
ROLLBACK;
