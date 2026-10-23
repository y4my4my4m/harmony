import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reports about a message in a server hosted on another instance (migration
// 20261027400001): the reporting instance sends the Group a Flag signed by its instance
// actor, naming the author and the message and never the reporter; the Group's inbox files
// one report scoped to the server; resolving it sends the Group's Resolve back, which settles
// the reporting instance's report.

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
const signedApFetch = vi.hoisted(() => vi.fn())
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifyActorMatch: (a: string, b: string) => a.replace(/\/$/, '') === b.replace(/\/$/, ''),
    signedApFetch,
  },
}))

const REPORTER = 'aaaaaaaa-0000-0000-0000-00000000000a'
const AUTHOR = 'bbbbbbbb-0000-0000-0000-00000000000b'
const REPORT = 'cccccccc-0000-0000-0000-00000000000c'
const MESSAGE = 'dddddddd-0000-0000-0000-00000000000d'
const CHANNEL = 'eeeeeeee-0000-0000-0000-00000000000e'
const COPY = 'ffffffff-0000-0000-0000-00000000000f'
const HOSTED = '12121212-0000-0000-0000-000000000012'
const GROUP = `https://host.test/servers/${COPY}`

type Row = Record<string, any>
let tables: Record<string, Row[]>
const updates: Array<{ table: string; values: Row; filters: Row }> = []
const rpcCalls: Array<{ name: string; args: Row }> = []
let rpcResult: Row = { status: 'created' }

function query(table: string) {
  const filters: Row = {}
  const rows = () => (tables[table] ?? []).filter((r) =>
    Object.entries(filters).every(([k, v]) => {
      if (k.startsWith('metadata->>')) return r.metadata?.[k.slice('metadata->>'.length)] === v
      return r[k] === v
    }))
  const c: any = {
    select: () => c,
    eq: (col: string, val: unknown) => { filters[col] = val; return c },
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    update: (values: Row) => ({
      eq: (col: string, val: unknown) => {
        updates.push({ table, values, filters: { [col]: val } })
        return Promise.resolve({ error: null })
      },
    }),
  }
  return c
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (t: string) => query(t),
    rpc: (name: string, args: Row) => {
      rpcCalls.push({ name, args })
      return Promise.resolve({ data: rpcResult, error: null })
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const flag = await import('../activitypub/flag.js')
const { handleReportJob } = await import('../queue/handlers/reportHandler.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { processServerFlag } = await import('../activitypub/ServerInboxHandler.js')

function seedReporting(overrides: { report?: Row; message?: Row; server?: Row; author?: Row } = {}) {
  tables = {
    reports: [{
      id: REPORT,
      reporter_id: REPORTER,
      source: 'local',
      forward_to_server: true,
      server_forwarded_at: null,
      reported_message_id: MESSAGE,
      reason: 'harassment',
      comment: 'Slurs in #general',
      content_snapshot: { message: { id: MESSAGE, user_id: AUTHOR, server_id: COPY } },
      ...overrides.report,
    }],
    messages: [{
      id: MESSAGE,
      channel_id: CHANNEL,
      user_id: AUTHOR,
      metadata: { ap_id: `https://host.test/messages/${MESSAGE}` },
      ...overrides.message,
    }],
    channels: [{ id: CHANNEL, server_id: COPY }],
    servers: [{
      id: COPY,
      is_local_server: false,
      ap_id: GROUP,
      federation_inbox_url: `${GROUP}/inbox`,
      federation_metadata: { accepts_reports: true },
      ...overrides.server,
    }],
    profiles: [
      { id: AUTHOR, federated_id: 'https://host.test/users/troll', username: 'troll', is_local: false, ...overrides.author },
      { id: REPORTER, federated_id: null, username: 'reporter', is_local: true },
    ],
  }
}

beforeEach(() => {
  updates.length = 0
  rpcCalls.length = 0
  rpcResult = { status: 'created' }
  vi.restoreAllMocks()
  seedReporting()
})

const serverStatuses = () =>
  updates.filter((u) => u.table === 'reports').map((u) => u.values.server_forward_status)

describe('flag helpers for server reports', () => {
  it('reads /messages/<uuid> of this instance as a message', () => {
    expect(flag.parseLocalObjectUri(`https://harmony.test/messages/${MESSAGE}`, 'harmony.test'))
      .toEqual({ kind: 'message', id: MESSAGE })
    expect(flag.parseLocalObjectUri(`https://other.test/messages/${MESSAGE}`, 'harmony.test')).toBeNull()
    expect(flag.parseLocalObjectUri('https://harmony.test/messages/nope', 'harmony.test')).toBeNull()
  })

  it('names the report of a server Flag this instance sent, and nothing else', () => {
    const base = 'https://harmony.test'
    expect(flag.serverFlagReportId(flag.serverFlagActivityId(base, REPORT), base)).toBe(REPORT)
    expect(flag.serverFlagReportId(flag.flagActivityId(base, REPORT), base)).toBeNull()
    expect(flag.serverFlagReportId(`https://evil.test/flags/${REPORT}/server`, base)).toBeNull()
    expect(flag.serverFlagReportId(undefined, base)).toBeNull()
  })

  it('builds the Flag to the Group: author then message, addressed to the Group', () => {
    expect(flag.buildServerFlagActivity({
      baseUrl: 'https://harmony.test',
      reportId: REPORT,
      actor: 'https://harmony.test/users/instance.actor',
      groupUri: GROUP,
      authorUri: 'https://host.test/users/troll',
      messageUri: `https://host.test/messages/${MESSAGE}`,
      comment: null,
      reason: 'not-a-reason',
    })).toEqual({
      '@context': ['https://www.w3.org/ns/activitystreams', { harmony: 'https://harmonyapp.dev/ns#' }],
      id: `https://harmony.test/flags/${REPORT}/server`,
      type: 'Flag',
      actor: 'https://harmony.test/users/instance.actor',
      object: ['https://host.test/users/troll', `https://host.test/messages/${MESSAGE}`],
      to: [GROUP],
      content: '',
    })
  })

  it('builds the Resolve with an id fixed per resolution', () => {
    const resolve = flag.buildResolveActivity({
      groupUri: GROUP,
      reportId: REPORT,
      resolvedAt: '2026-10-23T10:00:00.000Z',
      flagId: `https://member.test/flags/${MESSAGE}/server`,
      flagActor: 'https://member.test/users/instance.actor',
      outcome: 'dismissed',
    })
    expect(resolve).toMatchObject({
      id: `${GROUP}/activities/report-${REPORT}-${Date.parse('2026-10-23T10:00:00.000Z')}`,
      type: 'Resolve',
      actor: GROUP,
      object: { id: `https://member.test/flags/${MESSAGE}/server`, type: 'Flag' },
      to: ['https://member.test/users/instance.actor'],
      'harmony:outcome': 'dismissed',
    })
    expect(flag.resolveOutcome(resolve)).toBe('dismissed')
    expect(flag.resolveOutcome({ 'harmony:outcome': 'deleted' })).toBeNull()
  })
})

describe('federate-report to the server', () => {
  const groupDoc = (extra: Row) => new Response(JSON.stringify({ id: GROUP, type: 'Group', ...extra }), {
    status: 200, headers: { 'content-type': 'application/activity+json' },
  })

  it('sends nothing to a host that takes no reports for its servers (before 1.8.12), and says so', async () => {
    seedReporting({ server: { federation_metadata: {} } })
    signedApFetch.mockResolvedValue(groupDoc({}))
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', target: 'server', report_id: REPORT })

    expect(signedApFetch).toHaveBeenCalledWith(GROUP)
    expect(deliver).not.toHaveBeenCalled()
    expect(serverStatuses()).toEqual(['skipped'])
  })

  it('asks the Group document when the copy has not synced since its host took reports', async () => {
    seedReporting({ server: { federation_metadata: {} } })
    signedApFetch.mockResolvedValue(groupDoc({ 'harmony:acceptsReports': true }))
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', target: 'server', report_id: REPORT })

    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('sends the Group a Flag from the instance actor naming the message and its author, not the reporter', async () => {
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', target: 'server', report_id: REPORT })

    expect(deliver).toHaveBeenCalledTimes(1)
    const [sent, inbox] = deliver.mock.calls[0] as [Row, string]
    expect(inbox).toBe(`${GROUP}/inbox`)
    expect(sent).toMatchObject({
      id: `https://harmony.test/flags/${REPORT}/server`,
      type: 'Flag',
      actor: 'https://harmony.test/users/instance.actor',
      object: ['https://host.test/users/troll', `https://host.test/messages/${MESSAGE}`],
      to: [GROUP],
      content: 'Slurs in #general',
      'harmony:reason': 'harassment',
    })
    const raw = JSON.stringify(sent)
    expect(raw).not.toContain(REPORTER)
    expect(raw).not.toContain('reporter')
    expect(serverStatuses()).toEqual(['processing', 'completed'])
    expect(updates.at(-1)?.values.server_forwarded_at).toEqual(expect.any(String))
  })

  it('names a local author\'s own message by this instance\'s URI', async () => {
    seedReporting({ message: { metadata: {} }, author: { federated_id: null, username: 'neighbour', is_local: true } })
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: true, retry: false })

    await handleReportJob({ type: 'create', target: 'server', report_id: REPORT })

    expect((deliver.mock.calls[0][0] as Row).object).toEqual([
      'https://harmony.test/users/neighbour',
      `https://harmony.test/messages/${MESSAGE}`,
    ])
  })

  it.each([
    ['the reporter unchecked it', { report: { forward_to_server: false } }],
    ['the report came from another instance', { report: { source: 'federation' } }],
    ['the server is hosted here', { server: { is_local_server: true } }],
  ])('skips when %s', async (_why, overrides) => {
    seedReporting(overrides)
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor')

    await handleReportJob({ type: 'create', target: 'server', report_id: REPORT })

    expect(deliver).not.toHaveBeenCalled()
    expect(serverStatuses()).toEqual(['skipped'])
  })

  it('does not send twice', async () => {
    seedReporting({ report: { server_forwarded_at: '2026-10-23T00:00:00Z' } })
    const deliver = vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor')

    await handleReportJob({ type: 'create', target: 'server', report_id: REPORT })

    expect(deliver).not.toHaveBeenCalled()
    expect(serverStatuses()).toEqual([])
  })

  it('throws on a retryable failure', async () => {
    vi.spyOn(DeliveryQueue, 'deliverAsInstanceActor').mockResolvedValue({ delivered: false, retry: true })

    await expect(handleReportJob({ type: 'create', target: 'server', report_id: REPORT })).rejects.toThrow(/retrying/)
    expect(serverStatuses()).toEqual(['processing', 'failed'])
  })
})

describe('Flag at a Group inbox', () => {
  const FLAG_ID = `https://member.test/flags/${REPORT}/server`
  const ACTOR = 'https://member.test/users/instance.actor'
  const flagAt = (object: string[]) => ({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: FLAG_ID,
    type: 'Flag',
    actor: ACTOR,
    object,
    to: [`https://harmony.test/servers/${HOSTED}`],
    content: '<p>Slurs &amp; threats</p>',
    'harmony:reason': 'harassment',
  })

  beforeEach(() => {
    tables = {
      messages: [
        { id: MESSAGE, channel_id: CHANNEL, user_id: AUTHOR, metadata: { ap_id: 'https://member.test/messages/m1' } },
      ],
      channels: [{ id: CHANNEL, server_id: HOSTED }],
      profiles: [],
      posts: [],
    }
  })

  it('files one report scoped to the server for a message named by this instance\'s URI', async () => {
    await processServerFlag(HOSTED, flagAt(['https://member.test/users/someone', `https://harmony.test/messages/${MESSAGE}`]), ACTOR)

    expect(rpcCalls).toEqual([{
      name: 'create_federated_server_report',
      args: {
        p_ap_id: FLAG_ID,
        p_actor: ACTOR,
        p_source_domain: 'member.test',
        p_server_id: HOSTED,
        p_message_id: MESSAGE,
        p_comment: 'Slurs & threats',
        p_reason: 'harassment',
        p_object_uris: ['https://member.test/users/someone', `https://harmony.test/messages/${MESSAGE}`],
      },
    }])
  })

  it('finds a message of a member instance by its stored ap_id', async () => {
    await processServerFlag(HOSTED, flagAt(['https://member.test/messages/m1']), ACTOR)

    expect(rpcCalls[0]?.args.p_message_id).toBe(MESSAGE)
  })

  it('refuses a Flag not signed by its actor', async () => {
    await processServerFlag(HOSTED, flagAt([`https://harmony.test/messages/${MESSAGE}`]), null)
    await processServerFlag(HOSTED, flagAt([`https://harmony.test/messages/${MESSAGE}`]), 'https://member.test/users/mallory')

    expect(rpcCalls).toEqual([])
  })

  it('does not file a message of another server', async () => {
    tables.channels = [{ id: CHANNEL, server_id: COPY }]
    const accountFlag = vi.spyOn(ActivityProcessor, 'processFlag').mockResolvedValue()

    await processServerFlag(HOSTED, flagAt([`https://harmony.test/messages/${MESSAGE}`]), ACTOR)

    expect(rpcCalls.filter((c) => c.name === 'create_federated_server_report')).toEqual([])
    expect(accountFlag).toHaveBeenCalledTimes(1)
  })
})

describe('Resolve from the Group', () => {
  const resolve = (object: unknown, outcome = 'resolved') => ({
    id: `${GROUP}/activities/report-x-1`,
    type: 'Resolve',
    actor: GROUP,
    object,
    'harmony:outcome': outcome,
  })

  it('settles the report its Flag id names', async () => {
    rpcResult = { status: 'applied', report_status: 'resolved' }
    await ActivityProcessor.processReportResolve(resolve({ id: `https://harmony.test/flags/${REPORT}/server`, type: 'Flag' }))

    expect(rpcCalls).toEqual([{
      name: 'apply_server_report_resolution',
      args: { p_report_id: REPORT, p_group: GROUP, p_outcome: 'resolved' },
    }])
  })

  it('ignores a Resolve of another instance\'s Flag, an account Flag or an unknown outcome', async () => {
    await ActivityProcessor.processReportResolve(resolve(`https://other.test/flags/${REPORT}/server`))
    await ActivityProcessor.processReportResolve(resolve(`https://harmony.test/flags/${REPORT}`))
    await ActivityProcessor.processReportResolve(resolve(`https://harmony.test/flags/${REPORT}/server`, 'deleted'))

    expect(rpcCalls).toEqual([])
  })
})

describe('federate-report resolution on the host', () => {
  const FLAG_ID = `https://member.test/flags/${REPORT}/server`
  const ACTOR = 'https://member.test/users/instance.actor'

  beforeEach(() => {
    tables = {
      reports: [{
        id: REPORT,
        status: 'resolved',
        source: 'federation',
        scope_server_id: HOSTED,
        ap_id: FLAG_ID,
        source_instance: 'member.test',
        resolved_at: '2026-10-23T10:00:00.000Z',
        metadata: { actor: ACTOR, flag_target: 'group' },
      }],
    }
  })

  it('sends the Group\'s Resolve to the Flag actor\'s shared inbox, signed by the Group', async () => {
    vi.spyOn(ActivityProcessor, 'fetchApDocument').mockResolvedValue({
      doc: { id: ACTOR, inbox: `${ACTOR}/inbox`, endpoints: { sharedInbox: 'https://member.test/inbox' } },
      finalUrl: ACTOR,
    })
    const send = vi.spyOn(DeliveryQueue, 'sendToInbox').mockResolvedValue()

    await handleReportJob({ type: 'update', target: 'resolution', report_id: REPORT })

    expect(send).toHaveBeenCalledTimes(1)
    const [inbox, activity, signer] = send.mock.calls[0] as [string, Row, Row]
    expect(inbox).toBe('https://member.test/inbox')
    expect(signer).toEqual({ serverId: HOSTED })
    expect(activity).toMatchObject({
      type: 'Resolve',
      actor: `https://harmony.test/servers/${HOSTED}`,
      object: { id: FLAG_ID, type: 'Flag', actor: ACTOR },
      'harmony:outcome': 'resolved',
    })
  })

  it('sends nothing for a report reopened since, or filed from an account Flag', async () => {
    const send = vi.spyOn(DeliveryQueue, 'sendToInbox').mockResolvedValue()
    vi.spyOn(ActivityProcessor, 'fetchApDocument').mockResolvedValue({ doc: { inbox: `${ACTOR}/inbox` }, finalUrl: ACTOR })

    tables.reports[0].status = 'pending'
    await handleReportJob({ type: 'update', target: 'resolution', report_id: REPORT })
    tables.reports[0].status = 'dismissed'
    tables.reports[0].metadata = { actor: ACTOR }
    await handleReportJob({ type: 'update', target: 'resolution', report_id: REPORT })

    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing to an inbox on another host than the Flag actor', async () => {
    vi.spyOn(ActivityProcessor, 'fetchApDocument').mockResolvedValue({
      doc: { inbox: 'https://elsewhere.test/inbox' },
      finalUrl: ACTOR,
    })
    const send = vi.spyOn(DeliveryQueue, 'sendToInbox').mockResolvedValue()

    await handleReportJob({ type: 'update', target: 'resolution', report_id: REPORT })

    expect(send).not.toHaveBeenCalled()
  })
})
