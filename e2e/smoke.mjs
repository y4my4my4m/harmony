// Drives the seeded stack the way the app does: GoTrue password sign-in, then
// PostgREST .from()/.rpc() with the resulting JWT.
//
// Each check names the policy it pins. A deny that comes back as an empty set
// and a deny that comes back as 42501 are different failures, so both shapes
// are asserted separately - an outage returns empty for everyone and would
// otherwise read as RLS working.

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, 'stack.env'), quiet: true })

const URL_ = process.env.E2E_SUPABASE_URL
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixture.json'), 'utf-8'))

let failures = 0
function pass(msg) {
  console.log(`  ok    ${msg}`)
}
function fail(msg, detail) {
  failures += 1
  console.log(`  FAIL  ${msg}`)
  if (detail !== undefined) console.log(`        ${detail}`)
}
function assert(cond, msg, detail) {
  cond ? pass(msg) : fail(msg, detail)
}

function client() {
  return createClient(URL_, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// Payload segment of a JWS Compact Serialization token: base64url, no padding.
function claims(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8'))
}

async function signIn(user) {
  const c = client()
  const { data, error } = await c.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error || !data.session) throw new Error(`sign-in ${user.username}: ${error?.message}`)
  return { client: c, session: data.session }
}

async function main() {
  const { alice, bob, mallory } = fixture.users

  console.log('GoTrue sign-in')
  const bobAuth = await signIn(bob)
  const bobClaims = claims(bobAuth.session.access_token)
  console.log(`  bob claims: ${JSON.stringify({
    sub: bobClaims.sub,
    role: bobClaims.role,
    aud: bobClaims.aud,
    email: bobClaims.email,
  })}`)
  assert(bobClaims.sub === bob.authId, 'sub claim is the auth user id', `${bobClaims.sub} != ${bob.authId}`)
  assert(bobClaims.role === 'authenticated', 'role claim is authenticated', bobClaims.role)

  const malloryAuth = await signIn(mallory)
  pass(`mallory signed in (${claims(malloryAuth.session.access_token).sub})`)

  console.log('\nRLS allow')
  {
    const { data, error } = await bobAuth.client
      .from('messages')
      .select('id, content')
      .eq('channel_id', fixture.channelId)
    if (error) fail('bob reads the channel he is a member of', error.message)
    else {
      console.log(`  rows: ${JSON.stringify(data)}`)
      assert(
        data.some((m) => m.id === fixture.channelMessageId),
        'bob reads the channel he is a member of (messages_select_channel_member)',
        JSON.stringify(data),
      )
    }
  }
  {
    const { data, error } = await bobAuth.client
      .from('messages')
      .insert({
        channel_id: fixture.channelId,
        user_id: bob.profileId,
        content: [{ type: 'text', text: 'posted by bob during smoke' }],
      })
      .select('id')
    assert(!error && data?.length === 1, 'bob posts to the channel (messages_insert_member)', error?.message)
  }
  {
    const { data, error } = await bobAuth.client.rpc('get_user_conversations')
    if (error) fail('bob lists his conversations (rpc get_user_conversations)', error.message)
    else
      assert(
        Array.isArray(data) && data.length === 1,
        'bob lists his conversations (rpc get_user_conversations)',
        `${data?.length} rows`,
      )
  }

  console.log('\nRLS deny')
  {
    const { data, error } = await malloryAuth.client
      .from('messages')
      .select('id')
      .eq('channel_id', fixture.channelId)
    if (error) fail('mallory reads the channel', error.message)
    else {
      console.log(`  rows: ${JSON.stringify(data)}`)
      assert(data.length === 0, 'mallory sees no message in a server she is not in', JSON.stringify(data))
    }
  }
  {
    const { data, error } = await malloryAuth.client
      .from('messages')
      .insert({
        channel_id: fixture.channelId,
        user_id: mallory.profileId,
        content: [{ type: 'text', text: 'intruder' }],
      })
      .select('id')
    console.log(`  error: ${JSON.stringify(error && { code: error.code, message: error.message })}`)
    assert(
      error?.code === '42501',
      'mallory cannot post to that channel (42501 from messages_insert_member)',
      error ? `code ${error.code}` : `insert succeeded: ${JSON.stringify(data)}`,
    )
  }
  {
    const { data, error } = await malloryAuth.client.rpc('get_user_conversations')
    if (error) fail('mallory lists no conversation', error.message)
    else assert(data.length === 0, "mallory sees none of alice and bob's DM", JSON.stringify(data))
  }
  {
    const { data, error } = await client()
      .from('messages')
      .select('id')
      .eq('channel_id', fixture.channelId)
    // Two acceptable shapes: filtered to nothing, or refused for want of a
    // grant. Any other error is the stack breaking, not a policy holding.
    if (error)
      assert(error.code === '42501', 'anon is refused for want of a grant', `code ${error.code}: ${error.message}`)
    else assert(data.length === 0, 'anon sees no channel message', JSON.stringify(data))
  }

  console.log('\nControl')
  {
    // Same query as the deny above, run by a member. Proves the empty set is
    // the policy and not an empty table.
    const aliceAuth = await signIn(alice)
    const { data, error } = await aliceAuth.client
      .from('messages')
      .select('id')
      .eq('conversation_id', fixture.conversationId)
    if (error) fail('alice reads her DM', error.message)
    else assert(data.length >= 1, 'alice reads her DM (control for the deny above)', JSON.stringify(data))
  }

  console.log('')
  if (failures) {
    console.error(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((e) => {
  console.error(`smoke failed: ${e.message}`)
  process.exit(1)
})
