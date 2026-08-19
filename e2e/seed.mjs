// Builds the E2E fixture on a stack raised by e2e/stack.sh.
//
// Users come from GoTrue's admin API so they own a real password and can sign
// in; the rest of the graph goes in over PostgREST as service_role, which
// carries BYPASSRLS. Ids are fixed so assertions can name a row.
//
//   alice    owns the server, member, DM participant
//   bob      member of the server, DM participant
//   mallory  member of nothing - the deny actor
//
// Profile ids differ from auth user ids on purpose: RLS resolves a caller
// through profiles.auth_user_id = auth.uid(), and equal ids would hide a
// policy that joined on the wrong column.
//
// Usernames carry an fx_ prefix. tests/e2e/global-setup.ts claims e2e_alice
// and e2e_bob and deletes whatever profile already holds those names.

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, 'stack.env'), quiet: true })

const URL_ = requireEnv('E2E_SUPABASE_URL')
const SERVICE_KEY = requireEnv('E2E_SUPABASE_SERVICE_ROLE_KEY')

const PASSWORD = 'e2e-password-12345'

const USERS = [
  {
    key: 'alice',
    email: 'fx_alice@e2e.harmony.local',
    username: 'fx_alice',
    displayName: 'Alice E2E',
    profileId: 'e2e00000-0000-0000-0000-000000000001',
  },
  {
    key: 'bob',
    email: 'fx_bob@e2e.harmony.local',
    username: 'fx_bob',
    displayName: 'Bob E2E',
    profileId: 'e2e00000-0000-0000-0000-000000000002',
  },
  {
    key: 'mallory',
    email: 'fx_mallory@e2e.harmony.local',
    username: 'fx_mallory',
    displayName: 'Mallory E2E',
    profileId: 'e2e00000-0000-0000-0000-000000000003',
  },
]

const SERVER_ID = 'e2e00000-0000-0000-0000-000000000010'
const CONVERSATION_ID = 'e2e00000-0000-0000-0000-000000000020'
const CHANNEL_MESSAGE_ID = 'e2e00000-0000-0000-0000-000000000030'
const DM_MESSAGE_ID = 'e2e00000-0000-0000-0000-000000000031'

function requireEnv(key) {
  const v = process.env[key]
  if (!v) throw new Error(`${key} missing from e2e/stack.env - run: npm run e2e:up`)
  return v
}

function check(label, { error }) {
  if (error) throw new Error(`${label}: ${error.message}${error.details ? ` (${error.details})` : ''}`)
}

const admin = createClient(URL_, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function recreateAuthUser(user) {
  // GoTrue rejects a duplicate email; a re-seed against a live stack must
  // clear the old row first.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (listErr) throw new Error(`listUsers: ${listErr.message}`)
  const existing = list.users.find((u) => u.email === user.email)
  if (existing) {
    const { error } = await admin.auth.admin.deleteUser(existing.id)
    if (error) throw new Error(`deleteUser ${user.email}: ${error.message}`)
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !data?.user) throw new Error(`createUser ${user.email}: ${error?.message}`)
  return data.user.id
}

async function main() {
  const seeded = {}

  for (const user of USERS) {
    const authId = await recreateAuthUser(user)
    seeded[user.key] = { ...user, authId, password: PASSWORD }
    console.log(`  auth user ${user.username} -> ${authId}`)
  }

  check(
    'profiles',
    await admin.from('profiles').upsert(
      USERS.map((u) => ({
        id: u.profileId,
        auth_user_id: seeded[u.key].authId,
        username: u.username,
        display_name: u.displayName,
        is_local: true,
      })),
      { onConflict: 'id' },
    ),
  )
  console.log(`  profiles: ${USERS.map((u) => u.username).join(', ')}`)

  check(
    'servers',
    await admin
      .from('servers')
      .upsert({ id: SERVER_ID, name: 'E2E Server', owner: seeded.alice.profileId }, { onConflict: 'id' }),
  )

  // An AFTER INSERT trigger builds the default channel set; use what it made
  // rather than adding a second channel beside it.
  const { data: channels, error: chErr } = await admin
    .from('channels')
    .select('id, name')
    .eq('server_id', SERVER_ID)
    .order('name')
  if (chErr) throw new Error(`channels: ${chErr.message}`)
  if (!channels?.length) throw new Error('server insert produced no channels')
  const channel = channels.find((c) => c.name === 'general') ?? channels[0]
  console.log(`  server ${SERVER_ID} channel ${channel.name} ${channel.id}`)

  check(
    'user_servers',
    await admin.from('user_servers').upsert(
      [
        { user_id: seeded.alice.profileId, server_id: SERVER_ID, status: 'accepted' },
        { user_id: seeded.bob.profileId, server_id: SERVER_ID, status: 'accepted' },
      ],
      { onConflict: 'user_id,server_id' },
    ),
  )

  check(
    'conversations',
    await admin
      .from('conversations')
      .upsert(
        { id: CONVERSATION_ID, type: 'direct', created_by: seeded.alice.profileId },
        { onConflict: 'id' },
      ),
  )

  check(
    'conversation_participants',
    await admin.from('conversation_participants').upsert(
      [
        { conversation_id: CONVERSATION_ID, user_id: seeded.alice.profileId },
        { conversation_id: CONVERSATION_ID, user_id: seeded.bob.profileId },
      ],
      { onConflict: 'conversation_id,user_id' },
    ),
  )

  check(
    'messages',
    await admin.from('messages').upsert(
      [
        {
          id: CHANNEL_MESSAGE_ID,
          channel_id: channel.id,
          user_id: seeded.alice.profileId,
          content: [{ type: 'text', text: 'channel message from alice' }],
        },
        {
          id: DM_MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          user_id: seeded.alice.profileId,
          content: [{ type: 'text', text: 'dm message from alice' }],
        },
      ],
      { onConflict: 'id' },
    ),
  )

  const fixture = {
    url: URL_,
    users: seeded,
    serverId: SERVER_ID,
    channelId: channel.id,
    conversationId: CONVERSATION_ID,
    channelMessageId: CHANNEL_MESSAGE_ID,
    dmMessageId: DM_MESSAGE_ID,
  }
  fs.writeFileSync(path.resolve(__dirname, 'fixture.json'), JSON.stringify(fixture, null, 2))
  console.log('  wrote e2e/fixture.json')
}

main().catch((e) => {
  console.error(`seed failed: ${e.message}`)
  process.exit(1)
})
