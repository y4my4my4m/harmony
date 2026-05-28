# Testing Guide

## Test Commands

```bash
# Unit tests (no Supabase needed)
npm test

# Watch mode
npm run test:watch

# Integration tests (requires local Supabase running)
npm run test:integration

# Federation backend tests
npm run test:federation

# All tests
npm run test:all
```

## Integration Tests Setup

Integration tests run against your local Supabase instance. They create real
users, test real RLS policies, and verify database functions work correctly.

### Prerequisites

1. **Local Supabase running** -- the self-hosted Supabase stack (docker-compose).

2. **DB port exposed** -- the `supabase-db` container needs port 54322 mapped to
   the host for direct PostgreSQL tests. Add this to your Supabase
   `docker-compose.yml` under the `db` service:

   ```yaml
   db:
     container_name: supabase-db
     # ... existing config ...
     ports:
       - "54322:${POSTGRES_PORT}"
     volumes:
       # ... rest unchanged ...
   ```

   A full reference copy is at `dev/supabase-docker-compose.patch.yml` in this
   repo.

3. **Environment file** -- copy `.env.test.example` to `.env.test` and fill in
   your Supabase keys:

   ```bash
   cp .env.test.example .env.test
   ```

   The default values match the standard Supabase self-hosted defaults. If you
   changed your `POSTGRES_PASSWORD`, `ANON_KEY`, or `SERVICE_ROLE_KEY`, update
   `.env.test` accordingly.

4. **Restart Supabase** after adding the port mapping:

   ```bash
   cd /path/to/your/supabase/docker/checkout
   docker compose down && docker compose up -d
   ```

### What the integration tests cover

- **RLS policies**: Verifies users can only see their own DMs, server channels
  they belong to, and that blocked users' posts are hidden.
- **Notification flow**: Tests `send_notification`, `is_user_viewing_context`,
  and `sync_view_context_from_presence` -- the exact bug where DMs generated
  notifications even when the recipient was actively in the conversation.
- **Conversations**: Tests `create_or_get_direct_conversation` idempotency,
  message permissions, and the block functions.
- **Server permissions**: Tests server ownership, membership, join/leave/ban
  access control.

### Test isolation

- API-level tests create unique test users via Supabase Auth and clean them up
  in `afterAll()`.
- Tests skip gracefully when Supabase is not running (`describe.skipIf`), so
  `npm test` always works even without Supabase.
