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
| [ ] | `approve_device_request` | security | AAL2 device approval; init +342 chars, guards equal |
| [ ] | `deny_device_request` | security | pairs with approve_device_request |
| [ ] | `generate_livekit_token` | superseded | node backend mints tokens; revoke candidate, not reconcile |
| [ ] | `get_user_permissions` | security | permission resolution; init +1450 chars |
| [ ] | `get_unclaimed_session_shares` | security | E2EE key delivery |
| [ ] | `get_room_epoch` | security | megolm epoch |
| [x] | `is_author_suspended` | equivalent | no behavioural difference: the outer COALESCE already handles a NULL column. init/ aligned to production's simpler body; behaviour pinned in tests/30 |
| [ ] | `remove_group_icon` | authz | group icon ownership |
| [ ] | `update_group_icon` | authz | group icon ownership |
| [ ] | `update_group_name` | authz | group name ownership |
| [ ] | `broadcast_emoji_change` | behaviour | guards 1/2 - migration has an extra EXCEPTION handler |
| [ ] | `broadcast_profile_change` | behaviour | fan-out |
| [ ] | `update_follow_counts` | behaviour | guards 8/10 - migration is more defensive |
| [ ] | `handle_message_federation` | behaviour | 8.6KB, 24 guards - largest, review last |
| [ ] | `handle_group_participant_left` | behaviour | migration longer |
| [ ] | `handle_local_post_mention_notifications` | behaviour | migration longer |
| [ ] | `handle_post_mention_notifications` | behaviour | migration longer |
| [ ] | `handle_post_reply_notifications` | behaviour | migration longer |
| [ ] | `trigger_queue_thread_federation` | behaviour | migration longer |
| [ ] | `cleanup_dead_endpoint_users` | maintenance | unreachable; revoke candidate |
| [ ] | `disable_federation_triggers` | maintenance | ops helper |
| [ ] | `enable_federation_triggers` | maintenance | ops helper |
| [ ] | `update_trending_posts` | maintenance | cron-scheduled |

## Progress

1 of 23. `is_author_suspended` closed as equivalent — no migration needed.

Worth noting for the remaining 22: the first candidate that looked like a
production bug was not one. A difference in text is not a difference in
behaviour, and only a test that fails against the other body proves otherwise.
