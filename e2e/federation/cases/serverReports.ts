// Reports about a message in a server reach the server's moderators, and their resolution comes
// back, each way (migration 20261027400001, activitypub/flag.ts).
//
// Hosted here (the private server):
//   - the peer's instance actor sends a Flag to the Group inbox naming a message of the server;
//     one report is filed, scoped to the server, owned by the peer's domain, with no reporter;
//     redelivery files nothing more, and a Flag signed by another key is refused;
//   - the server owner resolves it; the job sends the peer's instance actor the Group's Resolve
//     of that Flag, signed with the key the Group publishes;
//   - with the peer's reports ignored (federated_instances.reject_reports), a Flag files nothing.
//
// Hosted by the peer (its Group, fx_bob a member):
//   - fx_bob reports a message there; the job sends the Group's inbox a Flag from this instance's
//     instance actor naming the author and the message, with fx_bob's note and nothing naming him;
//   - a Resolve by another actor settles nothing; the Group's Resolve, signed with its key, records
//     the server's outcome on fx_bob's report, which local staff still decide, and tells him.
//
// The BullMQ worker is not part of this harness: the job handler is called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface ServerReportsContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    instanceActorUrl: string
    key: { privateKey: string }
    instanceKey: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    bobAuth: string
    remote: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
  asUser: (authUserId: string) => SupabaseClient
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseServerReports(ctx: ServerReportsContext): Promise<void> {
  console.log('\nServer reports -> Flag to the Group from the instance actor, the Group\'s Resolve back, each way')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { handleReportJob } = await backend('queue/handlers/reportHandler.ts')
  const peerDomain = new URL(peer.base).hostname.toLowerCase()
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const groupInbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const send = (url: string, body: string, privateKey: string, actor: string) =>
    deliver(ctx.post, ctx.signedHeaders, url, body, privateKey, `${actor}#main-key`)

  // Hosted here.
  const hostedMessage = crypto.randomUUID()
  const seeded = await db.from('messages').insert({
    id: hostedMessage, channel_id: ids.hostedChannel, user_id: ids.alice,
    content: [{ type: 'text', text: 'message the peer reports' }],
  })
  assert(!seeded.error, 'seed a message in the hosted server', seeded.error?.message)
  await db.from('federated_instances').update({ reject_reports: false }).eq('domain', peerDomain)

  const flagId = `${peer.base}/flags/${crypto.randomUUID()}/server`
  const flag = (id: string) => JSON.stringify({
    '@context': [AS, HARMONY],
    id,
    type: 'Flag',
    actor: peer.instanceActorUrl,
    object: [`https://${instanceDomain}/users/fx_alice`, `https://${instanceDomain}/messages/${hostedMessage}`],
    to: [group],
    content: 'Spam in your general channel',
    'harmony:reason': 'spam',
  })
  eq(await send(groupInbox, flag(flagId), peer.instanceKey.privateKey, peer.instanceActorUrl), 202,
    'a Flag from the peer\'s instance actor at the Group inbox is taken (202)')
  const filed = async (id: string) => (await db.from('reports')
    .select('id, reporter_id, reported_user_id, reported_message_id, scope_server_id, source, source_instance, reason, comment, metadata, status')
    .eq('ap_id', id)).data ?? []
  const [report] = await filed(flagId)
  assert(report, 'it files a report')
  if (report) {
    eq(report.scope_server_id, ids.hostedServer, 'scoped to the server, for its moderators')
    eq(report.reported_message_id, hostedMessage, 'naming the message')
    eq(report.reported_user_id, ids.alice, 'and its author')
    eq(report.reporter_id, null, 'with no reporter')
    eq(`${report.source}/${report.source_instance}`, `federation/${peerDomain}`, 'owned by the peer\'s domain')
    eq(`${report.reason}/${report.comment}`, 'spam/Spam in your general channel', 'with the reason and the note')
  }
  eq(await send(groupInbox, flag(flagId), peer.instanceKey.privateKey, peer.instanceActorUrl), 202, 'redelivery is acknowledged (202)')
  eq((await filed(flagId)).length, 1, 'and files no second report')

  const forgedId = `${peer.base}/flags/${crypto.randomUUID()}/server`
  const forged = await ctx.post(groupInbox, ctx.signedHeaders(groupInbox, flag(forgedId), peer.key.privateKey, `${peer.actorUrl}#main-key`), flag(forgedId))
  assert(forged.status === 401 || forged.status === 403, 'a Flag in the instance actor\'s name signed by a user key is refused', forged.status)
  eq((await filed(forgedId)).length, 0, 'and files nothing')

  if (report) {
    const resolved = await ctx.asUser(ids.aliceAuth).rpc('moderate_report', { p_report_id: report.id, p_action: 'resolve' })
    eq((resolved.data as { status?: string } | null)?.status, 'resolved', 'the server owner resolves it')
    const n = peer.captured.length
    await handleReportJob({ type: 'update', target: 'resolution', report_id: report.id })
    const resolve = peer.captured.slice(n).find((c) => JSON.parse(c.raw.toString('utf-8')).type === 'Resolve')
    assert(resolve, 'the job sends the peer a Resolve')
    if (resolve) {
      const body = JSON.parse(resolve.raw.toString('utf-8'))
      eq(resolve.url, new URL(`${peer.instanceActorUrl}/inbox`).pathname, 'to the inbox of the Flag\'s actor')
      eq(body.actor, group, 'from the Group')
      eq(body.object?.id, flagId, 'naming the Flag')
      eq(body['harmony:outcome'], 'resolved', 'as resolved')
      const refusal = await strictReceiverRefusal(resolve, localUrl, instanceDomain)
      assert(refusal === null, 'signed with the key the Group publishes', refusal)
    }
  }

  const ignore = await db.from('federated_instances').upsert({ domain: peerDomain, reject_reports: true }, { onConflict: 'domain' })
  assert(!ignore.error, 'ignore the peer\'s reports', ignore.error?.message)
  const ignoredId = `${peer.base}/flags/${crypto.randomUUID()}/server`
  eq(await send(groupInbox, flag(ignoredId), peer.instanceKey.privateKey, peer.instanceActorUrl), 202, 'a Flag from an ignored domain is acknowledged (202)')
  eq((await filed(ignoredId)).length, 0, 'and files nothing')
  await db.from('federated_instances').update({ reject_reports: false }).eq('domain', peerDomain)

  // Hosted by the peer.
  await db.from('user_servers').upsert(
    { server_id: ids.remoteRef, user_id: ids.bob, status: 'accepted', member_instance: instanceDomain },
    { onConflict: 'user_id,server_id' })
  const peerMessage = crypto.randomUUID()
  const peerMessageUri = `${peer.base}/messages/${peerMessage}`
  const copied = await db.from('messages').insert({
    id: peerMessage, channel_id: ids.remoteChannel, user_id: ids.remote,
    content: [{ type: 'text', text: 'message fx_bob reports' }],
    metadata: { ap_id: peerMessageUri, federated: true, from_domain: peerDomain },
  })
  assert(!copied.error, 'a message of the peer\'s Group is in this instance\'s copy', copied.error?.message)

  const created = await ctx.asUser(ids.bobAuth).rpc('create_report', {
    p_report_type: 'message', p_reported_message_id: peerMessage, p_reason: 'harassment', p_comment: 'note from the reporter',
  })
  const reportId = typeof created.data === 'string' ? created.data : null
  assert(reportId, 'fx_bob reports the message', created.error?.message)
  if (!reportId) return
  const row = async () => (await db.from('reports')
    .select('status, forward_to_server, server_forward_status, server_forwarded_at, server_resolution, resolved_by')
    .eq('id', reportId).single()).data
  eq((await row())?.server_forward_status, 'queued', 'the report is queued for the server\'s moderators by default')

  const n = peer.captured.length
  await handleReportJob({ type: 'create', target: 'server', report_id: reportId })
  const sent = peer.captured.slice(n).find((c) => JSON.parse(c.raw.toString('utf-8')).type === 'Flag')
  assert(sent, 'the job sends a Flag')
  if (sent) {
    const raw = sent.raw.toString('utf-8')
    const body = JSON.parse(raw)
    eq(sent.url, new URL(`${peer.groupUrl}/inbox`).pathname, 'to the Group\'s inbox')
    eq(body.actor, `https://${instanceDomain}/users/instance.actor`, 'from this instance\'s instance actor')
    eq(JSON.stringify(body.object), JSON.stringify([peer.actorUrl, peerMessageUri]), 'naming the author and the message')
    eq(JSON.stringify(body.to), JSON.stringify([peer.groupUrl]), 'addressed to the Group')
    eq(body.content, 'note from the reporter', 'with the reporter\'s note')
    eq(body['harmony:reason'], 'harassment', 'and reason')
    eq(body.id, `https://${instanceDomain}/flags/${reportId}/server`, 'under the report\'s server Flag id')
    assert(!raw.includes('fx_bob') && !raw.includes(ids.bob), 'nothing in it names the reporter', raw)
    const refusal = await strictReceiverRefusal(sent, localUrl, instanceDomain)
    assert(refusal === null, 'signed with the key the instance actor publishes', refusal)
  }
  const after = await row()
  eq(after?.server_forward_status, 'completed', 'the report records the delivery')
  assert(after?.server_forwarded_at, 'server_forwarded_at is set')

  const resolveOf = (actor: string, outcome: string) => JSON.stringify({
    '@context': [AS, HARMONY],
    id: `${actor}/activities/report-${crypto.randomUUID()}`,
    type: 'Resolve',
    actor,
    object: { id: `https://${instanceDomain}/flags/${reportId}/server`, type: 'Flag' },
    to: [`https://${instanceDomain}/users/instance.actor`],
    'harmony:outcome': outcome,
  })
  const inbox = `${localUrl}/inbox`
  eq(await send(inbox, resolveOf(peer.actorUrl, 'dismissed'), peer.key.privateKey, peer.actorUrl), 202,
    'a Resolve by a member of the peer is acknowledged (202)')
  eq((await row())?.status, 'pending', 'and settles nothing: it is not the Group')
  eq(await send(inbox, resolveOf(peer.groupUrl, 'resolved'), peer.key.privateKey, peer.actorUrl), 403,
    'the Group\'s Resolve signed with another key is refused (403)')
  eq((await row())?.status, 'pending', 'and settles nothing')

  await db.from('notifications').delete().eq('user_id', ids.bob).eq('type', 'report_update')
  eq(await send(inbox, resolveOf(peer.groupUrl, 'resolved'), peer.groupKey.privateKey, peer.groupUrl), 202,
    'the Group\'s Resolve signed with its key is taken (202)')
  const settled = await row()
  eq(`${settled?.status}/${settled?.server_resolution}/${settled?.resolved_by}`, 'pending/resolved/null',
    'fx_bob\'s report records the server\'s outcome and stays open for local staff')
  const { data: notices } = await db.from('notifications').select('data')
    .eq('user_id', ids.bob).eq('type', 'report_update')
  eq((notices?.[0]?.data as { resolved_by_server?: string } | undefined)?.resolved_by_server, 'Peer private',
    'and fx_bob is told the server\'s moderators settled it')
}
