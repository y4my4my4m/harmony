// A remote Delete of a DM leaves the recipient's conversation list preview: the stored row keeps
// its content with is_deleted set, and get_user_conversations answers the message before it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

// Fixed so a failure names a row.
const TARGET = 'fed00305-0000-0000-0000-000000000001'
const TARGET_AUTH = 'fed0a000-0000-0000-0000-000000000305' // auth-user-shim.sql
const TARGET_NAME = 'fx_dmdelete'

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>

export interface DmDeletePreviewContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  post: Post
  signedHeaders: Sign
  asUser: (authUserId: string) => SupabaseClient
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseDmDeletePreview(ctx: DmDeletePreviewContext): Promise<void> {
  console.log('\nremote DM Delete -> the recipient\'s conversation preview is the message before it')
  const { db, peer, localUrl, instanceDomain, assert, eq } = ctx

  const made = await db.from('profiles').upsert({
    id: TARGET, auth_user_id: TARGET_AUTH, username: TARGET_NAME, display_name: 'DM delete', is_local: true, domain: instanceDomain,
    federated_id: `https://${instanceDomain}/users/${TARGET_NAME}`, dm_policy: 'everyone',
  }, { onConflict: 'id' })
  assert(!made.error, 'the recipient exists', made.error?.message)

  const to = [`https://${instanceDomain}/users/${TARGET_NAME}`]
  const inbox = `${localUrl}/users/${TARGET_NAME}/inbox`
  const keyId = `${peer.actorUrl}#main-key`
  const send = async (text: string): Promise<string> => {
    const id = `${peer.base}/notes/${crypto.randomUUID()}`
    const body = JSON.stringify({
      '@context': AS, id: `${peer.actorUrl}#create-${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl, to, cc: [],
      object: { id, type: 'Note', attributedTo: peer.actorUrl, content: `<p>${text}</p>`, to, cc: [], directMessage: true },
    })
    eq(await deliver(ctx.post, ctx.signedHeaders, inbox, body, peer.key.privateKey, keyId), 202, `the inbox takes "${text}"`)
    return id
  }
  const row = async (apId: string, deleted: boolean) => {
    for (let i = 0; i < 40; i++) {
      const { data } = await db.from('messages').select('id, conversation_id, is_deleted, content')
        .eq('metadata->>ap_id', apId).maybeSingle()
      if (data && (data.is_deleted === true) === deleted) return data
      await new Promise((r) => setTimeout(r, 200))
    }
    return null
  }
  const preview = async (conversationId: string) => {
    const { data, error } = await ctx.asUser(TARGET_AUTH).rpc('get_user_conversations')
    assert(!error, 'get_user_conversations answers the recipient', error?.message)
    return (data as any[] | null)?.find((c) => c.conversation_id === conversationId)?.last_message ?? null
  }

  const first = await row(await send('kept message'), false)
  const secondId = await send('deleted message')
  const second = await row(secondId, false)
  assert(first && second, 'both DMs arrive')
  if (!first || !second) return
  eq((await preview(second.conversation_id))?.id, second.id, 'the newer DM is the preview')

  const del = JSON.stringify({
    '@context': AS, id: `${secondId}#delete`, type: 'Delete', actor: peer.actorUrl, to, object: { id: secondId, type: 'Tombstone' },
  })
  eq(await deliver(ctx.post, ctx.signedHeaders, inbox, del, peer.key.privateKey, keyId), 202, 'the inbox takes the Delete')
  const gone = await row(secondId, true)
  assert(gone, 'the deleted DM is marked deleted')
  assert(JSON.stringify(gone?.content).includes('deleted message'), 'with its content kept', gone?.content)

  const shown = await preview(second.conversation_id)
  eq(shown?.id, first.id, 'the preview is the DM before it')
  assert(!JSON.stringify(shown?.content ?? '').includes('deleted message'), 'and holds none of the deleted text', shown)

  await db.from('conversations').delete().eq('id', second.conversation_id)
  await db.from('profiles').delete().eq('id', TARGET)
}
