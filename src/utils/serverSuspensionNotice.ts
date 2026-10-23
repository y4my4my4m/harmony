import { i18n } from '@/i18n'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'

/**
 * Refusal of a join of a server suspended by this instance's staff: the database raises
 * 'SERVER_SUSPENDED: ...' (20261027250001), worded as the members' banner.
 */
export function suspendedServerNotice(): string {
  return i18n.global.t('hostStaff.suspendedBanner', { instance: useInstanceSettingsStore().settings.domain })
}
