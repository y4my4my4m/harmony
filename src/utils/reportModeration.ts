/**
 * Report categories, forwarding eligibility and the moderator actions a report
 * offers. The database enforces the same rules (create_report, moderate_report);
 * this decides what the UI shows.
 */

import { i18n } from '@/i18n'
import { isPrivateMediaPart, messageMediaReferenceUrl } from '@/services/privateMedia'

export type ReportCategory = 'spam' | 'legal' | 'violation' | 'other'

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'illegal_content'
  | 'impersonation'
  | 'nsfw'
  | 'other'

const t = (key: string, named?: Record<string, unknown>) =>
  named ? i18n.global.t(key, named) : i18n.global.t(key)

/** Mastodon's report categories. */
export const REPORT_CATEGORIES: readonly ReportCategory[] = ['spam', 'legal', 'violation', 'other']

export function reportCategoryLabel(category: string): string {
  return (REPORT_CATEGORIES as readonly string[]).includes(category)
    ? t(`moderation.reportCategories.${category}`)
    : category
}

export interface ReportReasonOption {
  value: ReportReason
  readonly label: string
  category: ReportCategory
}

/** label resolves at read time; locale messages load asynchronously. */
function reasonOption(value: ReportReason, category: ReportCategory): ReportReasonOption {
  return {
    value,
    category,
    get label() { return t(`moderation.reportReasons.${value}`) },
  }
}

export const REPORT_REASONS: ReportReasonOption[] = [
  reasonOption('spam', 'spam'),
  reasonOption('harassment', 'violation'),
  reasonOption('illegal_content', 'legal'),
  reasonOption('impersonation', 'violation'),
  reasonOption('nsfw', 'violation'),
  reasonOption('other', 'other'),
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

  // Instance staff accounts refuse a moderator's account action server-side (moderate_report).
  if (report.reported_user_id) {
    if (!report.reported_user_is_silenced) actions.push('silence_account')
    if (!report.reported_user_is_suspended) actions.push('suspend_account')
    actions.push('force_sensitive_account')
  }

  if (!role.isAdmin) return actions

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
    return report.source_instance
      ? t('moderation.reportSource.fromInstance', { domain: report.source_instance })
      : t('moderation.reportSource.fromRemote')
  }
  return t('moderation.reportSource.local')
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
  path?: string
  emoji?: { name?: string }
}

function partText(part: SnapshotPart): string {
  switch (part?.type) {
    case 'text': return part.text ?? ''
    case 'url': return part.url ?? '[link]'
    case 'mention': return part.mention ?? `@${part.username ?? 'user'}`
    case 'hashtag': return `#${part.name ?? 'tag'}`
    case 'emoji': return `:${part.emoji?.name ?? 'emoji'}:`
    // A private attachment links by reference; ReportsModeration signs it on display.
    case 'file': return `[${part.fileType ?? 'file'}: ${
      isPrivateMediaPart(part) ? messageMediaReferenceUrl(part.path) : (part.filename ?? part.url ?? 'attachment')}]`
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
  const note = snapshot.backfilled ? t('moderation.evidence.backfilledNote') : undefined
  for (const post of snapshot.posts ?? []) {
    const text = contentText(post.content)
    out.push({
      label: t('moderation.evidence.post'),
      text: post.content_warning
        ? `${t('moderation.evidence.contentWarning', { warning: post.content_warning })}\n${text}`
        : text,
      note,
    })
  }
  const message = snapshot.message
  if (message) {
    if (message.encrypted) {
      out.push({
        label: t('moderation.evidence.encryptedMessage'),
        text: message.evidence_text ?? t('moderation.evidence.ciphertextOnly'),
        note: message.evidence_text ? t('moderation.evidence.reporterSuppliedNote') : undefined,
      })
    } else {
      out.push({ label: t('moderation.evidence.message'), text: contentText(message.content), note })
    }
  }
  if (snapshot.server) {
    out.push({ label: t('moderation.evidence.server'), text: [snapshot.server.name, snapshot.server.description].filter(Boolean).join('\n') })
  }
  return out
}

/** User-facing text for a create_report failure. */
export function reportErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  switch (error?.code) {
    case 'PT429': return t('moderation.reportErrors.rateLimited')
    case 'P0002': return t('moderation.reportErrors.unavailable')
    case '42501': return t('moderation.reportErrors.forbidden')
    default:
      if (error?.message?.includes('Cannot report yourself')) return t('moderation.reportErrors.self')
      return t('moderation.reportErrors.failed')
  }
}
