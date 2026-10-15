// Channel-resolved permissions on the hosted server's inbox, through the database's
// has_permission with a member override on one channel:
//   - a message uploading a file needs ATTACH_FILES in the channel; a linked GIF does not;
//   - a member's Delete of another's message needs MANAGE_MESSAGES in that message's channel.

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
// server_roles.permissions bits (src/services/RoleService.ts).
const ATTACH_FILES = 1 << 17
const MANAGE_MESSAGES = 1 << 21

// Fixed so a failure names a row.
const TARGET = 'fed00184-0000-0000-0000-000000000001'

export interface ChannelPermissionsContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  ids: { alice: string; remote: string; hostedServer: string; hostedChannel: string; otherChannel: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseChannelPermissions(ctx: ChannelPermissionsContext): Promise<void> {
  console.log('\nhosted server inbox -> ATTACH_FILES and MANAGE_MESSAGES resolved per channel')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const inbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const send = async (activity: Record<string, unknown>) => {
    const body = JSON.stringify({ '@context': AS, id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, actor: peer.actorUrl, ...activity })
    return deliver(ctx.post, ctx.signedHeaders, inbox, body, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  }
  const override = async (channelId: string, allow: number, deny: number) => {
    await db.from('channel_permission_overrides').delete().eq('target_type', 'user').eq('user_id', ids.remote)
    const res = await db.from('channel_permission_overrides').insert({
      channel_id: channelId, target_type: 'user', user_id: ids.remote, allow_permissions: allow, deny_permissions: deny,
    })
    assert(!res.error, `override on ${channelId === ids.hostedChannel ? 'general' : 'the other channel'}`, res.error?.message)
  }
  const create = (label: string, ...parts: Record<string, unknown>[]) => {
    const id = `${peer.base}/messages/${crypto.randomUUID()}`
    return send({
      type: 'Create',
      object: {
        type: 'Note', id, attributedTo: peer.actorUrl, content: `<p>${label}</p>`,
        context: `https://${instanceDomain}/servers/${ids.hostedServer}/channels/${ids.hostedChannel}`,
        'harmony:rawContent': [{ type: 'text', text: label }, ...parts],
      },
    }).then(async (status) => ({
      status,
      stored: !!(await db.from('messages').select('id').eq('metadata->>ap_id', id).maybeSingle()).data,
    }))
  }
  const upload = {
    type: 'file', fileType: 'image', fileName: 'cat.png',
    url: `${peer.base}/api/federation/media/c/${crypto.randomUUID()}/${crypto.randomUUID()}/cat.png?to=${instanceDomain}&sig=x`,
  }
  const gif = { type: 'file', fileType: 'image', url: 'https://static.klipy.com/ii/hmfed/cat.gif' }

  await override(ids.hostedChannel, 0, ATTACH_FILES)
  eq((await create('plain')).stored, true, 'the member\'s plain message is stored')
  eq((await create('upload denied', upload)).stored, false, 'an upload is refused where the channel denies ATTACH_FILES')
  eq((await create('gif', gif)).stored, true, 'a linked GIF is not an upload')
  await override(ids.hostedChannel, ATTACH_FILES, 0)
  eq((await create('upload allowed', upload)).stored, true, 'the upload is stored once the channel allows ATTACH_FILES')

  await db.from('messages').delete().eq('id', TARGET)
  const seeded = await db.from('messages').insert({
    id: TARGET, channel_id: ids.hostedChannel, user_id: ids.alice, content: [{ type: 'text', text: 'alice wrote' }],
    metadata: { ap_id: `https://${instanceDomain}/messages/${TARGET}` },
  })
  assert(!seeded.error, 'seed fx_alice\'s message in general', seeded.error?.message)
  const isDeleted = async () => (await db.from('messages').select('is_deleted').eq('id', TARGET).maybeSingle()).data?.is_deleted === true
  const del = () => send({ type: 'Delete', object: `https://${instanceDomain}/messages/${TARGET}` })

  await override(ids.otherChannel, MANAGE_MESSAGES, 0)
  eq(await del(), 202, 'a Delete by a member with MANAGE_MESSAGES in another channel only is acknowledged (202)')
  eq(await isDeleted(), false, 'and deletes nothing')
  await override(ids.hostedChannel, MANAGE_MESSAGES, 0)
  eq(await del(), 202, 'a Delete by a member with MANAGE_MESSAGES in the message\'s channel is taken (202)')
  eq(await isDeleted(), true, 'fx_alice\'s message is deleted')

  await db.from('channel_permission_overrides').delete().eq('target_type', 'user').eq('user_id', ids.remote)
}
