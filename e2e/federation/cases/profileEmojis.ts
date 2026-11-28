// A remote account's emoji lists follow its Update(Person) (ActivityProcessor.processUpdate):
//
//   - an Update naming :blobcat: in the name and bio stores both lists, and the public page
//     (public_profile_page) carries the bio's;
//   - an Update of the same account without emojis empties both lists, other keys kept, and the
//     public page carries none.

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

export interface ProfileEmojisContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; personalInbox: string; sharedInbox: string; key: { publicKey: string; privateKey: string } }
  localUrl: string
  ids: { remote: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

async function poll<T>(find: () => Promise<T | null | undefined>, ms = 5000): Promise<T | null | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = await find()
    if (got || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function caseProfileEmojis(ctx: ProfileEmojisContext): Promise<void> {
  console.log('\nremote account Update(Person) -> its emoji lists follow, emptied when it drops them')
  const { db, peer, localUrl, ids, assert, eq } = ctx
  const peerHost = new URL(peer.base).host.toLowerCase()
  const blobcat = `${new URL(peer.base).origin}/emoji/blobcat.png`
  const { data: before } = await db.from('profiles')
    .select('display_name, bio, federation_metadata').eq('id', ids.remote).maybeSingle()

  const update = (person: Record<string, unknown>) => JSON.stringify({
    '@context': AS, id: `${peer.actorUrl}#updates/${crypto.randomUUID()}`, type: 'Update', actor: peer.actorUrl,
    to: [`${AS}#Public`],
    object: {
      id: peer.actorUrl, type: 'Person', preferredUsername: 'fx_remote', inbox: peer.personalInbox,
      endpoints: { sharedInbox: peer.sharedInbox },
      publicKey: { id: `${peer.actorUrl}#main-key`, owner: peer.actorUrl, publicKeyPem: peer.key.publicKey },
      ...person,
    },
  })
  const send = (json: string) =>
    deliver(ctx.post, ctx.signedHeaders, `${localUrl}/inbox`, json, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  const meta = async () => (await db.from('profiles').select('display_name, federation_metadata').eq('id', ids.remote).maybeSingle()).data
  const page = async () => (await db.rpc('public_profile_page', { p_username: 'fx_remote', p_domain: peerHost })).data

  try {
    await db.from('profiles').update({ federation_metadata: { url: `${peer.base}/@fx_remote` } }).eq('id', ids.remote)
    assert(await send(update({
      name: 'Remote :blobcat:', summary: '<p>hi :blobcat:</p>',
      tag: [{ type: 'Emoji', name: ':blobcat:', icon: { type: 'Image', url: blobcat } }],
    })) < 300, 'the inbox takes the account\'s Update')
    const withEmoji = await poll(async () => {
      const row = await meta()
      return Array.isArray(row?.federation_metadata?.bio_emojis) && row.federation_metadata.bio_emojis.length > 0 ? row : null
    })
    eq(withEmoji?.federation_metadata?.bio_emojis?.[0]?.url, blobcat, 'the bio\'s emoji is stored')
    eq(withEmoji?.federation_metadata?.display_name_emojis?.[0]?.url, blobcat, 'and the name\'s')
    eq((await page())?.account?.bio_emojis?.[0]?.url, blobcat, 'the public page carries it')

    assert(await send(update({ name: 'Remote', summary: '<p>hi</p>', tag: [] })) < 300, 'the inbox takes an Update without emojis')
    const without = await poll(async () => {
      const row = await meta()
      return row?.display_name === 'Remote' ? row : null
    })
    eq(JSON.stringify([without?.federation_metadata?.bio_emojis, without?.federation_metadata?.display_name_emojis]), '[[],[]]',
      'both emoji lists are emptied')
    eq(without?.federation_metadata?.url, `${peer.base}/@fx_remote`, 'other keys stay')
    eq(JSON.stringify((await page())?.account?.bio_emojis ?? null), '[]', 'the public page carries no emoji')
  } finally {
    await db.from('profiles').update({
      display_name: before?.display_name ?? 'Remote', bio: before?.bio ?? null, federation_metadata: before?.federation_metadata ?? {},
    }).eq('id', ids.remote)
  }
}
