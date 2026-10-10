import { describe, it, expect, vi, beforeEach } from 'vitest'

// Block and unblock of a remote actor reach its inbox. The job carries
// blocked_user_id, the user_blocks column trigger_queue_block_federation sends.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test' } }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const profiles: Record<string, any> = {
  blocker: { id: 'blocker', username: 'poring', is_local: true },
  remote: {
    id: 'remote',
    username: 'bob',
    is_local: false,
    federated_id: 'https://mastodon.test/users/bob',
    inbox_url: 'https://mastodon.test/users/bob/inbox',
  },
  local: { id: 'local', username: 'alice', is_local: true },
}
const statusWrites: Array<{ table: string; status: string }> = []

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      let id: string | undefined
      const c: any = {
        select: () => c,
        eq: (_col: string, val: string) => { id = val; return c },
        single: () => Promise.resolve({ data: profiles[id as string] ?? null, error: null }),
        update: (patch: any) => {
          statusWrites.push({ table, status: patch.federation_status })
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
      }
      return c
    },
  }),
}))

const sendToInbox = vi.fn().mockResolvedValue(undefined)
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { sendToInbox } }))

const { handleBlockJob } = await import('../queue/handlers/blockHandler.js')

beforeEach(() => {
  sendToInbox.mockClear()
  statusWrites.length = 0
})

describe('block federation', () => {
  it('sends Block to the blocked remote actor', async () => {
    await handleBlockJob({ type: 'create', block_id: 'b1', blocker_id: 'blocker', blocked_user_id: 'remote' })

    expect(sendToInbox).toHaveBeenCalledTimes(1)
    const [inbox, activity, sender] = sendToInbox.mock.calls[0]
    expect(inbox).toBe('https://mastodon.test/users/bob/inbox')
    expect(sender).toBe('blocker')
    expect(activity).toMatchObject({
      type: 'Block',
      id: 'https://harmony.test/activities/block/b1',
      actor: 'https://harmony.test/users/poring',
      object: 'https://mastodon.test/users/bob',
    })
    expect(statusWrites.at(-1)).toEqual({ table: 'user_blocks', status: 'completed' })
  })

  it('sends Undo(Block) embedding the Block it retracts', async () => {
    await handleBlockJob({ type: 'delete', block_id: 'b1', blocker_id: 'blocker', blocked_user_id: 'remote' })

    const [inbox, activity] = sendToInbox.mock.calls[0]
    expect(inbox).toBe('https://mastodon.test/users/bob/inbox')
    expect(activity.type).toBe('Undo')
    expect(activity.actor).toBe('https://harmony.test/users/poring')
    expect(activity.object).toEqual({
      id: 'https://harmony.test/activities/block/b1',
      type: 'Block',
      actor: 'https://harmony.test/users/poring',
      object: 'https://mastodon.test/users/bob',
    })
  })

  it('federates nothing for a local blocked user', async () => {
    await handleBlockJob({ type: 'create', block_id: 'b2', blocker_id: 'blocker', blocked_user_id: 'local' })
    expect(sendToInbox).not.toHaveBeenCalled()
    expect(statusWrites.at(-1)).toEqual({ table: 'user_blocks', status: 'skipped' })
  })
})
