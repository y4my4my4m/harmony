// Who can start a conversation, from another instance: a DM from a stranger to an account whose
// profiles.dm_policy is 'following' is taken and dropped, nothing stored; with the setting at
// 'everyone' the next DM arrives. Once they hold a conversation, tightening the setting stops nothing.

import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

// Fixed so a failure names a row.
const TARGET = 'fed00247-0000-0000-0000-000000000001'
const TARGET_AUTH = 'fed0a000-0000-0000-0000-000000000247' // auth-user-shim.sql
const TARGET_NAME = 'fx_dmpolicy'

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>

export interface DmPolicyContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  post: Post
  signedHeaders: Sign
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseDmPolicy(ctx: DmPolicyContext): Promise<void> {
  console.log('\nremote DM -> the recipient\'s setting decides whether a stranger reaches them')
  const { db, peer, localUrl, instanceDomain, assert, eq } = ctx

  const made = await db.from('profiles').upsert({
    id: TARGET, auth_user_id: TARGET_AUTH, username: TARGET_NAME, display_name: 'DM policy', is_local: true, domain: instanceDomain,
    federated_id: `https://${instanceDomain}/users/${TARGET_NAME}`, dm_policy: 'following',
  }, { onConflict: 'id' })
  assert(!made.error, 'the recipient exists, limiting who can start a conversation', made.error?.message)

  const send = async (text: string): Promise<string> => {
    const id = `${peer.base}/notes/${crypto.randomUUID()}`
    const to = [`https://${instanceDomain}/users/${TARGET_NAME}`]
    const body = JSON.stringify({
      '@context': AS, id: `${peer.actorUrl}#create-${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl, to, cc: [],
      object: { id, type: 'Note', attributedTo: peer.actorUrl, content: `<p>${text}</p>`, to, cc: [], directMessage: true },
    })
    const target = `${localUrl}/users/${TARGET_NAME}/inbox`
    eq(await deliver(ctx.post, ctx.signedHeaders, target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202, 'the inbox takes the DM')
    return id
  }
  const storedRow = async (apId: string) =>
    (await db.from('messages').select('id').eq('metadata->>ap_id', apId).maybeSingle()).data
  const stored = async (apId: string): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      if (await storedRow(apId)) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  const refused = await send('from a stranger')

  await db.from('profiles').update({ dm_policy: 'everyone' }).eq('id', TARGET)
  const admitted = await send('from a stranger, setting open')
  assert(await stored(admitted), 'with the setting at everyone the DM arrives')
  eq(await storedRow(refused), null, 'the DM refused by the setting was not stored')

  await db.from('profiles').update({ dm_policy: 'following' }).eq('id', TARGET)
  const continued = await send('in the conversation they hold')
  assert(await stored(continued), 'tightening the setting leaves a conversation they already hold')

  await db.from('profiles').delete().eq('id', TARGET)
}
