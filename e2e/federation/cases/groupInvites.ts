// Group invites from another instance: the first makes the group's copy here, and one for a person
// added there later adds them to that copy, where they read what was sent before. Each person added
// gets one notice, with the group's name. A message naming a person adds nobody, an invite for a
// participant tells them nothing, and one for a person who blocks the inviter is dropped.

import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const GROUP_NAME = 'Weekend trip'

// Fixed so a failure names a row; auth users in auth-user-shim.sql.
const people = (['one', 'two', 'three'] as const).map((name, i) => ({
  id: `fed00390-0000-0000-0000-00000000000${i + 1}`, auth: `fed0a000-0000-0000-0000-00000000039${i}`, name: `fx_ginvite_${name}`,
}))

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>

export interface GroupInvitesContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  post: Post
  signedHeaders: Sign
  asUser: (authUserId: string) => SupabaseClient
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  /** The local mirror of the peer's user. */
  remote: string
}

export async function caseGroupInvites(ctx: GroupInvitesContext): Promise<void> {
  console.log('\nremote group invite -> the person it names joins the group\'s copy and reads it')
  const { db, peer, localUrl, instanceDomain, assert, eq, remote } = ctx
  const [one, two, three] = people

  const made = await db.from('profiles').upsert(people.map((p) => ({
    id: p.id, auth_user_id: p.auth, username: p.name, display_name: p.name, is_local: true, domain: instanceDomain,
    federated_id: `https://${instanceDomain}/users/${p.name}`, dm_policy: 'everyone',
  })), { onConflict: 'id' })
  assert(!made.error, 'the recipients exist', made.error?.message)

  const group = crypto.randomUUID()
  const together = crypto.randomUUID()
  const url = (p: { name: string }) => `https://${instanceDomain}/users/${p.name}`
  const send = async (activity: { id: string; object: Record<string, unknown> }, to: typeof people, what: string) => {
    const addressed = to.map(url)
    const body = JSON.stringify({
      '@context': AS, type: 'Create', actor: peer.actorUrl, to: addressed, cc: [], ...activity,
      object: { type: 'Note', attributedTo: peer.actorUrl, published: new Date().toISOString(), to: addressed, cc: [], directMessage: true, ...activity.object },
    })
    eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/users/${to[0].name}/inbox`, body, peer.key.privateKey, `${peer.actorUrl}#main-key`),
      202, `the inbox takes ${what}`)
  }
  // As groupInviteHandler.ts sends it.
  const invite = (p: typeof one, again = '', to = group) => send({
    id: `${peer.base}/group-invites/${to}/${p.id}${again}#activity`,
    object: {
      id: `${peer.base}/group-invites/${to}/${p.id}${again}`, content: `<p>You were added to ${GROUP_NAME}.</p>`,
      metadata: { type: 'group_invite', conversation_id: to, inviter_id: crypto.randomUUID(), conversation_name: GROUP_NAME },
    },
  }, [p], `the invite of ${p.name}${again}`)
  const message = async (text: string, to: typeof people) => {
    const id = `${peer.base}/notes/${crypto.randomUUID()}`
    await send({
      id: `${peer.actorUrl}#create-${crypto.randomUUID()}`,
      object: { id, content: `<p>${text}</p>`, 'harmony:conversationType': 'group', 'harmony:conversationId': group },
    }, to, `"${text}"`)
    return until(async () => (await db.from('messages').select('id, conversation_id').eq('metadata->>ap_id', id).maybeSingle()).data)
  }
  const until = async <T>(read: () => Promise<T | null | undefined | false>): Promise<T | null> => {
    for (let i = 0; i < 40; i++) {
      const value = await read()
      if (value) return value
      await new Promise((r) => setTimeout(r, 200))
    }
    return null
  }
  const copies = async (of = group) => (await db.from('conversations').select('id').eq('metadata->>remote_conversation_id', of)).data ?? []
  const inside = async (of = group) => {
    const [copy] = await copies(of)
    const { data } = await db.from('conversation_participants').select('user_id').eq('conversation_id', copy?.id ?? of).is('left_at', null)
    return (data ?? []).map((row) => row.user_id as string)
  }
  const joined = (p: typeof one) => until(async () => (await inside()).includes(p.id))
  const notices = async (p: typeof one) => {
    const { data } = await db.from('notifications').select('data').eq('user_id', p.id).eq('type', 'dm').eq('data->>is_invite', 'true')
    return (data ?? []).map((row) => ({ name: row.data?.conversation?.name, preview: row.data?.preview, from: row.data?.sender?.user_id }))
  }
  const notice = { name: GROUP_NAME, preview: `You were added to ${GROUP_NAME}`, from: remote }

  try {
    await invite(one)
    assert(await joined(one), 'the first invite makes the copy, with the person it names')
    assert(await until(async () => (await notices(one)).length > 0), 'who is told')
    const before = await message('before the second invite', [one])
    assert(before, 'a message in the group arrives')
    eq(before?.conversation_id, (await copies())[0]?.id, 'in that copy')

    await invite(two)
    assert(await joined(two), 'an invite for a person added later adds them to the copy')
    assert(await until(async () => (await notices(two)).length > 0), 'who is told')
    const read = await ctx.asUser(two.auth).from('messages').select('id').eq('conversation_id', before!.conversation_id)
    eq((read.data ?? []).map((m) => m.id).join(), before?.id, 'and reads what was sent before')

    const after = await message('naming a third person', [one, two, three])
    eq(after?.conversation_id, before?.conversation_id, 'a message naming a third person arrives in the copy')
    await invite(two, '-again')
    const last = await message('after the repeated invite', [one, two])
    assert(last, 'a message after a repeated invite arrives')
    eq((await inside()).sort().join(), [one.id, two.id, remote].sort().join(), 'neither added anybody')

    const blocked = await db.from('user_blocks').insert({ blocker_id: three.id, blocked_user_id: remote })
    assert(!blocked.error, 'the third person blocks the inviter', blocked.error?.message)
    await invite(three)
    const unblocked = await db.from('user_blocks').delete().eq('blocker_id', three.id).eq('blocked_user_id', remote)
    assert(!unblocked.error, 'and unblocks', unblocked.error?.message)
    eq((await inside()).includes(three.id), false, 'the invite sent while blocked added nobody')
    eq((await notices(three)).length, 0, 'and told nobody')
    await invite(three, '-unblocked')
    assert(await joined(three), 'the next one adds them')
    assert(await until(async () => (await notices(three)).length > 0), 'and tells them')

    for (const p of people) eq(JSON.stringify(await notices(p)), JSON.stringify([notice]), `${p.name} got one notice, with the group's name and the inviter`)
    eq((await copies()).length, 1, 'the group has one copy here')

    await Promise.all(people.map((p) => invite(p, '', together)))
    assert(await until(async () => (await copies(together)).length > 0 && (await inside(together)).length === 4), 'invites sent at once for a new group put everyone in it')
    eq((await copies(together)).length, 1, 'in one copy')
  } finally {
    for (const of of [group, together]) for (const copy of await copies(of)) await db.from('conversations').delete().eq('id', copy.id)
    await db.from('profiles').delete().in('id', people.map((p) => p.id))
  }
}
