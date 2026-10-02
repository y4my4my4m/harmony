/**
 * Report categories, forwarding eligibility and the moderator actions a report
 * offers. The database enforces the same rules (create_report, moderate_report);
 * this decides what the UI shows.
 */

export type ReportCategory = 'spam' | 'legal' | 'violation' | 'other'

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'illegal_content'
  | 'impersonation'
  | 'nsfw'
  | 'other'

/** Mastodon's report categories. */
export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  spam: 'Spam',
  legal: 'Illegal content',
  violation: 'Rule violation',
  other: 'Other',
}

export const REPORT_REASONS: { value: ReportReason; label: string; category: ReportCategory }[] = [
  { value: 'spam', label: 'Spam or unwanted content', category: 'spam' },
  { value: 'harassment', label: 'Harassment or bullying', category: 'violation' },
  { value: 'illegal_content', label: 'Illegal content', category: 'legal' },
  { value: 'impersonation', label: 'Impersonation', category: 'violation' },
  { value: 'nsfw', label: 'Inappropriate/NSFW content', category: 'violation' },
  { value: 'other', label: 'Other', category: 'other' },
]

/** Same mapping as create_report's default for p_category. */
export function categoryForReason(reason: string): ReportCategory {
  return REPORT_REASONS.find((r) => r.value === reason)?.category ?? 'other'
}

export interface ReportTargetAccount {
  is_local?: boolean | null
  domain?: string | null
}

/**
 * Remote domain of a reported account, or null when it is local or unknown.
 * Only a remote account's report can be forwarded to its instance.
 */
export function remoteDomainOf(target: ReportTargetAccount | null | undefined, localDomain: string): string | null {
  if (!target) return null
  if (target.is_local === true) return null
  const domain = target.domain?.trim().toLowerCase() || null
  if (!domain || domain === localDomain.toLowerCase()) return null
  return domain
}

export type ReportAction =
  | 'investigate'
  | 'resolve'
  | 'dismiss'
  | 'reopen'
  | 'assign'
  | 'unassign'
  | 'forward'
  | 'delete_post'
  | 'mark_sensitive'
  | 'delete_message'
  | 'warn'
  | 'silence_account'
  | 'suspend_account'
  | 'force_sensitive_account'
  | 'limit_domain'
  | 'suspend_domain'

export interface ModeratorRole {
  isAdmin: boolean
  /** Instance moderator or admin. */
  isInstanceModerator: boolean
}

/** The fields of get_reports_with_details an action decision reads. */
export interface ActionableReport {
  status: string
  source: string
  reported_user_id: string | null
  reported_user_is_local: boolean
  reported_user_is_suspended?: boolean
  reported_user_is_silenced?: boolean
  reported_domain_blocked?: boolean
  reported_domain_limited?: boolean
  reported_post_id: string | null
  reported_post_is_deleted?: boolean | null
  reported_post_is_sensitive?: boolean | null
  reported_message_id: string | null
  reported_message_is_deleted?: boolean | null
  forward?: boolean
  forwarded_at?: string | null
  federation_status?: string | null
  assigned_to?: string | null
}

export function isOpenReport(status: string): boolean {
  return status === 'pending' || status === 'investigating'
}

/**
 * Actions moderate_report accepts for this caller and report. A server
 * moderator (not an instance moderator) gets the status actions, assignment
 * and message deletion only; account and domain actions need an instance admin.
 */
export function reportActionsFor(
  report: ActionableReport,
  role: ModeratorRole,
  currentProfileId?: string | null,
): ReportAction[] {
  const open = isOpenReport(report.status)
  const actions: ReportAction[] = []

  if (!open) return ['reopen']

  if (report.status === 'pending') actions.push('investigate')
  actions.push('resolve', 'dismiss')
  actions.push(report.assigned_to && report.assigned_to === currentProfileId ? 'unassign' : 'assign')

  if (report.reported_message_id && report.reported_message_is_deleted !== true) {
    actions.push('delete_message')
  }

  if (!role.isInstanceModerator) return actions

  const remoteAccount = !!report.reported_user_id && report.reported_user_is_local === false

  if (report.reported_post_id && report.reported_post_is_deleted !== true) {
    actions.push('delete_post')
    if (!report.reported_post_is_sensitive) actions.push('mark_sensitive')
  }
  if (report.reported_user_id && report.reported_user_is_local) actions.push('warn')
  if (
    remoteAccount &&
    report.source === 'local' &&
    !report.forwarded_at &&
    !['queued', 'processing'].includes(report.federation_status ?? '')
  ) {
    actions.push('forward')
  }

  if (!role.isAdmin) return actions

  if (report.reported_user_id) {
    if (!report.reported_user_is_silenced) actions.push('silence_account')
    if (!report.reported_user_is_suspended) actions.push('suspend_account')
    actions.push('force_sensitive_account')
  }
  if (remoteAccount) {
    if (!report.reported_domain_limited && !report.reported_domain_blocked) actions.push('limit_domain')
    if (!report.reported_domain_blocked) actions.push('suspend_domain')
  }
  return actions
}

/** Actions that settle the report and ask for a reason kept with the action. */
export const ACTIONS_WITH_REASON: ReadonlySet<ReportAction> = new Set<ReportAction>([
  'warn', 'silence_account', 'suspend_account', 'limit_domain', 'suspend_domain',
])

/** Actions that cannot be undone from the report. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<ReportAction> = new Set<ReportAction>([
  'delete_post', 'delete_message', 'suspend_account', 'suspend_domain',
])

export interface ReportSourceView {
  source: string
  source_instance?: string | null
}

/** "from <domain>" for a federated report, "local" otherwise. */
export function reportSourceLabel(report: ReportSourceView): string {
  if (report.source === 'federation') {
    return report.source_instance ? `from ${report.source_instance}` : 'from a remote instance'
  }
  return 'local'
}

interface SnapshotPart {
  type?: string
  text?: string
  url?: string
  username?: string
  mention?: string
  name?: string
  filename?: string
  fileType?: string
  emoji?: { name?: string }
}

function partText(part: SnapshotPart): string {
  switch (part?.type) {
    case 'text': return part.text ?? ''
    case 'url': return part.url ?? '[link]'
    case 'mention': return part.mention ?? `@${part.username ?? 'user'}`
    case 'hashtag': return `#${part.name ?? 'tag'}`
    case 'emoji': return `:${part.emoji?.name ?? 'emoji'}:`
    case 'file': return `[${part.fileType ?? 'file'}: ${part.filename ?? part.url ?? 'attachment'}]`
    default: return part?.type ? `[${part.type}]` : ''
  }
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => partText(p as SnapshotPart)).filter(Boolean).join(' ').trim()
}

export interface ReportSnapshot {
  taken_at?: string
  backfilled?: boolean
  account?: { username?: string; display_name?: string; domain?: string; is_local?: boolean }
  posts?: Array<{ id?: string; content?: unknown; content_warning?: string; ap_id?: string; url?: string; is_deleted?: boolean }>
  message?: {
    id?: string
    content?: unknown
    encrypted?: boolean
    evidence_text?: string
    evidence_source?: string
    is_deleted?: boolean
  }
  server?: { name?: string; description?: string }
}

export interface SnapshotEvidence {
  label: string
  text: string
  note?: string
}

/** Content as it stood when reported. */
export function snapshotEvidence(snapshot: ReportSnapshot | null | undefined): SnapshotEvidence[] {
  if (!snapshot) return []
  const out: SnapshotEvidence[] = []
  const note = snapshot.backfilled ? 'captured after the report was filed' : undefined
  for (const post of snapshot.posts ?? []) {
    const text = contentText(post.content)
    out.push({
      label: 'Post as reported',
      text: post.content_warning ? `CW: ${post.content_warning}\n${text}` : text,
      note,
    })
  }
  const message = snapshot.message
  if (message) {
    if (message.encrypted) {
      out.push({
        label: 'Encrypted message',
        text: message.evidence_text ?? '[ciphertext only]',
        note: message.evidence_text ? 'text supplied by the reporter, not verifiable by the server' : undefined,
      })
    } else {
      out.push({ label: 'Message as reported', text: contentText(message.content), note })
    }
  }
  if (snapshot.server) {
    out.push({ label: 'Server as reported', text: [snapshot.server.name, snapshot.server.description].filter(Boolean).join('\n') })
  }
  return out
}

/** User-facing text for a create_report failure. */
export function reportErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  switch (error?.code) {
    case 'PT429': return 'You have sent too many reports recently. Try again later.'
    case 'P0002': return 'This content is no longer available to report.'
    case '42501': return 'You cannot send reports from this account.'
    default:
      if (error?.message?.includes('Cannot report yourself')) return 'You cannot report yourself.'
      return 'The report could not be sent. Try again later.'
  }
}
