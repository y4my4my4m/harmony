// The instance's name (utils/instanceName.ts): NodeInfo 2.0 and 2.1 metadata.nodeName, the
// instance actor's name, the invite page's title and og:site_name, the invite and post oEmbed
// provider_name, the Drive link page, /instance-info and /health carry
// instance_config.instance_name, the name the self-host installer stores and the admin panel
// changes. A blank name gives INSTANCE_NAME, else the domain. The actor and NodeInfo are cached
// documents (middleware/documentCache.ts, at most DOCUMENT_CACHE_TTL_MS), the pages hold the name
// for INSTANCE_NAME_TTL_MS; each read starts from empty caches.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type http from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'

type Get = (url: string, headers?: Record<string, string>) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; json: any }>

export interface InstanceNameContext {
  db: SupabaseClient
  localUrl: string
  backendRoot: string
  get: Get
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  ids: { alice: string; pubServer: string }
}

export async function caseInstanceName(ctx: InstanceNameContext): Promise<void> {
  console.log('\ninstance name -> NodeInfo, the instance actor, invite, Drive link and post pages, instance info')
  const { db, localUrl, get, assert, eq, ids } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { default: config } = await backend('config/index.ts')
  const { clearDocumentCache } = await backend('middleware/documentCache.ts')
  const { clearInstanceNameCache } = await backend('utils/instanceName.ts')
  const fallback = String(config.INSTANCE_NAME ?? '').trim() || config.INSTANCE_DOMAIN

  const { data: row } = await db.from('instance_config').select('config_value').eq('config_key', 'instance_name').maybeSingle()
  const was = row?.config_value ?? 'Harmony'
  const setName = async (value: string) => {
    const r = await db.from('instance_config').upsert({ config_key: 'instance_name', config_value: value }, { onConflict: 'config_key' })
    assert(!r.error, `store the instance name ${JSON.stringify(value)}`, r.error?.message)
  }
  const tag = crypto.randomUUID().slice(0, 6).toUpperCase()
  const code = `INM${tag}`
  const postId = crypto.randomUUID()
  const seeded = await db.from('invites').insert({ code, server_id: ids.pubServer, created_by: ids.alice, max_uses: 0 })
  assert(!seeded.error, 'seed a local invite', seeded.error?.message)
  const posted = await db.from('posts').insert({
    id: postId, author_id: ids.alice, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'embed me' }],
  })
  assert(!posted.error, 'seed a public post', posted.error?.message)
  const { data: server } = await db.from('servers').select('name').eq('id', ids.pubServer).single()

  const html = { 'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', Accept: 'text/html' }
  const json = { Accept: 'application/json' }
  const oembed = (url: string) => get(`${localUrl}/oembed?url=${encodeURIComponent(url)}&format=json`, json)
  const title = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1]
  const siteName = (body: string) => /<meta property="og:site_name" content="([^"]*)">/.exec(body)?.[1]
  const seen = async () => {
    clearDocumentCache()
    clearInstanceNameCache()
    const invite = await get(`${localUrl}/invite/${code}`, html)
    const dead = await get(`${localUrl}/invite/INMDEAD${tag}`, html)
    const drive = await get(`${localUrl}/d/${'x'.repeat(16)}${tag}`, html)
    return {
      v20: (await get(`${localUrl}/nodeinfo/2.0`, json)).json?.metadata?.nodeName,
      v21: (await get(`${localUrl}/nodeinfo/2.1`, json)).json?.metadata?.nodeName,
      actor: (await get(`${localUrl}/users/instance.actor`)).json?.name,
      inviteStatus: invite.status,
      inviteTitle: title(invite.body),
      inviteSite: siteName(invite.body),
      deadTitle: title(dead.body),
      driveStatus: drive.status,
      driveTitle: title(drive.body),
      inviteOEmbed: (await oembed(`https://${config.INSTANCE_DOMAIN}/invite/${code}`)).json?.provider_name,
      postOEmbed: (await oembed(`https://${config.INSTANCE_DOMAIN}/posts/${postId}`)).json?.provider_name,
      info: (await get(`${localUrl}/instance-info`, json)).json?.name,
      health: (await get(`${localUrl}/health`, json)).json?.instance?.name,
    }
  }

  const name = `Example Chat ${tag}`
  try {
    await setName(name)
    let got = await seen()
    eq(got.v20, name, 'NodeInfo 2.0 names the instance as stored')
    eq(got.v21, name, 'NodeInfo 2.1 too')
    eq(got.actor, name, 'and so does the instance actor')
    eq(got.inviteStatus, 200, 'the invite page answers')
    eq(got.inviteTitle, `${server?.name} - ${name}`, 'the invite page title names the stored instance name')
    eq(got.inviteSite, name, 'and so does its og:site_name')
    eq(got.deadTitle, `Invite invalid or expired - ${name}`, 'a dead invite\'s page too')
    eq(got.driveStatus, 404, 'an unknown Drive link answers 404')
    eq(got.driveTitle, name, 'with the stored instance name as its title')
    eq(got.inviteOEmbed, name, 'the invite oEmbed provider_name is the stored name')
    eq(got.postOEmbed, name, 'the post oEmbed provider_name too')
    eq(got.info, name, '/instance-info names the instance as stored')
    eq(got.health, name, '/health too')

    await setName('   ')
    got = await seen()
    eq(got.v21, fallback, 'a blank stored name gives INSTANCE_NAME, else the domain, in NodeInfo')
    eq(got.actor, fallback, 'and on the instance actor')
    eq(got.inviteTitle, `${server?.name} - ${fallback}`, 'and in the invite page title')
    eq(got.postOEmbed, fallback, 'and in the post oEmbed')
    eq(got.info, fallback, 'and in /instance-info')
  } finally {
    await setName(was)
    clearInstanceNameCache()
    await db.from('invites').delete().eq('code', code)
    await db.from('posts').delete().eq('id', postId)
  }
}
