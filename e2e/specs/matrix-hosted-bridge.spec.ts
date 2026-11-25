// Journey: a manager lets the instance run a Matrix bridge with a Matrix account of the community's
// own. The homeserver is played by Playwright routes (.well-known, the sign-in flows, sign-in,
// whoami, logout); the bridge host by the service role, which reads what
// GET /bridge/v2/matrix/host would and reports the bridge's status. The tab shows the choice once
// the instance offers it, says who can read the rooms and where the password goes, explains a wrong
// password, a limit, a homeserver without a password sign-in and one that cannot be reached, signs
// in, waits for the host, pairs a room through the account, replaces the account and waits again. The
// password reaches the homeserver alone and the token is in no page or answer.

import { test, expect, type Page, type Request, type Route } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
const PASSWORD = 'correct-horse-battery-staple'
const WRONG = 'not-the-password'
const TOKEN = 'syt_e2e_access_token'
const NAME = 'community.e2e.example'
const CLIENT_API = 'https://matrix.e2e.example'
let owner: SpecUser
let server: SeededServer
let hostingBefore: unknown

const setConfig = async (key: string, value: unknown) => {
  const { error } = await admin.from('instance_config').upsert({ config_key: key, config_value: value }, { onConflict: 'config_key' })
  if (error) throw new Error(`${key}: ${error.message}`)
}

/** As GET /bridge/v2/matrix/host answers the bridge host. */
async function hosted() {
  const { data, error } = await admin.rpc('matrix_bridge_hosted_list')
  if (error) throw new Error(`hosted: ${error.message}`)
  const bridge = await bridgeRow()
  return (data as { bridge_id: string; harmony_token: string; homeserver_url: string; access_token: string }[]).find((row) => row.bridge_id === bridge.id)
}

async function bridgeRow() {
  const { data, error } = await admin.from('matrix_bridges').select('id, bot_id, mode').eq('server_id', server.id).single()
  if (error) throw new Error(`bridge: ${error.message}`)
  return data as { id: string; bot_id: string; mode: string }
}

async function report(userId: string, rooms: unknown[], pairs: unknown[] = [], problems: unknown[] = []) {
  const { error } = await admin.rpc('matrix_bridge_report_status', {
    p_bot_id: (await bridgeRow()).bot_id,
    p_connection: 'account',
    p_status: { ready: problems.length === 0, user_id: userId, homeserver: CLIENT_API, server_name: NAME, pending: 0, failed: 0, problems },
    p_snapshot: { rooms },
    p_version: '0.3.0',
    p_pairs: pairs,
  })
  if (error) throw new Error(`report: ${error.message}`)
}

type Answer = { status?: number; json: unknown }
/** Answers of the homeserver by 'METHOD path'; a path without one is refused as a dead host is. */
async function playHomeserver(page: Page, answers: Record<string, Answer | ((request: Request) => Answer)>) {
  const seen: string[] = []
  const handle = async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const key = `${request.method()} ${url.origin}${url.pathname}`
    seen.push(key)
    const answer = answers[key]
    if (!answer) return route.abort('connectionrefused')
    const { status = 200, json } = typeof answer === 'function' ? answer(request) : answer
    await route.fulfill({ status, json, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
  }
  await page.route(`https://${NAME}/**`, handle)
  await page.route(`${CLIENT_API}/**`, handle)
  return seen
}

async function openMatrixTab(page: Page) {
  await page.goto(`/server/${server.id}?section=bridges&tab=matrix`)
  await dismissAnnouncements(page)
  const panel = page.getByTestId('bridges-panel-matrix')
  await expect(panel.getByTestId('matrix-bridge')).toBeVisible({ timeout: 30000 })
  return panel
}

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeAll(async () => {
  owner = await createUser(admin, 'mxhosted')
  server = await seedServer(admin, owner, `Hosted ${owner.username.slice(-6)}`)
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'matrix_bridge_hosting_enabled').maybeSingle()
  hostingBefore = data?.config_value ?? false
  await setConfig('matrix_bridge_hosting_enabled', false)
})

test.afterAll(async () => {
  await setConfig('matrix_bridge_hosting_enabled', hostingBefore)
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
})

test('a community signs in with its own Matrix account, and the instance runs the bridge', async ({ page }) => {
  test.setTimeout(180_000)
  let wellKnown: Answer = { json: { 'm.homeserver': { base_url: CLIENT_API } } }
  let flows: Answer = { json: { flows: [{ type: 'm.login.sso' }, { type: 'm.login.password' }] } }
  let login: (request: Request) => Answer = () => ({ status: 403, json: { errcode: 'M_FORBIDDEN', error: 'Invalid username or password' } })
  const loginBodies: Record<string, unknown>[] = []
  const seen = await playHomeserver(page, {
    [`GET https://${NAME}/.well-known/matrix/client`]: () => wellKnown,
    [`GET ${CLIENT_API}/_matrix/client/v3/login`]: () => flows,
    [`POST ${CLIENT_API}/_matrix/client/v3/login`]: (request) => {
      loginBodies.push(request.postDataJSON())
      return login(request)
    },
    [`GET ${CLIENT_API}/_matrix/client/v3/account/whoami`]: (request) =>
      request.headers().authorization === 'Bearer syt_pasted_access_token'
        ? { json: { user_id: `@second:${NAME}` } }
        : { status: 401, json: { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' } },
  })
  // Every request that carries the password or the token, by origin.
  const carried: { origin: string; path: string; secret: string }[] = []
  page.on('request', (request) => {
    const text = `${request.url()} ${request.postData() ?? ''}`
    for (const secret of [PASSWORD, WRONG, TOKEN]) {
      if (text.includes(secret)) carried.push({ origin: new URL(request.url()).origin, path: new URL(request.url()).pathname, secret })
    }
  })
  const logged: string[] = []
  page.on('console', (message) => logged.push(message.text()))

  await signIn(page, owner)
  let panel = await openMatrixTab(page)

  await test.step('the choice appears once the instance offers it', async () => {
    await expect(panel.getByTestId('mode-hosted')).toHaveCount(0)
    await setConfig('matrix_bridge_hosting_enabled', true)
    await page.reload()
    await expect(panel.getByTestId('mode-hosted')).toContainText('can read every room the account is in', { timeout: 30000 })
    await panel.getByRole('button', { name: 'Use my own account here' }).click()
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'connect')
    expect((await bridgeRow()).mode).toBe('hosted')
  })

  await test.step('the step says who can read the rooms and that Harmony never gets the password', async () => {
    await expect(panel.getByTestId('matrix-hosted-access')).toContainText("This instance's operator holds the account's access token")
    await expect(panel.getByTestId('matrix-hosted-access')).toContainText('Use an account made for the bridge')
    await expect(panel.getByTestId('matrix-hosted-password-help')).toHaveText(
      "The password goes from your browser to the homeserver alone. Harmony never gets it, and it isn't kept.",
    )
    await expect(panel.getByTestId('step-next')).toBeDisabled()
  })

  const form = panel.getByTestId('matrix-connect-hosted')
  const issue = panel.getByTestId('matrix-hosted-issue')

  await test.step('a homeserver that cannot be reached and a wrong password are explained', async () => {
    await form.getByLabel('Homeserver').fill('nowhere.e2e.example')
    await page.route('https://nowhere.e2e.example/**', (route) => route.abort('namenotresolved'))
    await form.getByLabel('User name').fill('bridge')
    await form.getByLabel('Password', { exact: true }).fill(WRONG)
    await form.getByRole('button', { name: 'Sign in' }).click()
    await expect(issue).toHaveAttribute('data-issue', 'unreachable')
    await form.getByLabel('Homeserver').fill(NAME)
    await form.getByLabel('Password', { exact: true }).fill(WRONG)
    await form.getByRole('button', { name: 'Sign in' }).click()
    await expect(issue).toHaveText('The homeserver refused the user name or the password.')
    await expect(form.getByLabel('Password', { exact: true })).toHaveValue('')
    expect(seen).toEqual([
      `GET https://${NAME}/.well-known/matrix/client`,
      `GET ${CLIENT_API}/_matrix/client/v3/login`,
      `POST ${CLIENT_API}/_matrix/client/v3/login`,
    ])
  })

  await test.step('so is a limit', async () => {
    login = () => ({ status: 429, json: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 30_000 } })
    await form.getByLabel('Password', { exact: true }).fill(WRONG)
    await form.getByRole('button', { name: 'Sign in' }).click()
    await expect(issue).toHaveText('Too many tries. Try again in 30 seconds.')
  })

  await test.step('a homeserver without a password sign-in asks for a token, which it has to know', async () => {
    flows = { json: { flows: [{ type: 'm.login.sso' }] } }
    await form.getByLabel('Password', { exact: true }).fill(WRONG)
    await form.getByRole('button', { name: 'Sign in' }).click()
    await expect(issue).toHaveAttribute('data-issue', 'no_password')
    await form.getByLabel('Access token', { exact: true }).fill('syt_unknown_token')
    await form.getByRole('button', { name: 'Save token' }).click()
    await expect(issue).toHaveText("The homeserver doesn't know this token. It may have expired.")
    expect(await hosted()).toBeUndefined()
  })

  await test.step('signing in stores the token for the host and nothing else', async () => {
    flows = { json: { flows: [{ type: 'm.login.password' }] } }
    login = () => ({ json: { access_token: TOKEN, user_id: `@bridge:${NAME}`, device_id: 'DEVICE' } })
    await form.getByLabel('Sign in here').check()
    await form.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await form.getByRole('button', { name: 'Sign in' }).click()
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'check')
    expect(loginBodies.at(-1)).toEqual({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'bridge' },
      password: PASSWORD,
      initial_device_display_name: 'Harmony bridge',
    })
    expect(await hosted()).toMatchObject({ homeserver_url: `https://${NAME}`, access_token: TOKEN, harmony_token: expect.stringMatching(/^harmony_bot_[0-9a-f]{64}$/) })
  })

  await test.step('the tab waits for the instance to start the bridge, then pairs a room through the account', async () => {
    await expect(panel.getByTestId('check-waiting')).toHaveText('Waiting for this instance to start your bridge. This usually takes a minute or two.')
    await panel.getByText('Not connecting?').click()
    await expect(panel.getByTestId('matrix-host-help')).toContainText("this instance's bridge service may be down")
    await report(`@bridge:${NAME}`, [{ room_id: `!town:${NAME}`, name: 'Town Square', alias: null, encrypted: false, can_send: true, members: 3, invited: false }])
    await expect(panel.locator('.step-panel')).toHaveAttribute('data-step', 'channels', { timeout: 15000 })
    await expect(panel.getByTestId('select-mode')).toHaveCount(0)
    await panel.getByLabel('Harmony channel').selectOption(server.generalChannelId)
    await panel.getByLabel('Matrix room').selectOption(`!town:${NAME}`)
    await panel.getByRole('button', { name: 'Add pair' }).click()
    await expect(panel.getByTestId('matrix-pair-room')).toHaveText('Town Square')
    await panel.getByRole('button', { name: 'Finish setup' }).click()
    await expect(panel.getByTestId('status-mode')).toHaveText('On this instance')
    await expect(panel.getByTestId('status-account')).toHaveText(`@bridge:${NAME}`)
    await expect(panel.getByTestId('status-connection')).toHaveText('Matrix account')
  })

  await test.step('an account another bridge uses is named, and replaced by a pasted token', async () => {
    await report(`@bridge:${NAME}`, [], [], [{ code: 'account_in_use' }])
    const problem = panel.locator('[data-code="account_in_use"]')
    await expect(problem).toContainText('Another bridge on this instance already uses this Matrix account.', { timeout: 15000 })
    await problem.getByRole('button', { name: 'Replace the Matrix account' }).click()
    const replace = panel.getByTestId('matrix-connect-hosted')
    await expect(replace.getByLabel('Homeserver')).toHaveValue(`https://${NAME}`)
    await replace.getByLabel('Homeserver').fill(CLIENT_API)
    wellKnown = { status: 404, json: {} }
    await replace.getByLabel('Paste an access token').check()
    await replace.getByLabel('Access token', { exact: true }).fill('syt_pasted_access_token')
    const before = (await hosted())!.harmony_token
    await replace.getByRole('button', { name: 'Save token' }).click()
    await expect(replace.getByTestId('matrix-hosted-saved')).toBeVisible()
    const now = (await hosted())!
    expect(now).toMatchObject({ homeserver_url: CLIENT_API, access_token: 'syt_pasted_access_token' })
    expect(now.harmony_token).not.toBe(before)
  })

  await test.step('after another homeserver the tab waits, without the old rooms, and keeps the pair', async () => {
    await expect(panel.getByTestId('status-title')).toHaveText('Bridge is connecting to Matrix')
    await expect(panel.getByTestId('select-room')).toHaveCount(0)
    await expect(panel.getByTestId('matrix-managed-pair')).toHaveCount(1)
  })

  await test.step('the password went to the homeserver alone, and nothing secret is in the page, the storage or the console', async () => {
    const passwords = carried.filter((c) => c.secret !== TOKEN)
    expect(passwords.length).toBeGreaterThan(0)
    expect([...new Set(passwords.map((c) => c.origin))]).toEqual([CLIENT_API])
    expect(carried.filter((c) => c.secret === TOKEN).map((c) => c.path)).toEqual(['/rest/v1/rpc/matrix_bridge_set_account'])
    const page1 = await page.evaluate(() => JSON.stringify({ html: document.documentElement.outerHTML, local: { ...localStorage }, session: { ...sessionStorage } }))
    for (const secret of [PASSWORD, WRONG, TOKEN, 'syt_pasted_access_token']) {
      expect(page1).not.toContain(secret)
      expect(logged.join('\n')).not.toContain(secret)
    }
  })

  await test.step('disconnecting deletes the stored token', async () => {
    await panel.getByRole('button', { name: 'Disconnect bridge' }).click()
    await page.getByRole('alertdialog', { name: 'Disconnect the bridge?' }).getByRole('button', { name: 'Disconnect' }).click()
    await expect(panel.getByTestId('bridge-mode-chooser')).toBeVisible()
    const { data } = await admin.rpc('matrix_bridge_hosted_list')
    expect(JSON.stringify(data)).not.toContain('syt_pasted_access_token')
  })

  await test.step('a hosted bridge is refused once the instance no longer offers it', async () => {
    await setConfig('matrix_bridge_hosting_enabled', false)
    await panel.getByTestId('choose-hosted').click()
    await expect(panel.getByTestId('bridge-action-error')).toContainText("This instance doesn't offer that at the moment.")
    panel = await openMatrixTab(page)
    await expect(panel.getByTestId('mode-hosted')).toHaveCount(0)
  })
})
