/**
 * BridgeChecklist.vue and BridgeProblemList.vue: the live checklist per state, the invite
 * button, and plain-language text plus the fix for every problem code in both modes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeChecklist from '../BridgeChecklist.vue'
import BridgeProblemList from '../BridgeProblemList.vue'
import {
  APP_ID,
  HARMONY_CHANNELS,
  HEALTHY_STATUS,
  NOW,
  SNAPSHOT,
  STALE,
  healthyBridge,
  iconStub,
  installBackend,
  makeBridge,
  makeI18n,
  missingKeys,
  rpcCalls,
} from './bridgeTestKit'
import type { BridgeMode, BridgeProblem, DiscordBridgeRow } from '@/utils/discordBridgeSetup'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const global = () => ({ plugins: [makeI18n()], stubs: { Icon: iconStub } })

beforeEach(() => {
  missingKeys.length = 0
  installBackend({}, () => null)
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

function mountChecklist(bridge: DiscordBridgeRow) {
  return mount(BridgeChecklist, {
    props: { bridge, now: NOW, harmonyChannels: HARMONY_CHANNELS, harmonyUrl: 'https://harmony.example' },
    global: global(),
  })
}

const stateOf = (w: ReturnType<typeof mountChecklist>, key: string) => w.find(`[data-check="${key}"]`).attributes('data-state')

describe('BridgeChecklist', () => {
  it('waits for a self-run bridge, with help for when it never connects', () => {
    const w = mountChecklist(makeBridge())
    expect(w.find('[data-testid="check-waiting"]').text()).toContain('Run the command from step 2')
    for (const key of ['bridge', 'token', 'intents', 'invited', 'harmony']) expect(stateOf(w, key)).toBe('waiting')
    expect(w.text()).toContain('Not connecting?')
    expect(w.text()).toContain('docker logs --tail 50 harmony-discord-bridge')
  })

  it('waits for a hosted bridge with instance-side help', () => {
    const w = mountChecklist(makeBridge({ mode: 'hosted' }))
    expect(w.find('[data-testid="check-waiting"]').text()).toContain('Waiting for this instance to start your bridge')
    expect(w.text()).toContain('Contact the instance')
    expect(w.text()).not.toContain('docker')
  })

  it('shows every item green for a healthy bridge', () => {
    const w = mountChecklist(healthyBridge())
    for (const key of ['bridge', 'token', 'intents', 'invited', 'harmony']) expect(stateOf(w, key)).toBe('ok')
    expect(w.find('[data-check="bridge"]').text()).toContain('Bridge connected')
    expect(w.find('[data-testid="bridge-problems"]').exists()).toBe(false)
  })

  it('offers the invite button when the bot is in no guild', () => {
    const w = mountChecklist(healthyBridge({ snapshot: { guilds: [] } }))
    expect(stateOf(w, 'invited')).toBe('fail')
    const invite = w.find('[data-testid="invite-bot"]')
    const url = new URL(invite.attributes('href')!)
    expect(url.searchParams.get('client_id')).toBe(APP_ID)
    expect(url.searchParams.get('scope')).toBe('bot applications.commands')
    expect(url.searchParams.get('permissions')).toBe('536988736')
    expect(invite.text()).toBe('Invite the bot to your Discord server')
    expect(w.find('[data-code="no_guild"]').exists()).toBe(true)
    expect(w.find('[data-testid="problem-invite"]').exists()).toBe(false)
  })

  it('reports the offline bridge', () => {
    const w = mountChecklist(healthyBridge({ last_seen_at: STALE }))
    expect(stateOf(w, 'bridge')).toBe('fail')
    expect(w.find('[data-code="bridge_offline"]').text()).toContain('docker start harmony-discord-bridge')
  })

  it('forwards "go" requests from a problem', async () => {
    const w = mountChecklist(healthyBridge({ status: { ...HEALTHY_STATUS, problems: [{ code: 'discord_token_invalid' }] } }))
    await w.find('[data-testid="problem-go-connect"]').trigger('click')
    expect(w.emitted('go')).toEqual([['connect']])
  })
})

/** Rendered title and fix for each contract problem code, in each mode. */
const CASES: [string, Record<string, string>, BridgeMode, string, string][] = [
  ['discord_token_invalid', {}, 'self', 'Discord rejected the bot token.', 'docker rm -f harmony-discord-bridge'],
  ['discord_token_invalid', {}, 'hosted', 'Discord rejected the bot token.', 'save it here'],
  ['intent_missing', { intent: 'message_content' }, 'self', 'Discord refused the Message Content Intent.', 'docker restart harmony-discord-bridge'],
  ['intent_missing', { intent: 'members' }, 'hosted', 'Discord refused the Server Members Intent.', 'picks it up when it reconnects'],
  ['intent_missing', { intent: 'presence' }, 'self', 'Discord refused the Presence Intent.', 'Privileged Gateway Intents'],
  ['bot_not_in_guild', { guild_id: '900' }, 'self', "The bot isn't in Town Square.", 'choose another Discord server'],
  ['no_guild', {}, 'hosted', "The bot isn't in any Discord server yet.", 'Manage Server permission'],
  ['guild_not_selected', {}, 'self', 'No Discord server chosen yet.', 'Choose which Discord server to bridge.'],
  ['channel_not_visible', { discord_channel_id: '12' }, 'self', "The bot can't see #secret.", 'View Channel and Read Message History'],
  ['cannot_send', { discord_channel_id: '11' }, 'hosted', "The bot can't post in #general.", 'allow Send Messages'],
  ['cannot_manage_webhooks', { discord_channel_id: '13' }, 'self', "The bot can't manage webhooks in #announcements.", 'allow Manage Webhooks'],
  ['harmony_auth_failed', {}, 'self', 'The bridge can no longer sign in to Harmony.', 'docker volume rm harmony-bridge-data'],
  ['harmony_auth_failed', {}, 'hosted', 'The bridge can no longer sign in to Harmony.', "Contact the instance's admin"],
  ['harmony_channel_missing', { harmony_channel_id: 'gone' }, 'self', 'A paired Harmony channel no longer exists.', 'Remove its pair'],
  ['harmony_channel_encrypted', { harmony_channel_id: 'h-news' }, 'self', '#news is end-to-end encrypted', 'without end-to-end encryption'],
  ['rate_limited', {}, 'self', 'Discord is slowing the bridge down.', 'delayed, not lost'],
  ['discord_unreachable', {}, 'self', "The bridge can't reach Discord.", 'computer running the bridge is online'],
  ['discord_unreachable', {}, 'hosted', "The bridge can't reach Discord.", 'keeps retrying'],
  ['harmony_unreachable', {}, 'self', "The bridge can't reach this Harmony instance.", 'can open https://harmony.example'],
  ['harmony_unreachable', {}, 'hosted', "The bridge can't reach this Harmony instance.", "instance's side"],
  ['bridge_offline', {}, 'hosted', 'The bridge is offline.', "isn't running your bridge right now"],
  ['brand_new_code', {}, 'self', 'The bridge reported a problem (brand_new_code).', 'docker logs'],
  ['brand_new_code', {}, 'hosted', 'The bridge reported a problem (brand_new_code).', 'contact the instance'],
]

describe('BridgeProblemList', () => {
  function mountProblems(problems: BridgeProblem[], bridge: DiscordBridgeRow) {
    return mount(BridgeProblemList, {
      props: { bridge, problems, harmonyChannels: HARMONY_CHANNELS, harmonyUrl: 'https://harmony.example' },
      global: global(),
    })
  }

  it.each(CASES)('%s %j (%s) says what is wrong and how to fix it', (code, params, mode, title, fix) => {
    const w = mountProblems([{ code, params }], healthyBridge({ mode, snapshot: SNAPSHOT }))
    const item = w.find(`[data-code="${code}"]`)
    expect(item.find('.problem-title').text()).toContain(title)
    expect(item.text()).toContain(fix)
    if (mode === 'hosted') expect(item.findAll('pre')).toHaveLength(0)
  })

  it('links the Developer Portal and offers to turn off the setting behind an optional intent', async () => {
    const w = mountProblems([{ code: 'intent_missing', params: { intent: 'members' } }], healthyBridge())
    expect(w.find('a[href="https://discord.com/developers/applications"]').exists()).toBe(true)
    await w.find('[data-testid="turn-off-sync_member_list"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_update_settings')).toEqual([
      {
        p_bridge_id: 'b1',
        p_settings: { sync_member_list: false, sync_presence: false, sync_reactions: true, sync_edits: true, sync_deletes: true },
      },
    ])
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('does not offer to turn off Message Content', () => {
    const w = mountProblems([{ code: 'intent_missing', params: { intent: 'message_content' } }], healthyBridge())
    expect(w.find('[data-testid^="turn-off-"]').exists()).toBe(false)
  })

  it('shows the invite button for a bot outside the chosen guild', () => {
    const w = mountProblems([{ code: 'bot_not_in_guild', params: { guild_id: '900' } }], healthyBridge())
    expect(w.find('[data-testid="problem-invite"]').attributes('href')).toContain(`client_id=${APP_ID}`)
    expect(w.find('[data-testid="problem-go-guild"]').text()).toBe('Choose the Discord server')
  })

  it('labels the token action by mode', () => {
    const self = mountProblems([{ code: 'discord_token_invalid', params: {} }], healthyBridge())
    expect(self.find('[data-testid="problem-go-connect"]').text()).toBe('Show the setup command')
    const hosted = mountProblems([{ code: 'discord_token_invalid', params: {} }], healthyBridge({ mode: 'hosted' }))
    expect(hosted.find('[data-testid="problem-go-connect"]').text()).toBe('Replace the token')
  })

  it('marks webhook and rate-limit problems as warnings', () => {
    const w = mountProblems(
      [
        { code: 'cannot_manage_webhooks', params: { discord_channel_id: '11' } },
        { code: 'cannot_send', params: { discord_channel_id: '11' } },
      ],
      healthyBridge(),
    )
    const items = w.findAll('.problem')
    expect(items[0].classes()).toContain('problem--warn')
    expect(items[1].classes()).toContain('problem--error')
  })
})
