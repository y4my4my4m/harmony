/** MatrixStatusView.vue, MatrixSetupStepper.vue, MatrixChecklist.vue and MatrixProblemList.vue. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { forgetIssuedSetupCodes } from '../../discord-bridge/bridgeApi'
import { HARMONY_CHANNELS, NOW, STALE, iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import MatrixSetupStepper from '../MatrixSetupStepper.vue'
import MatrixStatusView from '../MatrixStatusView.vue'
import { forgetMatrixConnectFields } from '../MatrixConnectSelf.vue'
import { ACCOUNT, BRIDGE_ID, READY_STATUS, parsed, rawPair, rawReady, rawState } from './matrixTestKit'

vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

const PrivacyPanel = { name: 'BridgePrivacyPanel', props: ['serverId', 'platform'], template: '<div class="privacy-stub" />' }
let w: VueWrapper
const props = (raw: Record<string, unknown>) => ({
  bridge: parsed(raw), harmonyChannels: HARMONY_CHANNELS, encryptedChannelIds: [], now: NOW, harmonyUrl: 'https://harmony.example',
})
const global = () => ({ plugins: [makeI18n()], stubs: { Icon: iconStub, BridgePrivacyPanel: PrivacyPanel } })
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const step = () => w.find('.step-panel').attributes('data-step')
const openStepper = (raw: Record<string, unknown>) => { w = mount(MatrixSetupStepper, { props: props(raw), attachTo: document.body, global: global() }) }
const openStatus = (raw: Record<string, unknown>) => { w = mount(MatrixStatusView, { props: props(raw), attachTo: document.body, global: global() }) }
const withProblems = (...problems: { code: string; detail?: string }[]) => rawReady({ status: { ...READY_STATUS, problems } })

beforeEach(() => {
  missingKeys.length = 0
  localStorage.clear()
  forgetIssuedSetupCodes()
  forgetMatrixConnectFields()
  installBackend({}, (name) => (name === 'matrix_bridge_setup_code' ? { code: 'MX-AAAA-BBBB-CCCC' } : null))
})
afterEach(() => {
  w?.unmount()
  expect(missingKeys).toEqual([])
})

describe('MatrixSetupStepper', () => {
  it('starts at the command, waits for the bridge, and follows it to the pairs', async () => {
    openStepper(rawState())
    await flushPromises()
    expect(step()).toBe('connect')
    expect(w.findAll('.step-link').map((b) => b.attributes('aria-label'))).toEqual(['Step 1: Start the bridge', 'Step 2: Check the connection', 'Step 3: Pair channels'])
    expect(byTest('nav-channels').attributes('disabled')).toBeDefined()
    expect(byTest('step-next').text()).toBe('I ran the command')
    await byTest('step-next').trigger('click')
    await flushPromises()
    expect(step()).toBe('check')
    expect(document.activeElement?.textContent?.trim()).toBe('Check the connection')
    expect(byTest('check-waiting').attributes('role')).toBe('status')
    expect(byTest('check-waiting').text()).toContain('Run the command from step 1')
    expect(byTest('step-next').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('docker logs --tail 50 harmony-matrix-bridge')

    await w.setProps({ bridge: parsed(rawReady({ status: { ...READY_STATUS, ready: false } })) })
    expect(w.findAll('[data-check]').map((c) => [c.attributes('data-check'), c.attributes('data-state')])).toEqual([
      ['bridge', 'ok'], ['matrix', 'waiting'], ['harmony', 'waiting'],
    ])
    await w.setProps({ bridge: parsed(rawReady()) })
    await flushPromises()
    expect(step()).toBe('channels')
    expect(byTest('step-finish').attributes('disabled')).toBeDefined()
    expect(byTest('next-hint').text()).toBe('Pair at least one channel to continue.')
    await w.setProps({ bridge: parsed(rawReady({ pairs: [rawPair()] })) })
    expect(step()).toBe('channels')
    await byTest('step-finish').trigger('click')
    expect(w.emitted('finish')).toHaveLength(1)
  })

  it('resumes at the checklist for a returning manager', async () => {
    openStepper(rawState())
    await byTest('step-next').trigger('click')
    w.unmount()
    openStepper(rawState())
    expect(step()).toBe('check')
  })

  it('stays on the checklist with the registration missing, and shows how to fix it', async () => {
    openStepper(rawReady({ status: { ...READY_STATUS, ready: false, problems: [{ code: 'matrix_registration_missing' }] } }))
    expect(step()).toBe('check')
    expect(w.find('[data-check="matrix"]').attributes('data-state')).toBe('fail')
    expect(w.find('[data-check="matrix"]').text()).toContain("The bridge can't sign in to the homeserver")
    const problem = w.find('[data-code="matrix_registration_missing"]')
    expect(problem.text()).toContain("The homeserver doesn't know the bridge yet.")
    expect(problem.find('pre').text()).toBe('docker cp harmony-matrix-bridge:/data/registration.json .')
    await problem.find('[data-testid="problem-go-connect"]').trigger('click')
    await flushPromises()
    expect(step()).toBe('connect')
  })

  it('keeps the pairing step when the bridge goes silent', async () => {
    openStepper(rawReady())
    expect(step()).toBe('channels')
    await w.setProps({ now: NOW + 200_000 })
    expect(step()).toBe('channels')
  })

  it('takes a hosted bridge from its account to the checks and the pairs, waiting on the instance', async () => {
    openStepper(rawState({ mode: 'hosted' }))
    expect(w.findAll('.step-link').map((b) => b.attributes('aria-label'))).toEqual(['Step 1: Sign in to Matrix', 'Step 2: Check the connection', 'Step 3: Pair channels'])
    expect(byTest('next-hint').text()).toBe('Sign in with a Matrix account to continue.')
    await w.setProps({ bridge: parsed(rawState({ mode: 'hosted', has_account: true, homeserver_url: 'https://example.org' })) })
    await flushPromises()
    expect(step()).toBe('check')
    expect(byTest('check-waiting').text()).toBe('Waiting for this instance to start your bridge. This usually takes a minute or two.')
    expect(byTest('matrix-host-help').text()).toContain('Check that you signed in with the account in step 1.')
    expect(byTest('matrix-host-help').text()).toContain("this instance's bridge service may be down")
    expect(w.text()).not.toContain('docker')
    await w.setProps({ bridge: parsed(rawReady({ mode: 'hosted', has_account: true, connection: 'account' })) })
    await flushPromises()
    expect(step()).toBe('channels')
    expect(byTest('select-room').exists()).toBe(true)
    expect(byTest('select-mode').exists()).toBe(false)
  })

  it('waits again after another account is saved, without the old rooms', async () => {
    openStepper(rawReady({ mode: 'hosted', has_account: true, connection: 'account' }))
    expect(step()).toBe('channels')
    await byTest('nav-connect').trigger('click')
    await flushPromises()
    expect((byTest('matrix-hosted-homeserver').element as HTMLInputElement).value).toBe('')
    // matrix_bridge_set_account with another homeserver forgets status and snapshot.
    w.getComponent({ name: 'MatrixConnectHosted' }).vm.$emit('saved', parsed(rawState({ mode: 'hosted', has_account: true, connection: 'account', last_seen_at: STALE })))
    await flushPromises()
    expect(step()).toBe('check')
    expect(w.emitted('state')).toHaveLength(1)
  })

  it('has the checks and the pairs alone for the bridge of the instance', async () => {
    openStepper(rawState({ mode: 'instance' }))
    expect(step()).toBe('check')
    expect(byTest('step-back').exists()).toBe(false)
    expect(byTest('matrix-host-help').findAll('li')).toHaveLength(1)
    await w.setProps({ bridge: parsed(rawReady({ mode: 'instance' })) })
    await flushPromises()
    expect(step()).toBe('channels')
    expect(byTest('matrix-room-code').exists()).toBe(true)
  })

  it('offers to start over', async () => {
    openStepper(rawState())
    await byTest('start-over').trigger('click')
    expect(w.emitted('start-over')).toHaveLength(1)
  })
})

describe('MatrixStatusView', () => {
  it('shows a connected bridge: account, homeserver, version, pairs and the Matrix privacy panel', () => {
    openStatus(rawReady({ pairs: [rawPair()] }))
    expect(byTest('matrix-managed-status').attributes('data-state')).toBe('online')
    expect(byTest('status-title').text()).toBe('Bridge is online')
    expect(byTest('status-seen').text()).toBe('Last heard from 10 seconds ago.')
    expect(byTest('status-account').text()).toBe(ACCOUNT)
    expect(byTest('status-homeserver').text()).toBe('example.org')
    expect(byTest('status-connection').text()).toBe('Application service')
    expect(byTest('status-version').text()).toBe('0.2.0')
    expect(byTest('status-pending').exists()).toBe(false)
    expect(byTest('bridge-problems').exists()).toBe(false)
    expect(w.findAll('[data-testid="matrix-managed-pair"]')).toHaveLength(1)
    expect(w.getComponent(PrivacyPanel).props()).toEqual({ serverId: 's1', platform: 'matrix' })
  })

  it('reads a bridge silent for 90 s as offline, with how to start it', () => {
    openStatus(rawReady({ last_seen_at: STALE, pairs: [rawPair()] }))
    expect(byTest('status-title').text()).toBe('Bridge is offline')
    expect(byTest('status-seen').text()).toBe('Last heard from 3 hours ago.')
    expect(w.find('[data-code="bridge_offline"]').text()).toContain('docker start harmony-matrix-bridge')
  })

  it('shows a bridge that is not ready yet as connecting, and counts waiting and failed messages', () => {
    openStatus(rawReady({ status: { ...READY_STATUS, ready: false, pending: 3, failed: 2 }, pairs: [rawPair()] }))
    expect(byTest('status-title').text()).toBe('Bridge is connecting to Matrix')
    expect(byTest('status-pending').text()).toBe('3')
    expect(byTest('status-failed').text()).toBe('2')
  })

  it.each([
    ['matrix_unreachable', '', "The bridge can't reach the homeserver.", 'can open https://matrix.example.org'],
    ['matrix_token_invalid', '', "The homeserver rejected the bridge's sign-in.", 'registration.json again'],
    ['harmony_auth_failed', '', 'The bridge can no longer sign in to Harmony.', 'with a new setup code. Its data stays.'],
    ['harmony_unreachable', '', "The bridge can't reach this Harmony instance.", 'can open https://harmony.example'],
    ['room_encrypted', '!secret:example.org', "The bridge doesn't relay Secret: it is end-to-end encrypted.", 'Remove its pair'],
    ['room_not_joined', '#gone:example.org', "The bridge isn't in #gone:example.org.", "Invite the bridge's account"],
    ['room_not_joined', '', "The bridge isn't in a room.", "Invite the bridge's account"],
    ['worker_stopped', 'SQLITE_FULL', "The bridge stopped relaying: it can't write its data.", 'SQLITE_FULL'],
    ['brand_new', 'Something only the bridge knows', 'The bridge reported a problem (brand_new).', 'Something only the bridge knows'],
  ])('explains %s %s', (code, detail, title, fix) => {
    openStatus(withProblems({ code, detail }))
    const problem = w.find(`[data-code="${code}"]`)
    expect(problem.classes()).toContain('problem--error')
    expect(problem.find('.problem-title').text()).toBe(title)
    expect(problem.text()).toContain(fix)
    expect(byTest('status-title').text()).toBe('Bridge is online, with problems')
    expect(w.text()).toContain('1 problem to fix')
  })

  it.each([
    ['hosted', 'matrix_token_invalid', 'Sign in with the account again here', 'Replace the Matrix account'],
    ['hosted', 'account_in_use', 'Use an account made for this bridge alone.', 'Replace the Matrix account'],
    ['hosted', 'matrix_unreachable', 'can be reached from the internet', null],
    ['hosted', 'harmony_auth_failed', "This is on the instance's side.", null],
    ['hosted', 'worker_stopped', "contact the instance's admin", null],
    ['hosted', 'brand_new', "contact the instance's admin", null],
    ['instance', 'matrix_registration_missing', "This is on the instance's side", null],
    ['instance', 'matrix_token_invalid', "This is on the instance's side", null],
    ['instance', 'matrix_unreachable', "This is on the instance's side", null],
    ['instance', 'worker_stopped', "contact the instance's admin", null],
    ['instance', 'room_not_joined', "Invite the bridge's account", 'Go to paired channels'],
  ])('leaves nobody a computer to turn to: %s %s', (mode, code, fix, action) => {
    openStatus(rawReady({ mode, has_account: mode === 'hosted', status: { ...READY_STATUS, problems: [{ code }] } }))
    const problem = w.find(`[data-code="${code}"]`)
    expect(problem.text()).toContain(fix)
    expect(problem.find('pre').exists()).toBe(false)
    expect(problem.findAll('button').map((b) => b.text())).toEqual(action ? [action] : [])
    expect(w.text()).not.toContain('docker')
  })

  it.each([
    ['self', 'Get a new access token'],
    ['hosted', 'Sign in with the account again here'],
  ])('says how the token of an account is renewed: %s', (mode, fix) => {
    openStatus(rawReady({ mode, connection: 'account', has_account: true, status: { ...READY_STATUS, problems: [{ code: 'matrix_token_invalid' }] } }))
    expect(w.find('[data-code="matrix_token_invalid"]').text()).toContain(fix)
    expect(w.find('[data-code="matrix_token_invalid"]').text()).not.toContain('registration')
  })

  it('names the homeserver entered while the bridge reports none', () => {
    openStatus(rawReady({ mode: 'hosted', has_account: true, homeserver_url: 'https://entered.example', status: { ...READY_STATUS, homeserver: null, problems: [{ code: 'matrix_unreachable' }] } }))
    expect(w.find('[data-code="matrix_unreachable"]').text()).toContain('https://entered.example')
  })

  it.each(['hosted', 'instance'])('reads a silent %s bridge as offline, on the instance to fix', (mode) => {
    openStatus(rawReady({ mode, last_seen_at: STALE }))
    expect(byTest('status-title').text()).toBe('Bridge is offline')
    expect(w.find('[data-code="bridge_offline"]').text()).toContain("This instance isn't running your bridge right now.")
    expect(w.find('[data-code="bridge_offline"] pre').exists()).toBe(false)
  })

  it('names how each runs, and what disconnecting leaves', async () => {
    openStatus(rawReady({ mode: 'hosted', has_account: true, connection: 'account', homeserver_url: 'https://example.org' }))
    expect(byTest('status-mode').text()).toBe('On this instance')
    expect(byTest('disconnect-body').text()).toContain('The stored access token is deleted.')
    expect(byTest('matrix-maintain').find('summary').text()).toBe('Replace the Matrix account')
    const details = byTest('matrix-maintain')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    expect((byTest('matrix-hosted-homeserver').element as HTMLInputElement).value).toBe('https://example.org')
    expect(byTest('matrix-connect-self').exists()).toBe(false)
    w.getComponent({ name: 'MatrixConnectHosted' }).vm.$emit('saved', parsed(rawState({ mode: 'hosted' })))
    expect(w.emitted('state')).toEqual([[parsed(rawState({ mode: 'hosted' }))]])
    w.unmount()
    openStatus(rawReady({ mode: 'instance' }))
    expect(byTest('status-mode').text()).toBe("With this instance's Matrix bridge")
    expect(byTest('disconnect-body').text()).toContain('leaves the rooms by itself')
    expect(byTest('matrix-maintain').exists()).toBe(false)
  })

  it('shows skipped messages as a note', () => {
    openStatus(withProblems({ code: 'messages_skipped', detail: '12 messages of !general:example.org' }))
    const note = w.find('[data-code="messages_skipped"]')
    expect(note.classes()).toContain('problem--info')
    expect(note.text()).toContain('12 messages of')
    expect(byTest('status-title').text()).toBe('Bridge is online')
    expect(w.text()).toContain('1 note')
  })

  it('renders the bridge\'s own words as text', () => {
    openStatus(withProblems({ code: 'x', detail: '<b>bold</b>' }))
    expect(w.find('b').exists()).toBe(false)
    expect(w.text()).toContain('<b>bold</b>')
  })

  it('opens the commands without issuing a code up front, from a problem too', async () => {
    openStatus(withProblems({ code: 'harmony_auth_failed' }))
    expect(byTest('matrix-connect-self').exists()).toBe(false)
    await w.find('[data-testid="problem-go-connect"]').trigger('click')
    await flushPromises()
    expect(document.activeElement?.tagName).toBe('SUMMARY')
    const details = byTest('matrix-maintain')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    expect(rpcCalls('matrix_bridge_setup_code')).toEqual([])
    await byTest('issue-code').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_setup_code')).toEqual([{ p_bridge_id: BRIDGE_ID }])
  })

  it('names what is left to take out: the registration, or the session of an account', async () => {
    openStatus(rawReady({ pairs: [rawPair()] }))
    expect(byTest('disconnect-body').text()).toContain("bridge's registration out")
    await w.setProps({ bridge: parsed(rawReady({ connection: 'account', pairs: [rawPair()] })) })
    expect(byTest('disconnect-body').text()).not.toContain('registration')
    expect(byTest('disconnect-body').text()).toContain('End the session “Harmony bridge”')
    expect(byTest('status-connection').text()).toBe('Matrix account')
  })

  it('asks the parent to disconnect and to show the setup steps', async () => {
    openStatus(rawReady({ pairs: [rawPair()] }))
    await byTest('disconnect').trigger('click')
    await byTest('show-setup').trigger('click')
    expect(w.emitted('delete')).toHaveLength(1)
    expect(w.emitted('show-setup')).toHaveLength(1)
  })
})
