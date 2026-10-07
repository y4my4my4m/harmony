/**
 * Add to Discord for the instance bot: a one-time state from discord_bridge_instance_link, then
 * bot-gateway's GET /bridge/v2/discord/authorize, which redirects to Discord's consent screen.
 */
import { isTauriRuntime } from '@/services/instanceConfig'
import { openExternalUrl } from '@/services/tauriLinks'
import { buildInstanceAuthorizeUrl, resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { createInstanceLink } from './bridgeApi'

export const discordNavigation = {
  /** The web app leaves for Discord in the same tab, so the callback lands back here; native apps open the system browser. */
  open(url: string): void {
    if (isTauriRuntime()) void openExternalUrl(url)
    else window.location.assign(url)
  },
}

export async function startInstanceLink(serverId: string): Promise<void> {
  const { state } = await createInstanceLink(serverId)
  discordNavigation.open(buildInstanceAuthorizeUrl(resolveHarmonyBaseUrl(), state))
}
