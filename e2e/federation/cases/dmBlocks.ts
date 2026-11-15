// A block holds against another instance's DMs: while the local recipient blocks the peer's user, a
// DM from it is taken and dropped, nothing stored; after the unblock the next DM arrives in the
// conversation they hold.

import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

// Fixed so a failure names a row.
const TARGET = 'fed00265-0000-0000-0000-000000000001'
const TARGET_AUTH = 'fed0a000-0000-0000-0000-000000000265' // auth-user-shim.sql
const TARGET_NAME = 'fx_dmblocks'

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>

export interface DmBlocksContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  post: Post
  signedHeaders: Sign
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  /** The local mirror of the peer's user. */
  remote: string
}

export async function caseDmBlocks(ctx: DmBlocksContext): Promise<void> {
  console.log('\nremote DM -> a block of the sender stops it, an unblock lets the next one through')
  const { db, peer, localUrl, instanceDomain, assert, eq, remote } = ctx

  const made = await db.from('profiles').upsert({
    id: TARGET, auth_user_id: TARGET_AUTH, username: TARGET_NAME, display_name: 'DM blocks', is_local: true, domain: instanceDomain,
    federated_id: `https://${instanceDomain}/users/${TARGET_NAME}`, dm_policy: 'everyone',
  }, { onConflict: 'id' })
  assert(!made.error, 'the recipient exists', made.error?.message)

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
    (await db.from('messages').select('id, conversation_id').eq('metadata->>ap_id', apId).maybeSingle()).data
  const stored = async (apId: string) => {
    for (let i = 0; i < 40; i++) {
      const row = await storedRow(apId)
      if (row) return row
      await new Promise((r) => setTimeout(r, 200))
    }
    return null
  }

  const before = await stored(await send('before the block'))
  assert(before, 'a DM before the block arrives')

  const blocked = await db.from('user_blocks').insert({ blocker_id: TARGET, blocked_user_id: remote })
  assert(!blocked.error, 'the recipient blocks the peer\'s user', blocked.error?.message)
  const refused = await send('while blocked')

  const unblocked = await db.from('user_blocks').delete().eq('blocker_id', TARGET).eq('blocked_user_id', remote)
  assert(!unblocked.error, 'and unblocks it', unblocked.error?.message)
  const after = await stored(await send('after the unblock'))
  assert(after, 'after the unblock the DM arrives')
  eq(after?.conversation_id, before?.conversation_id, 'in the conversation they hold')
  eq(await storedRow(refused), null, 'the DM sent while blocked was not stored')

  const { data: conversation } = await db.from('conversation_participants').select('conversation_id').eq('user_id', TARGET)
  eq(conversation?.length, 1, 'and the block opened no other conversation')

  if (before?.conversation_id) await db.from('conversations').delete().eq('id', before.conversation_id)
  await db.from('profiles').delete().eq('id', TARGET)
}
