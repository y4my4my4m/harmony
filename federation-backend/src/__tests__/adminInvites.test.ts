import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// /admin/invites: instance admins invite people by address. GoTrue's admin API makes the
// invited user and its link; the admin_* functions record, list and revoke.

const cfg = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://kong:8000',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  APP_URL: undefined as string | undefined,
  GOTRUE_SMTP_HOST: '',
  GOTRUE_MAILER_OTP_EXP: 86400,
}))
vi.mock('../config/index.js', () => ({ default: cfg, config: cfg }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const allow = vi.hoisted(() => ({ value: true }))
vi.mock('../middleware/rateLimit.js', () => ({
  createStrictKeyedLimit: () => ({
    take: async (res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      if (!allow.value) res.status(429).json({ error: 'Too Many Requests' })
      return allow.value
    },
    tryTake: async () => allow.value,
  }),
}))

const getUser = vi.fn()
const caller = vi.fn()
const advertised = vi.fn()
const rpc = vi.fn()
const generateLink = vi.fn()
const inviteUserByEmail = vi.fn()

function query(result: () => unknown) {
  const chain: Record<string, unknown> = {}
  for (const name of ['select', 'eq']) chain[name] = () => chain
  chain.maybeSingle = async () => result()
  return chain
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClientWithAuth: () => ({ auth: { getUser: () => getUser() } }),
  getSupabaseClient: () => ({
    from: (table: string) => query(() => (table === 'profiles' ? caller() : advertised())),
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { admin: { generateLink: (...a: unknown[]) => generateLink(...a), inviteUserByEmail: (...a: unknown[]) => inviteUserByEmail(...a) } },
  }),
}))

const settings = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => settings(...args))

const { default: router, parseInviteEmail, mailConfigured, linkExpiry } = await import('../routes/adminInvites.js')
const app = express()
app.use(express.json())
app.use('/admin/invites', router)

const ADMIN = { id: 'p-admin', is_admin: true, is_suspended: false }
const USER_ID = '0b0d1d6e-0000-4000-8000-000000000009'
const SENT = '2026-11-05T10:00:00.000Z'
const HASH = 'ab'.repeat(28)
const auth = { Authorization: 'Bearer token' }

function account(over: Record<string, unknown> = {}) {
  return { auth_user_id: USER_ID, email: 'ada@example.org', invited: true, accepted: false, has_profile: false, invite_id: 'i1', revoked: false, ...over }
}

function rpcAnswers(answers: Record<string, unknown>) {
  rpc.mockImplementation(async (name: string) => ({ data: answers[name] ?? null, error: null }))
}

beforeEach(() => {
  for (const fn of [getUser, caller, advertised, rpc, generateLink, inviteUserByEmail, settings]) fn.mockReset()
  allow.value = true
  cfg.GOTRUE_SMTP_HOST = ''
  cfg.APP_URL = undefined
  getUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } }, error: null })
  caller.mockReturnValue({ data: ADMIN, error: null })
  advertised.mockReturnValue({ data: { config_value: false }, error: null })
  settings.mockResolvedValue(new Response(JSON.stringify({ disable_signup: true }), { status: 200 }))
  generateLink.mockResolvedValue({
    data: {
      user: { id: USER_ID, confirmation_sent_at: SENT },
      properties: { action_link: 'https://db.harmony.test/auth/v1/verify?token=t&type=invite', hashed_token: HASH },
    },
    error: null,
  })
  inviteUserByEmail.mockResolvedValue({ data: { user: { id: USER_ID, confirmation_sent_at: SENT } }, error: null })
})

describe('admin invites: who may call', () => {
  it('answers 401 without a token and touches nothing', async () => {
    const res = await supertest(app).get('/admin/invites')
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 401 when GoTrue refuses the token', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'insufficient_aal' } })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(401)
    expect(generateLink).not.toHaveBeenCalled()
  })

  it('answers 403 insufficient_aal to an aal1 token of an admin with a verified factor', async () => {
    const jwt = (aal: string) =>
      `h.${Buffer.from(JSON.stringify({ sub: 'auth-admin', aal })).toString('base64url')}.s`
    getUser.mockResolvedValue({ data: { user: { id: 'auth-admin', factors: [{ status: 'verified' }] } }, error: null })
    const refused = await supertest(app).post('/admin/invites')
      .set({ Authorization: `Bearer ${jwt('aal1')}` }).send({ email: 'ada@example.org' })
    expect([refused.status, refused.body.error]).toEqual([403, 'insufficient_aal'])
    expect(generateLink).not.toHaveBeenCalled()
    const accepted = await supertest(app).get('/admin/invites').set({ Authorization: `Bearer ${jwt('aal2')}` })
    expect(accepted.status).not.toBe(403)
  })

  it.each([
    ['a member', { id: 'p-member', is_admin: false, is_suspended: false }],
    ['a suspended admin', { id: 'p-admin', is_admin: true, is_suspended: true }],
    ['an account without a local profile', null],
  ])('answers 403 to %s on every route', async (_name, profile) => {
    caller.mockReturnValue({ data: profile, error: null })
    const answers = await Promise.all([
      supertest(app).get('/admin/invites').set(auth),
      supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' }),
      supertest(app).post(`/admin/invites/${USER_ID}/link`).set(auth),
      supertest(app).delete(`/admin/invites/${USER_ID}`).set(auth),
    ])
    expect(answers.map((r) => [r.status, r.body.error])).toEqual(Array(4).fill([403, 'admin_required']))
    expect(rpc).not.toHaveBeenCalled()
    expect(generateLink).not.toHaveBeenCalled()
    expect(inviteUserByEmail).not.toHaveBeenCalled()
  })

  it('stops at the rate limit before any work', async () => {
    allow.value = false
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(429)
    expect(rpc).not.toHaveBeenCalled()
    expect(generateLink).not.toHaveBeenCalled()
  })
})

describe('admin invites: listing', () => {
  it('returns the registration mode, email delivery, link lifetime and invitations with their expiry', async () => {
    rpcAnswers({
      admin_instance_invites: [
        { id: 'i1', email: 'ada@example.org', auth_user_id: USER_ID, status: 'pending', link_sent_at: SENT, source: 'admin', delivery: 'link' },
        { id: 'i2', email: 'old@example.org', auth_user_id: 'u2', status: 'pending', link_sent_at: '2020-01-01T00:00:00.000Z', source: 'cli', delivery: 'link' },
        { id: 'i3', email: 'joined@example.org', auth_user_id: 'u3', status: 'accepted', link_sent_at: SENT, source: 'admin', delivery: 'email' },
      ],
    })
    const res = await supertest(app).get('/admin/invites').set(auth)
    expect(res.status).toBe(200)
    expect(res.body.registration).toEqual({ signup: 'closed', advertised_open: false })
    expect(res.body.email_available).toBe(false)
    expect(res.body.link_lifetime_seconds).toBe(86400)
    expect(rpc).toHaveBeenCalledWith('admin_instance_invites', { p_limit: 200 })
    const [fresh, old, joined] = res.body.invites
    expect(fresh.expires_at).toBe('2026-11-06T10:00:00.000Z')
    expect(old.expired).toBe(true)
    expect(joined.expires_at).toBeNull()
    expect(settings.mock.calls[0][0]).toBe('http://kong:8000/auth/v1/settings')
  })

  it('reports an unknown sign-up mode when GoTrue does not answer', async () => {
    settings.mockRejectedValue(new Error('down'))
    rpcAnswers({ admin_instance_invites: [] })
    const res = await supertest(app).get('/admin/invites').set(auth)
    expect(res.body.registration.signup).toBe('unknown')
  })
})

describe('admin invites: creating', () => {
  it.each([undefined, '', 'not an address', 'a@b', `${'x'.repeat(250)}@example.org`, 'a b@example.org', 42])(
    'refuses %j as an address without calling GoTrue', async (email) => {
      const res = await supertest(app).post('/admin/invites').set(auth).send({ email })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_email')
      expect(generateLink).not.toHaveBeenCalled()
    })

  it('makes a single-use link to /reset-password naming the token, not GoTrue\'s /verify link, and records it', async () => {
    rpcAnswers({ admin_instance_invite_account: [], admin_record_instance_invite: 'i1' })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: '  Ada@Example.org ' })
    expect(res.status).toBe(201)
    expect(generateLink).toHaveBeenCalledWith({
      type: 'invite', email: 'ada@example.org', options: { redirectTo: 'https://harmony.test/reset-password?invite=1' },
    })
    expect(rpc).toHaveBeenCalledWith('admin_record_instance_invite', {
      p_auth_user_id: USER_ID, p_email: 'ada@example.org', p_delivery: 'link', p_action: 'create', p_admin_id: 'p-admin',
    })
    expect(res.body.link).toBe(`https://harmony.test/reset-password?invite=1&token_hash=${HASH}&type=invite`)
    expect(res.body.expires_at).toBe('2026-11-06T10:00:00.000Z')
    expect(res.body.invite).toMatchObject({ id: 'i1', delivery: 'link', recorded: true })
  })

  it('lands on APP_URL when it is set', async () => {
    cfg.APP_URL = 'https://app.harmony.test'
    rpcAnswers({ admin_instance_invite_account: [], admin_record_instance_invite: 'i1' })
    await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(generateLink.mock.calls[0][0].options.redirectTo).toBe('https://app.harmony.test/reset-password?invite=1')
  })

  it('answers auth_failed when GoTrue returns no token hash', async () => {
    rpcAnswers({ admin_instance_invite_account: [] })
    generateLink.mockResolvedValue({ data: { user: { id: USER_ID }, properties: { action_link: 'https://x/verify' } }, error: null })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(502)
    expect(rpc).not.toHaveBeenCalledWith('admin_record_instance_invite', expect.anything())
  })

  it.each([
    ['has signed in', { accepted: true }],
    ['has a profile', { has_profile: true }],
    ['signed up itself', { invited: false }],
  ])('answers account_exists and creates nothing for an address whose account %s', async (_name, over) => {
    rpcAnswers({ admin_instance_invite_account: [account(over)] })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('account_exists')
    expect(generateLink).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalledWith('admin_record_instance_invite', expect.anything())
  })

  it('names the open invitation of an address already invited', async () => {
    rpcAnswers({ admin_instance_invite_account: [account()] })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'invite_pending', auth_user_id: USER_ID })
    expect(generateLink).not.toHaveBeenCalled()
  })

  it('answers account_exists when GoTrue finds the address confirmed meanwhile', async () => {
    rpcAnswers({ admin_instance_invite_account: [] })
    generateLink.mockResolvedValue({ data: { user: null, properties: null }, error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' } })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('account_exists')
  })

  it('answers invalid_email when GoTrue refuses the address', async () => {
    rpcAnswers({ admin_instance_invite_account: [] })
    generateLink.mockResolvedValue({ data: { user: null, properties: null }, error: { status: 400, code: 'email_address_invalid', message: 'Email address "a@b.c" is invalid' } })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'a@b.cc' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_email')
  })

  it('refuses to email without SMTP and calls nothing', async () => {
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org', send: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('email_unavailable')
    expect(inviteUserByEmail).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses a send that is not a boolean', async () => {
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org', send: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_send')
  })

  it('has GoTrue email the invitation when SMTP is set, and returns no link', async () => {
    cfg.GOTRUE_SMTP_HOST = 'smtp.example.org'
    rpcAnswers({ admin_instance_invite_account: [], admin_record_instance_invite: 'i1' })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org', send: true })
    expect(res.status).toBe(201)
    expect(inviteUserByEmail).toHaveBeenCalledWith('ada@example.org', { redirectTo: 'https://harmony.test/reset-password?invite=1' })
    expect(generateLink).not.toHaveBeenCalled()
    expect(res.body.link).toBeNull()
    expect(rpc).toHaveBeenCalledWith('admin_record_instance_invite', expect.objectContaining({ p_delivery: 'email' }))
  })

  it('reports a failed send', async () => {
    cfg.GOTRUE_SMTP_HOST = 'smtp.example.org'
    rpcAnswers({ admin_instance_invite_account: [] })
    inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: { status: 500, message: 'Error sending invite email' } })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org', send: true })
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'auth_failed', detail: 'Error sending invite email' })
  })

  it('still returns the link when recording fails', async () => {
    rpc.mockImplementation(async (name: string) =>
      name === 'admin_record_instance_invite' ? { data: null, error: { message: 'boom' } } : { data: [], error: null })
    const res = await supertest(app).post('/admin/invites').set(auth).send({ email: 'ada@example.org' })
    expect(res.status).toBe(201)
    expect(res.body.link).toContain('type=invite')
    expect(res.body.invite.recorded).toBe(false)
  })
})

describe('admin invites: new link', () => {
  it('re-issues the link of an open invitation', async () => {
    rpcAnswers({ admin_instance_invite_account: [account()], admin_record_instance_invite: 'i1' })
    const res = await supertest(app).post(`/admin/invites/${USER_ID}/link`).set(auth)
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('admin_instance_invite_account', { p_auth_user_id: USER_ID })
    expect(generateLink).toHaveBeenCalledWith({
      type: 'invite', email: 'ada@example.org', options: { redirectTo: 'https://harmony.test/reset-password?invite=1' },
    })
    expect(rpc).toHaveBeenCalledWith('admin_record_instance_invite', expect.objectContaining({ p_action: 'reissue', p_delivery: 'link' }))
    expect(res.body.link).toBe(`https://harmony.test/reset-password?invite=1&token_hash=${HASH}&type=invite`)
  })

  it('re-issues a recovery link when the address was confirmed without a password', async () => {
    rpcAnswers({ admin_instance_invite_account: [account()], admin_record_instance_invite: 'i1' })
    const RECOVERY_SENT = '2026-11-07T08:00:00.000Z'
    generateLink
      .mockResolvedValueOnce({ data: { user: null, properties: null }, error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' } })
      .mockResolvedValueOnce({
        data: { user: { id: USER_ID, confirmation_sent_at: SENT, recovery_sent_at: RECOVERY_SENT }, properties: { hashed_token: 'cd'.repeat(28) } },
        error: null,
      })
    const res = await supertest(app).post(`/admin/invites/${USER_ID}/link`).set(auth)
    expect(res.status).toBe(200)
    expect(generateLink.mock.calls.map((c) => c[0].type)).toEqual(['invite', 'recovery'])
    expect(generateLink.mock.calls[1][0]).toEqual({
      type: 'recovery', email: 'ada@example.org', options: { redirectTo: 'https://harmony.test/reset-password?invite=1' },
    })
    expect(res.body.link).toBe(`https://harmony.test/reset-password?invite=1&token_hash=${'cd'.repeat(28)}&type=recovery`)
    expect(res.body.expires_at).toBe('2026-11-08T08:00:00.000Z')
    expect(rpc).toHaveBeenCalledWith('admin_record_instance_invite', expect.objectContaining({ p_action: 'reissue' }))
  })

  it('refuses an invitation already accepted', async () => {
    rpcAnswers({ admin_instance_invite_account: [account({ accepted: true })] })
    const res = await supertest(app).post(`/admin/invites/${USER_ID}/link`).set(auth)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('invite_accepted')
    expect(generateLink).not.toHaveBeenCalled()
  })

  it('answers 404 for an account that is no invitation, and 400 for a malformed id', async () => {
    rpcAnswers({ admin_instance_invite_account: [account({ invited: false })] })
    const missing = await supertest(app).post(`/admin/invites/${USER_ID}/link`).set(auth)
    expect(missing.status).toBe(404)
    const malformed = await supertest(app).post('/admin/invites/not-a-uuid/link').set(auth)
    expect(malformed.status).toBe(400)
    expect(generateLink).not.toHaveBeenCalled()
  })
})

describe('admin invites: revoking', () => {
  it('revokes an unused invitation as the calling admin', async () => {
    rpcAnswers({ admin_revoke_instance_invite: 'revoked' })
    const res = await supertest(app).delete(`/admin/invites/${USER_ID}`).set(auth)
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('admin_revoke_instance_invite', { p_auth_user_id: USER_ID, p_admin_id: 'p-admin' })
  })

  it.each([
    ['accepted', 409, 'invite_accepted'],
    ['not_invited', 409, 'not_an_invite'],
    ['not_found', 404, 'invite_not_found'],
  ])('answers %s with %i %s', async (answer, status, error) => {
    rpcAnswers({ admin_revoke_instance_invite: answer })
    const res = await supertest(app).delete(`/admin/invites/${USER_ID}`).set(auth)
    expect(res.status).toBe(status)
    expect(res.body.error).toBe(error)
  })

  it('refuses a malformed id', async () => {
    const res = await supertest(app).delete('/admin/invites/x').set(auth)
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('admin invites: helpers', () => {
  it('reads supabase-mail and an empty host as no email', () => {
    expect(mailConfigured('')).toBe(false)
    expect(mailConfigured('supabase-mail')).toBe(false)
    expect(mailConfigured('smtp.example.org')).toBe(true)
  })

  it('lowercases and trims addresses', () => {
    expect(parseInviteEmail(' Ada@Example.ORG ')).toBe('ada@example.org')
    expect(parseInviteEmail('ada@example')).toBeNull()
  })

  it('adds the link lifetime to the time it was made', () => {
    expect(linkExpiry(SENT, 3600)).toBe('2026-11-05T11:00:00.000Z')
    expect(linkExpiry(null)).toBeNull()
  })
})
