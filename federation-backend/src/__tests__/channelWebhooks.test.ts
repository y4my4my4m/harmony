import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'crypto'
import express from 'express'
import supertest from 'supertest'

// POST /webhooks/channels/<id>/<token>[/github]: Discord bodies and GitHub deliveries become
// execute_channel_webhook calls carrying the token's SHA-256; limits fail closed.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test', RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX_REQUESTS: 100 },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const redisMock = vi.hoisted(() => ({
  ready: false,
  rateLimit: vi.fn(),
  rateLimitStrict: vi.fn(),
  counterStrict: vi.fn(),
}))
vi.mock('../services/RedisService.js', () => ({ redis: redisMock }))

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ rpc }),
  getSupabaseClientWithAuth: () => { throw new Error('unused') },
}))

const enrich = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../listeners/DatabaseListener.js', () => ({ enrichMessageLinkPreviews: enrich }))

const { default: router } = await import('../routes/webhooks/channelWebhooks.js')
const { parseExecutePayload, flattenEmbeds, unmaskLinks } = await import('../routes/webhooks/channelWebhookPayload.js')
const { formatGithubEvent } = await import('../routes/webhooks/githubEvents.js')

const CHANNEL = '66666666-0000-4000-8000-000000000006'

const app = express()
app.set('trust proxy', ['loopback'])
app.use('/webhooks/channels', router)

let ipSeq = 0
/** A client address of its own, so the failed-auth budget of one test leaves the others alone. */
const freshIp = () => `198.51.100.${++ipSeq}`

function hook() {
  const token = randomBytes(32).toString('hex')
  return { id: randomUUID(), token, hash: createHash('sha256').update(token).digest('hex') }
}

function posted(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: randomUUID(),
      channel_id: randomUUID(),
      created_at: '2026-10-10T00:00:00Z',
      name: 'CI',
      avatar_url: null,
      content: [{ type: 'text', text: 'hi' }],
      ...overrides,
    },
    error: null,
  }
}

function post(path: string, body: unknown, ip = freshIp()) {
  return supertest(app).post(`/webhooks/channels/${path}`).set('X-Real-IP', ip).send(body as object)
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue(posted())
  enrich.mockClear()
  redisMock.ready = false
  redisMock.rateLimitStrict.mockReset()
  redisMock.counterStrict.mockReset()
})

describe('parseExecutePayload', () => {
  it('flattens embeds into text after the content', () => {
    const parsed = parseExecutePayload({
      content: 'Deploy finished',
      username: 'Deployer',
      avatar_url: 'https://cdn.example/d.png',
      embeds: [{
        author: { name: 'ci-bot' },
        title: 'Build #12',
        url: 'https://ci.example/12',
        description: 'All green',
        fields: [{ name: 'Branch', value: 'main', inline: true }, { name: 'Notes', value: 'line one\nline two' }],
        image: { url: 'https://ci.example/badge.png' },
        footer: { text: 'took 42s' },
      }],
    })
    expect(parsed).toEqual({
      ok: true,
      message: {
        content: [
          'Deploy finished',
          '*ci-bot*',
          '**Build #12** <https://ci.example/12>',
          'All green',
          '**Branch**: main',
          '**Notes**',
          'line one\nline two',
          'https://ci.example/badge.png',
          '*took 42s*',
        ].join('\n'),
        username: 'Deployer',
        avatarUrl: 'https://cdn.example/d.png',
        suppressEmbeds: false,
      },
    })
  })

  it('maps flags bit 4 to suppressed embeds and reads payload_json', () => {
    const parsed = parseExecutePayload({ payload_json: JSON.stringify({ content: 'quiet', flags: 4 }) })
    expect(parsed.ok && parsed.message).toMatchObject({ content: 'quiet', suppressEmbeds: true })
    expect(parseExecutePayload({ content: 'x', flags: '4' }).ok && (parseExecutePayload({ content: 'x', flags: '4' }) as any).message.suppressEmbeds).toBe(true)
  })

  it('refuses an empty message and wrong field types', () => {
    expect(parseExecutePayload({ content: '  ', embeds: [] })).toMatchObject({ ok: false, error: { status: 400, body: { code: 50006 } } })
    expect(parseExecutePayload({ content: 42 })).toMatchObject({ ok: false, error: { status: 400, body: { code: 50035 } } })
    expect(parseExecutePayload({ content: 'x', embeds: 'no' })).toMatchObject({ ok: false, error: { status: 400 } })
    expect(parseExecutePayload({ payload_json: '{' })).toMatchObject({ ok: false, error: { status: 400 } })
  })

  it('caps embed text and unmasks links', () => {
    const many = Array.from({ length: 12 }, () => ({ description: 'x'.repeat(1000) }))
    expect(flattenEmbeds(many).length).toBeLessThanOrEqual(6000)
    expect(unmaskLinks('see [the run](https://ci.example/1) or [https://a.example](https://a.example)'))
      .toBe('see the run (<https://ci.example/1>) or <https://a.example>')
  })
})

describe('formatGithubEvent', () => {
  const repo = { full_name: 'octo/app', html_url: 'https://github.com/octo/app', stargazers_count: 3 }
  const sender = { login: 'mona' }

  it('lists at most five commits of a push with the compare link', () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({
      id: `${i}abcdef0123456789`,
      message: `Commit ${i}\n\nbody`,
      author: { name: 'Mona Lisa', username: 'mona' },
    }))
    const text = formatGithubEvent('push', {
      ref: 'refs/heads/main', commits, compare: 'https://github.com/octo/app/compare/a...b', repository: repo, sender,
    })
    expect(text).toBe([
      '**octo/app**: mona pushed 7 commits to `main`',
      '`0abcdef` Commit 0 - mona',
      '`1abcdef` Commit 1 - mona',
      '`2abcdef` Commit 2 - mona',
      '`3abcdef` Commit 3 - mona',
      '`4abcdef` Commit 4 - mona',
      'and 2 more',
      '<https://github.com/octo/app/compare/a...b>',
    ].join('\n'))
  })

  it('formats pull requests, issues, comments, releases, runs, checks, stars and pings', () => {
    const pr = { number: 9, title: 'Add webhooks', html_url: 'https://github.com/octo/app/pull/9', body: 'Adds\nthem', merged: false }
    expect(formatGithubEvent('pull_request', { action: 'opened', pull_request: pr, repository: repo, sender }))
      .toBe('**octo/app**: mona opened pull request #9: Add webhooks\n> Adds them\n<https://github.com/octo/app/pull/9>')
    expect(formatGithubEvent('pull_request', { action: 'closed', pull_request: { ...pr, merged: true }, repository: repo, sender }))
      .toBe('**octo/app**: mona merged pull request #9: Add webhooks\n<https://github.com/octo/app/pull/9>')
    expect(formatGithubEvent('issues', { action: 'opened', issue: { number: 3, title: 'Crash', html_url: 'https://github.com/octo/app/issues/3', body: '' }, repository: repo, sender }))
      .toBe('**octo/app**: mona opened issue #3: Crash\n<https://github.com/octo/app/issues/3>')
    expect(formatGithubEvent('issue_comment', {
      action: 'created', issue: { number: 9, title: 'Add webhooks', pull_request: {} },
      comment: { body: 'LGTM', html_url: 'https://github.com/octo/app/pull/9#c1' }, repository: repo, sender,
    })).toBe('**octo/app**: mona commented on pull request #9: Add webhooks\n> LGTM\n<https://github.com/octo/app/pull/9#c1>')
    expect(formatGithubEvent('release', { action: 'published', release: { tag_name: 'v1.0', name: '', html_url: 'https://github.com/octo/app/releases/v1.0' }, repository: repo, sender }))
      .toBe('**octo/app**: mona published release **v1.0**\n<https://github.com/octo/app/releases/v1.0>')
    expect(formatGithubEvent('workflow_run', { action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure', head_branch: 'main', html_url: 'https://github.com/octo/app/actions/runs/1' }, repository: repo, sender }))
      .toBe('**octo/app**: workflow **CI** failed on `main`\n<https://github.com/octo/app/actions/runs/1>')
    expect(formatGithubEvent('check_run', { action: 'completed', check_run: { name: 'lint', conclusion: 'success', html_url: 'https://github.com/octo/app/runs/2', check_suite: { head_branch: 'dev' } }, repository: repo, sender }))
      .toBe('**octo/app**: check **lint** succeeded on `dev`\n<https://github.com/octo/app/runs/2>')
    expect(formatGithubEvent('star', { action: 'created', repository: repo, sender }))
      .toBe('**octo/app**: mona starred the repository (3 stars)')
    expect(formatGithubEvent('ping', { hook: { events: ['push', 'issues'] }, repository: repo, sender }))
      .toBe('**octo/app**: GitHub webhook connected. Events: push, issues.')
  })

  it('posts nothing for other events and actions', () => {
    expect(formatGithubEvent('pull_request', { action: 'synchronize', pull_request: { number: 1 }, repository: repo, sender })).toBeNull()
    expect(formatGithubEvent('workflow_run', { action: 'requested', workflow_run: { conclusion: null }, repository: repo })).toBeNull()
    expect(formatGithubEvent('star', { action: 'deleted', repository: repo, sender })).toBeNull()
    expect(formatGithubEvent('fork', { repository: repo, sender })).toBeNull()
    expect(formatGithubEvent(undefined, {})).toBeNull()
  })
})

describe('POST /webhooks/channels/:id/:token', () => {
  it('posts the content with the token hash and answers 204', async () => {
    const h = hook()
    const res = await post(`${h.id}/${h.token}`, { content: '@everyone done', username: 'CI', avatar_url: 'https://cdn.example/a.png' })
    expect(res.status).toBe(204)
    expect(rpc).toHaveBeenCalledWith('execute_channel_webhook', {
      p_webhook_id: h.id,
      p_token_hash: h.hash,
      p_content: '@everyone done',
      p_username: 'CI',
      p_avatar_url: 'https://cdn.example/a.png',
      p_suppress_embeds: false,
    })
  })

  it('returns the message with ?wait=true', async () => {
    const h = hook()
    rpc.mockResolvedValueOnce(posted({ id: 'm-1', name: 'Deployer', channel_id: CHANNEL }))
    const res = await post(`${h.id}/${h.token}?wait=true`, { content: 'shipped' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'm-1', channel_id: CHANNEL, webhook_id: h.id, content: 'shipped', author: { username: 'Deployer', bot: true } })
  })

  it('answers an unknown webhook, a wrong token and a malformed token alike', async () => {
    const h = hook()
    rpc.mockResolvedValue({ data: null, error: { message: 'WEBHOOK_UNAUTHORIZED: invalid webhook token', code: '28000' } })
    const unknown = await post(`${randomUUID()}/${h.token}`, { content: 'x' })
    const wrong = await post(`${h.id}/${hook().token}`, { content: 'x' })
    rpc.mockClear()
    const malformed = await post(`${h.id}/not-a-token`, { content: 'x' })
    const badId = await post(`nope/${h.token}`, { content: 'x' })
    for (const res of [unknown, wrong, malformed, badId]) {
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ message: 'Invalid Webhook Token', code: 50027 })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps database refusals', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'WEBHOOK_CHANNEL_ENCRYPTED: this channel is end-to-end encrypted' } })
    let h = hook()
    expect((await post(`${h.id}/${h.token}`, { content: 'x' })).status).toBe(403)

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'WEBHOOK_CONTENT_TOO_LONG: text exceeds the instance limit of 2000 characters' } })
    h = hook()
    const long = await post(`${h.id}/${h.token}`, { content: 'x' })
    expect(long.status).toBe(400)
    expect(long.body.message).toBe('text exceeds the instance limit of 2000 characters')

    rpc.mockResolvedValueOnce({ data: null, error: null })
    h = hook()
    const dropped = await post(`${h.id}/${h.token}`, { content: 'x' })
    expect(dropped.status).toBe(403)
    expect(dropped.body.code).toBe('AUTOMOD_BLOCKED')
  })

  it('refuses an empty message before the database', async () => {
    const h = hook()
    const res = await post(`${h.id}/${h.token}`, { content: '' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(50006)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('takes 64 KiB on the plain route, refuses more, and refuses multipart', async () => {
    const h = hook()
    const res = await post(`${h.id}/${h.token}`, { content: 'x'.repeat(70 * 1024) })
    expect(res.status).toBe(413)
    expect(res.body.code).toBe(40005)

    const multipart = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}`)
      .set('X-Real-IP', freshIp()).field('content', 'hi')
    expect(multipart.status).toBe(415)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reads form-encoded bodies', async () => {
    const h = hook()
    const res = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}`)
      .set('X-Real-IP', freshIp()).type('form').send({ content: 'from curl', flags: '4' })
    expect(res.status).toBe(204)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_content: 'from curl', p_suppress_embeds: true })
  })

  it('enriches link previews unless embeds are suppressed', async () => {
    const parts = [{ type: 'url', url: 'https://example.com', preview: true }]
    rpc.mockResolvedValue(posted({ content: parts }))
    let h = hook()
    await post(`${h.id}/${h.token}`, { content: 'https://example.com' })
    await vi.waitFor(() => expect(enrich).toHaveBeenCalledTimes(1))
    expect(enrich.mock.calls[0][0]).toMatchObject({ content: parts })

    enrich.mockClear()
    h = hook()
    await post(`${h.id}/${h.token}`, { content: 'https://example.com', flags: 4 })
    await new Promise((r) => setTimeout(r, 20))
    expect(enrich).not.toHaveBeenCalled()
  })

  it('answers 405 for other methods and 404 elsewhere', async () => {
    const h = hook()
    expect((await supertest(app).get(`/webhooks/channels/${h.id}/${h.token}`)).status).toBe(405)
    expect((await supertest(app).post('/webhooks/channels/x')).status).toBe(404)
  })
})

describe('POST /webhooks/channels/:id/:token/github', () => {
  const repo = { full_name: 'octo/app', html_url: 'https://github.com/octo/app' }

  it('posts a formatted event', async () => {
    const h = hook()
    const res = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}/github`)
      .set('X-Real-IP', freshIp()).set('X-GitHub-Event', 'star')
      .send({ action: 'created', repository: repo, sender: { login: 'mona' } })
    expect(res.status).toBe(204)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_token_hash: h.hash, p_content: '**octo/app**: mona starred the repository' })
  })

  it('reads the form-encoded payload field', async () => {
    const h = hook()
    const res = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}/github`)
      .set('X-Real-IP', freshIp()).set('X-GitHub-Event', 'ping').type('form')
      .send({ payload: JSON.stringify({ hook: { events: ['push'] }, repository: repo }) })
    expect(res.status).toBe(204)
    expect(rpc.mock.calls[0][1].p_content).toBe('**octo/app**: GitHub webhook connected. Events: push.')
  })

  it('answers an ignored event 204 without the database', async () => {
    const h = hook()
    const res = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}/github`)
      .set('X-Real-IP', freshIp()).set('X-GitHub-Event', 'watch').send({ action: 'started' })
    expect(res.status).toBe(204)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('takes bodies up to 1 MiB', async () => {
    const h = hook()
    const big = { action: 'created', repository: repo, sender: { login: 'mona' }, padding: 'x'.repeat(200 * 1024) }
    const ok = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}/github`)
      .set('X-Real-IP', freshIp()).set('X-GitHub-Event', 'star').send(big)
    expect(ok.status).toBe(204)
    const tooBig = await supertest(app).post(`/webhooks/channels/${h.id}/${h.token}/github`)
      .set('X-Real-IP', freshIp()).set('X-GitHub-Event', 'star').send({ ...big, padding: 'x'.repeat(1100 * 1024) })
    expect(tooBig.status).toBe(413)
  })
})

describe('rate limits', () => {
  it('allows a webhook 5 messages per 2 seconds', async () => {
    const h = hook()
    const ip = freshIp()
    for (let i = 0; i < 5; i++) {
      expect((await post(`${h.id}/${h.token}`, { content: `m${i}` }, ip)).status).toBe(204)
    }
    const limited = await post(`${h.id}/${h.token}`, { content: 'm5' }, ip)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    const other = hook()
    expect((await post(`${other.id}/${other.token}`, { content: 'other' }, ip)).status).toBe(204)
  })

  it("a wrong token does not spend the webhook's budget", async () => {
    const h = hook()
    rpc.mockResolvedValue({ data: null, error: { message: 'WEBHOOK_UNAUTHORIZED: invalid webhook token' } })
    for (let i = 0; i < 6; i++) await post(`${h.id}/${hook().token}`, { content: 'guess' })
    rpc.mockResolvedValue(posted())
    expect((await post(`${h.id}/${h.token}`, { content: 'real' })).status).toBe(204)
  })

  it('bounds a channel across its webhooks once the channel is known', async () => {
    const channel = randomUUID()
    rpc.mockResolvedValue(posted({ channel_id: channel }))
    const first = hook()
    expect((await post(`${first.id}/${first.token}`, { content: 'a' })).status).toBe(204)
    for (let i = 0; i < 9; i++) {
      const h = hook()
      expect((await post(`${h.id}/${h.token}`, { content: `b${i}` })).status).toBe(204)
    }
    rpc.mockClear()
    const res = await post(`${first.id}/${first.token}`, { content: 'c' })
    expect(res.status).toBe(429)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('stops an address after 30 failed authentications', async () => {
    const ip = freshIp()
    rpc.mockResolvedValue({ data: null, error: { message: 'WEBHOOK_UNAUTHORIZED: invalid webhook token' } })
    for (let i = 0; i < 30; i++) {
      const h = hook()
      expect((await post(`${h.id}/${h.token}`, { content: 'x' }, ip)).status).toBe(401)
    }
    rpc.mockReset()
    rpc.mockResolvedValue(posted())
    const h = hook()
    expect((await post(`${h.id}/${h.token}`, { content: 'x' }, ip)).status).toBe(429)
    expect(rpc).not.toHaveBeenCalled()
    expect((await post(`${h.id}/${h.token}`, { content: 'x' })).status).toBe(204)
  })

  it('fails closed when the limiter store cannot count', async () => {
    redisMock.ready = true
    redisMock.counterStrict.mockResolvedValue({ count: 0, resetMs: 0 })
    redisMock.rateLimitStrict.mockRejectedValue(new Error('READONLY'))
    const h = hook()
    const res = await post(`${h.id}/${h.token}`, { content: 'x' })
    expect(res.status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()

    redisMock.counterStrict.mockRejectedValue(new Error('connection lost'))
    expect((await post(`${h.id}/${h.token}`, { content: 'x' })).status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()
  })
})
