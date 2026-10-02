import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Outbound report forwarding: federate-report builds a Flag from the report row
// and delivers it to the target's instance signed by the instance actor. The
// reporter appears nowhere in what leaves the instance.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony Test',
    NODE_ENV: 'test',
    REQUIRE_VALID_SIGNATURES: true,
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/PerformanceMonitor.js', () => ({
  performanceMonitor: { recordMetric: vi.fn() },
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalUrl: vi.fn(),
}))

const REPORTER = 'aaaaaaaa-0000-0000-0000-00000000000a'
const TARGET = 'bbbbbbbb-0000-0000-0000-00000000000b'
const REPORT = 'cccccccc-0000-0000-0000-00000000000c'
const POST = 'dddddddd-0000-0000-0000-00000000000d'

const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

interface Tables {
  reports: Record<string, any>
  profiles: Record<string, any>
  posts: Record<string, any>
  instance_actor_keys: Record<string, any>
}
let tables: Tables
const updates: Array<{ table: string; values: any; id: unknown }> = []
const reads: string[] = []

function query(table: keyof Tables) {
  const filters: Record<string, unknown> = {}
  const c: any = {
    select: () => c,
    eq: (col: string, val: unknown) => {
      filters[col] = val
      return c
    },
    maybeSingle: () => {
      const key = String(filters.id)
      reads.push(`${table}:${key}`)
      return Promise.resolve({ data: tables[table][key] ?? null, error: null })
    },
    update: (values: any) => ({
      eq: (_col: string, id: unknown) => {
        updates.push({ table, values, id })
        return Promise.resolve({ error: null })
      },
    }),
    upsert: (row: any) => {
      tables.instance_actor_keys.true = row
      return Promise.resolve({ error: null })
    },
  }
  return c
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (t: keyof Tables) => query(t),
    rpc: () => Promise.resolve({ error: null }),
  }),
}))

const { handleReportJob } = await import('../queue/handlers/reportHandler.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const { buildFlagActivity } = await import('../activitypub/flag.js')
const { __resetInstanceActorKeyCache, instanceActorDocument } = await import('../activitypub/InstanceActor.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')

function seed(overrides: { report?: Partial<any>; target?: Partial<any>; post?: Partial<any> } = {}) {
  tables = {
    reports: {
      [REPORT]: {
        id: REPORT,
        reporter_id: REPORTER,
        source: 'local',
        forward: true,
        forwarded_at: null,
        reported_user_id: TARGET,
        reported_post_id: POST,
        comment: 'Spam links in every reply',
        content_snapshot: { posts: [{ ap_id: 'https://remote.test/notes/1', author_id: TARGET, is_local: false }] },
        ...overrides.report,
      },
    },
    profiles: {
      [TARGET]: {
        id: TARGET,
        is_local: false,
        federated_id: 'https://remote.test/users/spammer',
        inbox_url: 'https://remote.test/users/spammer/inbox',
        shared_inbox_url: 'https://remote.test/inbox',
        ...overrides.target,
      },
    },
    posts: {
      [POST]: { ap_id: 'https://remote.test/notes/1', author_id: TARGET, is_local: false, ...overrides.post },
    },
    instance_actor_keys: {
      true: { public_key: keys.publicKey, private_key: keys.privateKey },
    },
  }
}

beforeEach(() => {
  updates.length = 0
  reads.length = 0
  __resetInstanceActorKeyCache()
  vi.mocked(safeFetch).mockReset()
  vi.restoreAllMocks()
  seed()
})

function statusUpdates() {
  return updates.filter((u) => u.table === 'reports').map((u) => u.values.federation_status)
}

describe('buildFlagActivity', () => {
  it('names the account first, then the statuses, and carries the comment', () => {
    const flag = buildFlagActivity({
      baseUrl: 'https://harmony.test',
      reportId: REPORT,
      actor: 'https://harmony.test/users/instance.actor',
      targetActorUri: 'https://remote.test/users/spammer',
      statusUris: ['https://remote.test/notes/1', 'https://remote.test/notes/1', 'https://remote.test/users/spammer'],
      comment: 'why',
    })
    expect(flag).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://harmony.test/flags/${REPORT}`,
      type: 'Flag',
      actor: 'https://harmony.test/users/instance.actor',
      object: ['https://remote.test/users/spammer', 'https://remote.test/notes/1'],
      content: 'why',
    })
  })

  it('sends an empty content when the reporter left no comment', () => {
    const flag = buildFlagActivity({
      baseUrl: 'https://harmony.test',
      reportId: REPORT,
      actor: 'https://harmony.test/users/instance.actor',
      targetActorUri: 'https://remote.test/users/spammer',
      statusUris: [],
      comment: null,
    })
    expect(flag.content).toBe('')
    expect(flag.object).toEqual(['https://remote.test/users/spammer'])
  })
})

describe('federate-report', () => {
  it('delivers a Flag from the instance actor to the shared inbox, without the reporter', async () => {
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', report_id: REPORT })

    expect(deliver).toHaveBeenCalledTimes(1)
    const [flag, inbox] = deliver.mock.calls[0]
    expect(inbox).toBe('https://remote.test/inbox')
    expect(flag).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://harmony.test/flags/${REPORT}`,
      type: 'Flag',
      actor: 'https://harmony.test/users/instance.actor',
      object: ['https://remote.test/users/spammer', 'https://remote.test/notes/1'],
      content: 'Spam links in every reply',
    })
    expect(JSON.stringify(flag)).not.toContain(REPORTER)
    expect(reads).not.toContain(`profiles:${REPORTER}`)
    expect(statusUpdates()).toEqual(['processing', 'completed'])
    expect(updates.at(-1)?.values.forwarded_at).toEqual(expect.any(String))
  })

  it('falls back to the personal inbox when the account has no shared inbox', async () => {
    seed({ target: { shared_inbox_url: null } })
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', report_id: REPORT })

    expect(deliver.mock.calls[0][1]).toBe('https://remote.test/users/spammer/inbox')
  })

  it('omits a reported post that is not the target\'s own', async () => {
    seed({
      post: { author_id: 'someone-else' },
      report: { content_snapshot: {} },
    })
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', report_id: REPORT })

    expect((deliver.mock.calls[0][0] as any).object).toEqual(['https://remote.test/users/spammer'])
  })

  it('uses the snapshot when the post is gone', async () => {
    seed({ report: { reported_post_id: null } })
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', report_id: REPORT })

    expect((deliver.mock.calls[0][0] as any).object).toEqual([
      'https://remote.test/users/spammer',
      'https://remote.test/notes/1',
    ])
  })

  it.each([
    ['the reporter did not ask to forward', { report: { forward: false } }],
    ['the report came from another instance', { report: { source: 'federation' } }],
    ['the account is local', { target: { is_local: true } }],
  ])('skips when %s', async (_why, overrides) => {
    seed(overrides)
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor')

    await handleReportJob({ type: 'create', report_id: REPORT })

    expect(deliver).not.toHaveBeenCalled()
    expect(statusUpdates()).toEqual(['skipped'])
  })

  it('does nothing for a report already forwarded', async () => {
    seed({ report: { forwarded_at: '2026-10-01T00:00:00Z' } })
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor')

    await handleReportJob({ type: 'create', report_id: REPORT })

    expect(deliver).not.toHaveBeenCalled()
    expect(statusUpdates()).toEqual([])
  })

  it('throws for a retryable failure so the job is retried', async () => {
    vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: false, retry: true })

    await expect(handleReportJob({ type: 'create', report_id: REPORT })).rejects.toThrow(/retrying/)
    expect(statusUpdates()).toEqual(['processing', 'failed'])
  })

  it('records a refused delivery without retrying', async () => {
    vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: false, retry: false })

    await expect(handleReportJob({ type: 'create', report_id: REPORT })).resolves.toBeUndefined()
    expect(statusUpdates()).toEqual(['processing', 'failed'])
  })
})

describe('DeliveryQueue.deliverAsInstanceActor', () => {
  it('signs with the instance actor key, verifiable against the published actor document', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 202 }))
    const flag = buildFlagActivity({
      baseUrl: 'https://harmony.test',
      reportId: REPORT,
      actor: 'https://harmony.test/users/instance.actor',
      targetActorUri: 'https://remote.test/users/spammer',
      statusUris: [],
      comment: 'x',
    })

    const result = await DeliveryQueue.deliverAsInstanceActor(flag, 'https://remote.test/inbox')

    expect(result).toEqual({ delivered: true, retry: false })
    const [url, init] = vi.mocked(safeFetch).mock.calls[0] as [string, any]
    expect(url).toBe('https://remote.test/inbox')
    const params = SignatureService.parseSignatureHeader(init.headers.Signature)
    expect(params.keyId).toBe('https://harmony.test/users/instance.actor#main-key')
    expect(params.headers).toBe('(request-target) host date digest')

    const actor = instanceActorDocument(keys.publicKey) as any
    expect(actor.publicKey.id).toBe(params.keyId)
    expect(actor.type).toBe('Application')
    const signingString = [
      '(request-target): post /inbox',
      `host: ${init.headers.Host}`,
      `date: ${init.headers.Date}`,
      `digest: ${init.headers.Digest}`,
    ].join('\n')
    expect(crypto.createVerify('SHA256').update(signingString)
      .verify(actor.publicKey.publicKeyPem, params.signature, 'base64')).toBe(true)
    expect(init.headers.Digest).toBe(
      `SHA-256=${crypto.createHash('sha256').update(init.body).digest('base64')}`)
  })

  it('generates and stores the key pair on first use', async () => {
    tables.instance_actor_keys = {}
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 202 }))

    await DeliveryQueue.deliverAsInstanceActor({ type: 'Flag' }, 'https://remote.test/inbox')

    expect(tables.instance_actor_keys.true?.private_key).toContain('PRIVATE KEY')
    const [, init] = vi.mocked(safeFetch).mock.calls[0] as [string, any]
    expect(SignatureService.parseSignatureHeader(init.headers.Signature).keyId)
      .toBe('https://harmony.test/users/instance.actor#main-key')
  })
})
