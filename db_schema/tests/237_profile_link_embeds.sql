-- 20261107200001_profile_link_embeds.sql: previews of this instance's account and post
-- addresses. detect_embed_provider names harmony-profile and harmony-post on the instance's
-- domain only; fetch_link_preview builds an account card with public fields of an account the
-- public pages show, and none of a suspended or unknown one; a message carrying the link gets
-- the card through trg_process_local_link_previews.
--
-- ann237    local, display name, bio, locked
-- bob237    remote, of far237.test
-- gone237   local, suspended

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(24);

INSERT INTO public.instance_config (config_key, config_value) VALUES ('domain', '"here237.test"')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('f2370000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ann237@test.local'),
  ('f2370000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gone237@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, bio, is_local, domain, manually_approves_followers,
                             followers_count, following_count) VALUES
  ('f2370000-0000-0000-0000-0000000000c1', 'f2370000-0000-0000-0000-0000000000a1', 'ann237', 'Ann Lumen',
   'Painter of <b>night</b> skies.', true, 'here237.test', true, 12, 3),
  ('f2370000-0000-0000-0000-0000000000c3', 'f2370000-0000-0000-0000-0000000000a3', 'gone237', 'Gone', NULL, true, 'here237.test', false, 0, 0);
UPDATE public.profiles SET is_suspended = true, suspended_at = now() WHERE id = 'f2370000-0000-0000-0000-0000000000c3';
INSERT INTO public.profiles (id, username, display_name, bio, is_local, domain, federated_id, followers_count) VALUES
  ('f2370000-0000-0000-0000-0000000000d1', 'bob237', 'Bob', '<p>Remote <a href="https://far237.test">bio</a></p>', false,
   'far237.test', 'https://far237.test/users/bob237', 7);
INSERT INTO public.posts (id, author_id, content, visibility, is_local) VALUES
  ('f2370000-0000-0000-0000-0000000000e1', 'f2370000-0000-0000-0000-0000000000c1',
   '[{"type": "text", "text": "hello from ann"}]', 'public', true);

-- detect_embed_provider ------------------------------------------------------------------
SELECT is(public.detect_embed_provider('https://here237.test/@ann237'), 'harmony-profile', '/@user is an account');
SELECT is(public.detect_embed_provider('https://here237.test/@bob237@far237.test'), 'harmony-profile', '/@user@domain is an account');
SELECT is(public.detect_embed_provider('https://here237.test/social/profile/ann237'), 'harmony-profile', '/social/profile/<name> is an account');
SELECT is(public.detect_embed_provider('https://here237.test/users/ann237'), 'harmony-profile', '/users/<name> is an account');
SELECT is(public.detect_embed_provider('https://here237.test/@ann237/f2370000-0000-0000-0000-0000000000e1'), 'harmony-post', '/@user/<id> is a post');
SELECT is(public.detect_embed_provider('https://here237.test/social/post/f2370000-0000-0000-0000-0000000000e1'), 'harmony-post', '/social/post/<id> is a post');
SELECT is(public.detect_embed_provider('https://here237.test/posts/f2370000-0000-0000-0000-0000000000e1'), 'harmony-post', '/posts/<id> is a post');
SELECT is(public.detect_embed_provider('https://here237.test/@ann237/media'), 'generic', 'another path under an account is neither');
SELECT is(public.detect_embed_provider('https://elsewhere237.test/@ann237'), 'generic', 'an account path on another host is generic');
SELECT is(public.detect_embed_provider('https://har.mony.lol/posts/f2370000-0000-0000-0000-0000000000e1'), 'generic',
  'no host is this instance but its own domain');

-- fetch_link_preview ---------------------------------------------------------------------
CREATE TEMP TABLE p237 AS SELECT
  public.fetch_link_preview('https://here237.test/@ann237') AS ann,
  public.fetch_link_preview('https://here237.test/@bob237@Far237.test') AS bob,
  public.fetch_link_preview('https://here237.test/social/profile/ANN237') AS ann_old,
  public.fetch_link_preview('https://here237.test/@gone237') AS gone,
  public.fetch_link_preview('https://here237.test/@nobody237') AS nobody,
  public.fetch_link_preview('https://here237.test/@ann237/f2370000-0000-0000-0000-0000000000e1') AS post;

SELECT is((SELECT ann ->> 'provider' FROM p237), 'harmony-profile', 'a local account has a profile card');
SELECT is((SELECT ann -> 'profile' ->> 'username' FROM p237), 'ann237', 'naming its username');
SELECT ok((SELECT NOT (ann -> 'profile' ? 'domain') FROM p237), 'and no domain: an account of this instance');
SELECT is((SELECT ann -> 'profile' ->> 'display_name' FROM p237), 'Ann Lumen', 'its display name');
SELECT is((SELECT ann -> 'profile' ->> 'bio' FROM p237), 'Painter of <b>night</b> skies.', 'its bio as stored');
SELECT is((SELECT ann ->> 'description' FROM p237), 'Painter of  night  skies.', 'the description without markup');
SELECT is((SELECT array[ann -> 'profile' ->> 'followers_count', ann -> 'profile' ->> 'following_count', ann -> 'profile' ->> 'posts_count', ann -> 'profile' ->> 'locked'] FROM p237),
  array['12', '3', '1', 'true'], 'its counts and locked flag');
SELECT ok((SELECT NOT (ann -> 'profile' ?| array['email', 'auth_user_id', 'is_suspended', 'discoverable']) FROM p237),
  'no private field in the snapshot');
SELECT is((SELECT array[bob -> 'profile' ->> 'username', bob -> 'profile' ->> 'domain', bob -> 'profile' ->> 'federated_id'] FROM p237),
  array['bob237', 'far237.test', 'https://far237.test/users/bob237'], 'a remote account by /@user@domain, any case of the domain');
SELECT is((SELECT ann_old -> 'profile' ->> 'id' FROM p237), 'f2370000-0000-0000-0000-0000000000c1', 'the earlier address names the same account');
SELECT ok((SELECT gone IS NULL AND nobody IS NULL FROM p237), 'a suspended or unknown account has no card');
SELECT is((SELECT array[post ->> 'provider', post -> 'harmony' ->> 'postId'] FROM p237),
  array['harmony-post', 'f2370000-0000-0000-0000-0000000000e1'], 'a post under its author is a post card');

-- trg_process_local_link_previews -----------------------------------------------------------
INSERT INTO public.messages (id, channel_id, user_id, content)
VALUES ('f2370000-0000-0000-0000-0000000000b1', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        '[{"type": "url", "url": "https://here237.test/@ann237", "preview": true},
          {"type": "url", "url": "https://here237.test/@gone237", "preview": true}]'::jsonb);
SELECT is((SELECT metadata -> 'embeds' -> 'https://here237.test/@ann237' -> 'profile' ->> 'username'
             FROM public.messages WHERE id = 'f2370000-0000-0000-0000-0000000000b1'),
  'ann237', 'a message with the link carries the card');
SELECT ok((SELECT NOT (metadata -> 'embeds' ? 'https://here237.test/@gone237')
             FROM public.messages WHERE id = 'f2370000-0000-0000-0000-0000000000b1'),
  'and none for the suspended account');

SELECT * FROM finish();
ROLLBACK;
