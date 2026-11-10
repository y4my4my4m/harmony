import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig, loadSecrets, registration, botUserId } from './config.js'
import { createAppService } from './AppService.js'
import { Store } from './Store.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MatrixClient } from './MatrixClient.js'
import { Relay } from './Relay.js'

async function main(): Promise<void> {
  process.umask(0o077)
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--registration')) throw new Error('Usage: node dist/index.js [--registration]')
  const config = loadConfig(process.env.MATRIX_BRIDGE_CONFIG ?? './config.json')
  const secrets = loadSecrets()
  if (args.includes('--registration')) {
    // A JSON document is also valid YAML. Never print application-service secrets to stdout.
    writeFileSync('./registration.json', JSON.stringify(registration(config, secrets), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.info('Wrote registration.json; register it with your Matrix homeserver and keep it private')
    return
  }
  mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 })
  const store = new Store(config.database)
  const harmony = new HarmonyClient({ ...config.harmony, token: secrets.harmonyToken })
  const matrix = new MatrixClient({ ...config.matrix, asToken: secrets.asToken, botUserId: botUserId(config) })
  const relay = new Relay(config, store, harmony, matrix, message => console.warn(message))
  let gatewayConnected = false
  let matrixStarted = false
  const server = createAppService({
    hsToken: secrets.hsToken, botUserId: botUserId(config), ownsGhost: id => store.ownsGhost(id),
    acceptTransaction: (id, events) => relay.acceptTransaction(id, events),
    status: () => ({ ready: gatewayConnected && matrixStarted && relay.isHealthy, ...store.counts() }),
  })
  harmony.on('ready', () => { gatewayConnected = true; relay.requestMemberSync(); console.info('Harmony gateway connected') })
  harmony.on('disconnected', () => { gatewayConnected = false })
  harmony.on('error', () => { gatewayConnected = false; console.warn('Harmony connection error; check connectivity and bot credentials') })
  harmony.on('message', message => {
    try { relay.acceptHarmonyMessage(message) }
    catch { console.warn('Could not enqueue Harmony message; check local storage and queue capacity') }
  })
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    harmony.stop()
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeIdleConnections()
    await Promise.all([closed, relay.stop()])
    store.close()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.listen.port, config.listen.host, () => { server.off('error', reject); resolve() })
    })
    // Start accepting durable transactions before joining; homeserver callbacks may arrive during startup.
    for (const pair of config.pairs) {
      try { await harmony.requireMatrixBridge(pair.harmonyChannelId) }
      catch {
        console.error('Matrix bridge registration could not be verified for every pair; apply the new DB migrations, run configure_matrix_bridge(p_bot_id, p_server_id, p_channel_ids), and verify Gateway bridge-platform support and channel permissions')
        throw new Error('Matrix bridge registration required')
      }
    }
    await matrix.ensureRegistered()
    await relay.cleanupUnpairedGhosts()
    for (const pair of config.pairs) {
      const binding = await harmony.bridgeRoom(pair.harmonyChannelId, { room_id: pair.matrixRoomId, initial_sender_mode: pair.senderMode })
      if (binding.room_id !== pair.matrixRoomId) throw new Error('Matrix binding differs from configuration')
      await matrix.joinRoom(pair.matrixRoomId)
      if (!await matrix.roomIsPlaintext(pair.matrixRoomId) || !await harmony.channelIsPlaintext(pair.harmonyChannelId)) {
        throw new Error('A paired room/channel is encrypted or its policy cannot be verified')
      }
    }
    matrixStarted = true
    harmony.start()
    relay.start()
    console.info('Experimental plaintext relay started; only explicitly allowed users are relayed')
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        const deadline = setTimeout(() => process.exit(1), 20_000)
        deadline.unref()
        void shutdown().then(() => { clearTimeout(deadline) }, () => process.exit(1))
      })
    }
  } catch (error) {
    await shutdown().catch(() => {})
    throw error
  }
}

void main().catch(() => {
  console.error('Bridge startup failed; verify private configuration, permissions, homeserver registration and encryption policy')
  process.exitCode = 1
})
