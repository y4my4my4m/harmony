# Reconciling init/ and migrations/

23 functions have genuinely different bodies between a fresh `init/` build and
the same database with all migrations applied. Production runs whatever the last
migration left, so a difference means the two are running different code and one
of them is wrong.

The direction is not uniform. The first entry examined, `is_author_suspended`, looked like production running a
weaker body and turned out to be two spellings of the same behaviour — the
difference was redundant, not wrong. Assume nothing about direction; the test
decides. See `REFACTOR.md`.

Each entry needs, in order:

1. intended behaviour decided against the calling code
2. a pgTAP assertion covering that behaviour
3. a reconciliation migration carrying the chosen body to production
4. `init/` updated to match

The drift gate stays red until all 23 are done. That is intentional: it is the
reminder.

## Order

Security first, because production is measurably running the weaker body in at
least one case and the same may hold elsewhere. Maintenance last. The two
superseded entries are revoke candidates, not reconciliations.

| done | function | class | note |
|---|---|---|---|
| [ ] | `approve_device_request` | likely-equivalent | only spacing around `=`; canonicaliser does not fold that yet |
| [ ] | `broadcast_emoji_change` | REAL | migration adds EXCEPTION WHEN OTHERS THEN RETURN COALESCE(NEW,OLD); init lets a realtime.send failure abort the emoji change |
| [ ] | `broadcast_profile_change` | REAL | different exception handling and logging |
| [ ] | `cleanup_dead_endpoint_users` | logging-only | init RAISE NOTICE per cleaned user; superseded anyway - revoke candidate |
| [ ] | `deny_device_request` | likely-equivalent | only spacing around `=` |
| [ ] | `disable_federation_triggers` | REAL | init disables the channels triggers too; production's version leaves them enabled |
| [ ] | `enable_federation_triggers` | REAL | mirror of disable_federation_triggers |
| [ ] | `generate_livekit_token` | declaration-only | variable declaration order; superseded - revoke, do not reconcile |
| [ ] | `get_batch_message_reactions` | likely-equivalent | similarity 0.999 |
| [ ] | `get_message_reactions` | likely-equivalent | similarity 1.000 |
| [ ] | `get_unclaimed_session_shares` | likely-equivalent | column alias `as share_id` only; RETURNS TABLE names the columns |
| [ ] | `get_user_permissions` | declaration-only | init declares v_allow_mask/v_deny_mask; confirm they are used |
| [ ] | `handle_group_participant_left` | REAL | migration loads v_leaving_profile and does more |
| [ ] | `handle_local_post_mention_notifications` | REAL | init calls notification_actor_json(); migration inlines jsonb_build_object |
| [ ] | `handle_message_federation` | declaration-only | init declares extra mention variables |
| [ ] | `handle_post_mention_notifications` | REAL | same helper-vs-inline split |
| [ ] | `handle_post_reply_notifications` | REAL | same helper-vs-inline split |
| [ ] | `trigger_queue_thread_federation` | logging-only | RAISE LOG vs RAISE WARNING |
| [ ] | `update_follow_counts` | REAL | migration tracks v_was_accepted/v_is_accepted; handles the accepted->unaccepted transition |
| [ ] | `update_post_reply_count` | likely-equivalent | similarity 1.000 |
| [ ] | `update_trending_posts` | likely-equivalent | column aliases only |
| [x] | `is_author_suspended` | equivalent | no behavioural difference: the outer COALESCE already handles a NULL column. init/ aligned to production's simpler body; behaviour pinned in tests/30 |

### Removed as formatting-only

`get_room_epoch`, `remove_group_icon`, `update_group_icon` and `update_group_name`
left the list once the comparison stopped treating re-wrapped lines as changed
bodies. Their SQL is identical; only the line breaks differ.

## Progress

1 of 22 closed (`is_author_suspended`, equivalent).

The `class` column above is **triage from reading diffs, not proof**. Reading
bodies has produced a wrong conclusion three times in this work, so nothing moves
to `[x]` without a test that fails against the other body.

- **9 likely-equivalent / logging-only / declaration-only.** Expect these to close
  cheaply, but each still needs its assertion.
- **9 REAL.** Behaviour genuinely differs. `disable_federation_triggers` and
  `enable_federation_triggers` are the ones to look at first: `init/` disables the
  `channels` federation triggers and production's version does not, so a
  maintenance window that relies on them still federates channel activity.
- **2 superseded** (`generate_livekit_token`, `cleanup_dead_endpoint_users`):
  revoke rather than reconcile.
