# Database Schema Fixes Applied

## Issue
The initial SQL schemas had incorrect references:
1. Using `auth.users(id)` instead of `public.profiles(id)` for foreign keys
2. Comparing `auth.uid()` directly with `profiles.id` (wrong types)
3. Using `servers.owner_id` instead of `servers.owner`
4. Using `public.server_members` instead of `public.user_servers`

## Correct Pattern

### Foreign Key References
```sql
-- ❌ WRONG
user_id UUID REFERENCES auth.users(id)

-- ✅ CORRECT
user_id UUID REFERENCES public.profiles(id)
```

### RLS Policy Checks
```sql
-- ❌ WRONG - Direct comparison with auth.uid()
USING (auth.uid() = user_id)

-- ✅ CORRECT - Join with profiles and check auth_user_id
USING (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE profiles.id = table_name.user_id
        AND profiles.auth_user_id = auth.uid()
    )
)
```

### Server Owner Checks
```sql
-- ❌ WRONG - owner_id doesn't exist
WHERE servers.owner_id = auth.uid()

-- ✅ CORRECT - Use servers.owner with profile join
WHERE EXISTS (
    SELECT 1 FROM public.servers
    JOIN public.profiles ON profiles.id = servers.owner
    WHERE servers.id = some_table.server_id
    AND profiles.auth_user_id = auth.uid()
)
```

### Table Names
```sql
-- ❌ WRONG
FROM public.server_members

-- ✅ CORRECT
FROM public.user_servers
```

## Files Fixed

### 1. `db_schema/e2ee_schema.sql`
- ✅ All foreign keys → `public.profiles(id)`
- ✅ All RLS policies → Join profiles, check `profiles.auth_user_id = auth.uid()`
- ✅ Server encryption settings → Use `servers.owner` with profile join
- ✅ Conversation participants → Profile joins for auth checks

### 2. `db_schema/e2ee_functions.sql`
- ✅ All function authorization → Profile joins with `auth_user_id = auth.uid()`
- ✅ Audit log inserts → Use profile ID lookup: `(SELECT id FROM profiles WHERE auth_user_id = auth.uid())`
- ✅ Session management → Proper profile ID checks
- ✅ Key rotation → Correct auth validation

### 3. `db_schema/bot_api_schema.sql`
- ✅ Bot owner → `public.profiles(id)` foreign key
- ✅ All RLS policies → Profile joins with `auth_user_id = auth.uid()`
- ✅ Server members → Changed from `server_members` to `user_servers`
- ✅ `add_bot_to_server()` → Profile joins for both server owner and bot owner checks

## Key Relationships

```
Supabase Auth User (auth.users)
    ↓ (one-to-one)
    auth.uid() = profiles.auth_user_id
    ↓
Profile (profiles)
    ↓ (primary key)
    profiles.id
    ↓ (used in foreign keys)
    • user_key_pairs.user_id
    • prekeys.user_id
    • encryption_sessions.local_user_id / remote_user_id
    • bots.owner_id
    • servers.owner
    • user_servers.user_id
    • conversation_participants.user_id
```

## Testing Checklist

After applying these schemas:

- [ ] E2EE tables created successfully
- [ ] Bot API tables created successfully
- [ ] RLS policies allow users to manage their own data
- [ ] Server owners can manage server-level settings
- [ ] Bot owners can manage their bots
- [ ] No auth errors when inserting data
- [ ] Profile ID references work correctly

## Common Mistakes to Avoid

1. **Never** use `auth.uid()` directly with `profiles.id` - they're different types
2. **Always** join with profiles when checking auth: `profiles.auth_user_id = auth.uid()`
3. **Remember** `servers.owner` not `servers.owner_id`
4. **Use** `user_servers` not `server_members`
5. **For functions**, get profile ID: `(SELECT id FROM profiles WHERE auth_user_id = auth.uid())`

## All Fixed! ✅

All three SQL files are now corrected and should run without errors.

