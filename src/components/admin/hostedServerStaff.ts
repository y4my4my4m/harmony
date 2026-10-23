/**
 * Wording of the instance staff actions on a server hosted here (hostStaff.* keys): every
 * confirmation names the scope, lists what happens and to whom, and says where it is recorded.
 */
import type { HostedServer, HostedServerMember, HostedServerMessage } from '@/services/HostedServerStaffService'

type Translate = (key: string, ...args: unknown[]) => string

export type StaffServerRef = Pick<HostedServer, 'id' | 'name' | 'member_count' | 'remote_member_count'>

export type StaffAction =
  | { kind: 'remove' | 'ban'; server: StaffServerRef; member: HostedServerMember }
  | { kind: 'message'; server: StaffServerRef; message: HostedServerMessage }
  | { kind: 'suspend' | 'unsuspend' | 'delete'; server: StaffServerRef }

export interface StaffActionCopy {
  title: string
  consequences: string[]
  record: string
  reasonHint: string
  confirm: string
  /** Toast once the action is done. */
  done: string
}

export function memberName(member: Pick<HostedServerMember, 'display_name' | 'username'>): string {
  return member.display_name?.trim() || member.username || '?'
}

/** @user for a local account, @user@domain for one of another instance. */
export function memberHandle(member: Pick<HostedServerMember, 'username' | 'domain' | 'is_local'>): string {
  if (!member.username) return ''
  return member.is_local || !member.domain ? `@${member.username}` : `@${member.username}@${member.domain}`
}

export function staffActionCopy(action: StaffAction, instance: string, t: Translate): StaffActionCopy {
  const server = action.server.name
  const audit = t('hostStaff.confirm.recorded', { server, instance })
  const auditHint = t('hostStaff.confirm.reasonHintAudit', { server })

  switch (action.kind) {
    case 'remove':
    case 'ban': {
      const name = memberName(action.member)
      const ban = action.kind === 'ban'
      const lines = [t(ban ? 'hostStaff.confirm.banMember.leaves' : 'hostStaff.confirm.removeMember.leaves', { name, server })]
      if (!action.member.is_local && action.member.domain) {
        lines.push(t(ban ? 'hostStaff.confirm.banMember.remote' : 'hostStaff.confirm.removeMember.remote',
          { domain: action.member.domain, instance }))
      }
      return {
        title: t(ban ? 'hostStaff.confirm.banMember.title' : 'hostStaff.confirm.removeMember.title', { name, server, instance }),
        consequences: lines,
        record: audit,
        reasonHint: auditHint,
        confirm: t(ban ? 'hostStaff.actions.banMember' : 'hostStaff.actions.removeMember'),
        done: t(ban ? 'hostStaff.done.banMember' : 'hostStaff.done.removeMember', { name, server }),
      }
    }
    case 'message':
      return {
        title: t('hostStaff.confirm.removeMessage.title', { server, instance }),
        consequences: [t('hostStaff.confirm.removeMessage.everyone', { instance })],
        record: audit,
        reasonHint: auditHint,
        confirm: t('hostStaff.actions.removeMessage'),
        done: t('hostStaff.done.removeMessage'),
      }
    case 'suspend':
      return {
        title: t('hostStaff.confirm.suspend.title', { server, instance }),
        consequences: [
          t('hostStaff.confirm.suspend.frozen'),
          t('hostStaff.confirm.suspend.banner', { banner: t('hostStaff.suspendedBanner', { instance }) }),
        ],
        record: audit,
        reasonHint: t('hostStaff.confirm.reasonHintBanner'),
        confirm: t('hostStaff.actions.suspendServer'),
        done: t('hostStaff.done.suspend', { server }),
      }
    case 'unsuspend':
      return {
        title: t('hostStaff.confirm.unsuspend.title', { server }),
        consequences: [t('hostStaff.confirm.unsuspend.open')],
        record: audit,
        reasonHint: auditHint,
        confirm: t('hostStaff.actions.unsuspendServer'),
        done: t('hostStaff.done.unsuspend', { server }),
      }
    case 'delete': {
      const count = action.server.member_count
      const lines = [
        t('hostStaff.confirm.delete.gone'),
        t('hostStaff.confirm.delete.members', { count }, count),
      ]
      if (action.server.remote_member_count > 0) lines.push(t('hostStaff.confirm.delete.remote'))
      return {
        title: t('hostStaff.confirm.delete.title', { server, instance }),
        consequences: lines,
        record: t('hostStaff.confirm.recordedInstance', { instance }),
        reasonHint: t('hostStaff.confirm.reasonHintLog', { instance }),
        confirm: t('hostStaff.actions.deleteServer'),
        done: t('hostStaff.done.delete', { server }),
      }
    }
  }
}
