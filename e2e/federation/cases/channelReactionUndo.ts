// Removing a reaction on a hosted server's message reaches the member instances as the same
// reaction: the Undo names the Like by the id it went out under, with its content and Emoji
// tag, so the receiver (ActivityProcessor.removeMessageReactions) finds the row by emoji.
//
//   - a custom emoji reaction: Like id .../reactions/<row id> with an Emoji tag; its Undo
//     carries the same id, content and tag;
//   - a unicode reaction: its Undo carries that emoji, not the heart.

import type { SupabaseClient } from '@supabase/supabase-js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Fixed so a failure names a row.
const MESSAGE = 'fed00243-0000-0000-0000-000000000001'
const EMOJI = 'fed00243-0000-0000-0000-0000000000e1'

interface Captured { method: string; url: string; raw: Buffer }

export interface ChannelReactionUndoContext {
  db: SupabaseClient
  peer: { captured: Captured[] }
  instanceDomain: string
  backendRoot: string
  ids: { alice: string; hostedServer: string; hostedChannel: string }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseChannelReactionUndo(ctx: ChannelReactionUndoContext): Promise<void> {
  console.log('\nchannel reaction removal -> the Undo names the reaction it removes')
  const { db, peer, instanceDomain, backendRoot, ids, assert, eq } = ctx
  const { handleChannelReactionJob } = await import(
    pathToFileURL(path.join(backendRoot, 'src', 'queue/handlers/channelReactionHandler.ts')).href
  )
  const emojiUrl = `https://${instanceDomain}/storage/v1/object/public/emojis/${ids.hostedServer}/rip.gif`

  await db.from('messages').delete().eq('id', MESSAGE)
  await db.from('emojis').delete().eq('id', EMOJI)
  const seeded = await db.from('messages').insert({
    id: MESSAGE, channel_id: ids.hostedChannel, user_id: ids.alice, content: [{ type: 'text', text: 'react to me' }],
  })
  assert(!seeded.error, 'seed the reacted message', seeded.error?.message)
  const emoji = await db.from('emojis').insert({
    id: EMOJI, name: 'rip', url: emojiUrl, server_id: ids.hostedServer, uploader: ids.alice, scope: 'server',
  })
  assert(!emoji.error, 'seed the server emoji', emoji.error?.message)

  const sent = (since: number) => peer.captured.slice(since).map((c) => JSON.parse(c.raw.toString('utf8')))

  const roundTrip = async (row: { emoji_id?: string; custom_emoji_content?: string }) => {
    const inserted = await db.from('reactions').insert({ message_id: MESSAGE, user_id: ids.alice, ...row }).select('id').single()
    assert(!inserted.error && inserted.data, 'insert the reaction', inserted.error?.message)
    const reactionId = inserted.data!.id as string
    const before = peer.captured.length
    await handleChannelReactionJob({ type: 'create', reaction_id: reactionId, message_id: MESSAGE, user_id: ids.alice, emoji_id: row.emoji_id })
    const like = sent(before).find((a) => a.type === 'Like')
    const removed = await db.from('reactions').delete().eq('id', reactionId)
    assert(!removed.error, 'delete the reaction', removed.error?.message)
    const mid = peer.captured.length
    await handleChannelReactionJob({
      type: 'delete', reaction_id: reactionId, message_id: MESSAGE, user_id: ids.alice,
      emoji_id: row.emoji_id ?? null, custom_emoji_content: row.custom_emoji_content ?? null,
    })
    const undo = sent(mid).find((a) => a.type === 'Undo')
    return { reactionId, like, undo }
  }

  const custom = await roundTrip({ emoji_id: EMOJI })
  assert(custom.like, 'the custom reaction reaches the member instance')
  eq(custom.like?.id?.endsWith(`/reactions/${custom.reactionId}`), true, 'its Like id names the reaction row')
  eq(custom.like?.tag?.[0]?.icon?.url, emojiUrl, 'with the Emoji tag of its image')
  eq(custom.like?.tag?.[0]?.icon?.mediaType, 'image/gif', 'typed by the file extension')
  assert(custom.undo, 'its removal reaches the member instance')
  eq(custom.undo?.object?.id, custom.like?.id, 'the Undo names the Like it removes')
  eq(custom.undo?.object?.content, custom.like?.content, 'with the same content')
  eq(custom.undo?.object?.tag?.[0]?.icon?.url, emojiUrl, 'and the same Emoji tag')

  const unicode = await roundTrip({ custom_emoji_content: '🎉' })
  assert(unicode.undo, 'a unicode reaction removal reaches the member instance')
  eq(unicode.undo?.object?.content, '🎉', 'naming that emoji, not the heart')
  eq(unicode.undo?.object?.id, unicode.like?.id, 'under the id its Like went out with')

  await db.from('messages').delete().eq('id', MESSAGE)
  await db.from('emojis').delete().eq('id', EMOJI)
}
