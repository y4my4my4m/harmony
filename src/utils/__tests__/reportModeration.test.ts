import { describe, it, expect, beforeAll } from 'vitest'
import { waitForInitialLocale } from '@/i18n'
import {
  categoryForReason,
  remoteDomainOf,
  reportActionsFor,
  reportErrorMessage,
  reportSourceLabel,
  snapshotEvidence,
  type ActionableReport,
} from '@/utils/reportModeration'

beforeAll(async () => {
  await waitForInitialLocale()
})

const admin = { isAdmin: true, isInstanceModerator: true }
const moderator = { isAdmin: false, isInstanceModerator: true }
const serverModerator = { isAdmin: false, isInstanceModerator: false }

function report(overrides: Partial<ActionableReport> = {}): ActionableReport {
  return {
    status: 'pending',
    source: 'local',
    reported_user_id: 'u1',
    reported_user_is_local: true,
    reported_post_id: null,
    reported_message_id: null,
    ...overrides,
  }
}

describe('categoryForReason', () => {
  it('maps client reasons onto Mastodon categories', () => {
    expect(categoryForReason('spam')).toBe('spam')
    expect(categoryForReason('illegal_content')).toBe('legal')
    expect(categoryForReason('harassment')).toBe('violation')
    expect(categoryForReason('nsfw')).toBe('violation')
    expect(categoryForReason('anything else')).toBe('other')
  })
})

describe('remoteDomainOf', () => {
  it('names the domain of a remote account only', () => {
    expect(remoteDomainOf({ is_local: false, domain: 'Mastodon.Social' }, 'harmony.test')).toBe('mastodon.social')
    expect(remoteDomainOf({ is_local: true, domain: 'mastodon.social' }, 'harmony.test')).toBeNull()
    expect(remoteDomainOf({ domain: 'harmony.test' }, 'harmony.test')).toBeNull()
    expect(remoteDomainOf({ is_local: false, domain: null }, 'harmony.test')).toBeNull()
    expect(remoteDomainOf(undefined, 'harmony.test')).toBeNull()
  })
})

describe('reportActionsFor', () => {
  it('offers only reopen on a closed report', () => {
    expect(reportActionsFor(report({ status: 'resolved' }), admin)).toEqual(['reopen'])
  })

  it('limits a server moderator to status, assignment and message deletion', () => {
    const actions = reportActionsFor(report({ reported_message_id: 'm1' }), serverModerator)
    expect(actions).toEqual(['investigate', 'resolve', 'dismiss', 'assign', 'delete_message'])
  })

  it('does not offer deleting a message that is already gone', () => {
    expect(reportActionsFor(report({ reported_message_id: 'm1', reported_message_is_deleted: true }), serverModerator))
      .not.toContain('delete_message')
  })

  it('gives instance moderators content actions and warnings', () => {
    const actions = reportActionsFor(report({ reported_post_id: 'p1' }), moderator)
    expect(actions).toEqual(expect.arrayContaining(['delete_post', 'mark_sensitive', 'warn']))
  })

  it('offers forwarding for a local report about a remote account until it is forwarded', () => {
    const remote = report({ reported_user_is_local: false })
    expect(reportActionsFor(remote, moderator)).toContain('forward')
    expect(reportActionsFor({ ...remote, forwarded_at: '2026-10-01T00:00:00Z' }, moderator)).not.toContain('forward')
    expect(reportActionsFor({ ...remote, federation_status: 'queued' }, moderator)).not.toContain('forward')
    expect(reportActionsFor({ ...remote, source: 'federation' }, moderator)).not.toContain('forward')
    expect(reportActionsFor(remote, moderator)).not.toContain('warn')
  })

  it('gives moderators account actions and keeps domain actions for admins', () => {
    const actions = reportActionsFor(report({ reported_user_is_local: false }), moderator)
    expect(actions).toEqual(expect.arrayContaining(['silence_account', 'suspend_account', 'force_sensitive_account']))
    expect(actions).not.toContain('limit_domain')
    expect(actions).not.toContain('suspend_domain')
  })

  it('gives admins account and domain actions for remote accounts', () => {
    const actions = reportActionsFor(report({ reported_user_is_local: false }), admin)
    expect(actions).toEqual(expect.arrayContaining(['silence_account', 'suspend_account', 'limit_domain', 'suspend_domain']))
  })

  it('hides account and domain actions already in effect', () => {
    const actions = reportActionsFor(report({
      reported_user_is_local: false,
      reported_user_is_silenced: true,
      reported_user_is_suspended: true,
      reported_domain_limited: true,
    }), admin)
    expect(actions).not.toContain('silence_account')
    expect(actions).not.toContain('suspend_account')
    expect(actions).not.toContain('limit_domain')
    expect(actions).toContain('suspend_domain')
    expect(reportActionsFor(report({ reported_user_is_local: false, reported_domain_blocked: true }), admin))
      .not.toContain('suspend_domain')
  })

  it('offers unassign to the assignee', () => {
    expect(reportActionsFor(report({ assigned_to: 'me' }), moderator, 'me')).toContain('unassign')
    expect(reportActionsFor(report({ assigned_to: 'other' }), moderator, 'me')).toContain('assign')
  })
})

describe('reportSourceLabel', () => {
  it('names the sending domain of a federated report', () => {
    expect(reportSourceLabel({ source: 'federation', source_instance: 'mastodon.social' })).toBe('from mastodon.social')
    expect(reportSourceLabel({ source: 'federation' })).toBe('from a remote instance')
    expect(reportSourceLabel({ source: 'local' })).toBe('local')
  })
})

describe('snapshotEvidence', () => {
  it('shows the content as reported', () => {
    expect(snapshotEvidence({
      posts: [{ content: [{ type: 'text', text: 'buy now' }, { type: 'url', url: 'https://spam.test' }], content_warning: 'ad' }],
    })).toEqual([{ label: 'Post as reported', text: 'CW: ad\nbuy now https://spam.test', note: undefined }])
  })

  it('marks reporter-supplied plaintext of an encrypted message', () => {
    const [item] = snapshotEvidence({ message: { encrypted: true, content: [{ type: 'text', text: 'AAAA' }], evidence_text: 'hello' } })
    expect(item.text).toBe('hello')
    expect(item.note).toMatch(/reporter/)
  })

  it('marks snapshots taken after the fact', () => {
    const [item] = snapshotEvidence({ backfilled: true, message: { content: [{ type: 'text', text: 'hi' }] } })
    expect(item.note).toMatch(/after/)
  })

  it('is empty without a snapshot', () => {
    expect(snapshotEvidence(null)).toEqual([])
  })

  it('links a private attachment by reference, never by the URL it carried', () => {
    const path = 'd/77777777-0000-4000-8000-000000000007/u/notes.pdf'
    const [item] = snapshotEvidence({ message: { content: [
      { type: 'file', fileType: 'file', path, url: 'https://db.test/storage/v1/object/sign/message_media/x?token=t' },
      { type: 'file', fileType: 'image', url: 'https://cdn.test/legacy.png' },
    ] } })
    expect(item.text).toBe(
      `[file: http://localhost:54321/storage/v1/object/authenticated/message_media/${path}] [image: https://cdn.test/legacy.png]`)
  })
})

describe('reportErrorMessage', () => {
  it('explains rate limits and missing content', () => {
    expect(reportErrorMessage({ code: 'PT429' })).toMatch(/too many/)
    expect(reportErrorMessage({ code: 'P0002' })).toMatch(/no longer available/)
    expect(reportErrorMessage({ code: '22023', message: 'Cannot report yourself' })).toMatch(/yourself/)
    expect(reportErrorMessage(null)).toMatch(/could not be sent/)
  })
})
