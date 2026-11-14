// Another instance's media host for journeys that copy a remote emoji image: plain http serving
// a PNG at any path ending .png, text at /not-an-image, 404 elsewhere.
//
// The federation backend refuses loopback and private addresses (utils/ssrfProtection.ts), so
// the server listens on the gateway of a Docker bridge network on E2E_PEER_SUBNET (default
// 198.51.100.0/24, TEST-NET-2): the host holds that address. A network already holding the
// gateway is reused.

import { execFileSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'

// 16x16 opaque PNG.
export const REMOTE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR42mP8z8AARMQBxlGF1FUIAMJVAf8zYy5CAAAAAElFTkSuQmCC',
  'base64',
)

export interface RemoteHost {
  origin: string
  /** Paths requested, in order. */
  requests: string[]
  stop(): Promise<void>
}

function hostHolds(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, ip, () => probe.close(() => resolve(true)))
  })
}

/** `name` distinguishes the Docker network of one spec from another's. */
export async function startRemoteHost(name = 'emoji-remote'): Promise<RemoteHost> {
  const subnet = process.env.E2E_PEER_SUBNET ?? '198.51.100.0/24'
  const ip = `${subnet.split('/')[0].split('.').slice(0, 3).join('.')}.1`
  const network = `${process.env.E2E_PROJECT ?? 'hme2e'}-${name}`
  let created = false
  if (!(await hostHolds(ip))) {
    // A network left by an interrupted run.
    try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* absent */ }
    execFileSync('docker', ['network', 'create', '--driver', 'bridge', '--subnet', subnet, '--gateway', ip, network], { stdio: 'ignore' })
    created = true
    for (let i = 0; i < 50 && !(await hostHolds(ip)); i++) await new Promise((r) => setTimeout(r, 100))
    if (!(await hostHolds(ip))) throw new Error(`docker network ${network} gave the host no ${ip}`)
  }
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url?.endsWith('.png')) res.writeHead(200, { 'Content-Type': 'image/png' }).end(REMOTE_PNG)
    else if (req.url === '/not-an-image') res.writeHead(200, { 'Content-Type': 'image/png' }).end('not an image')
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, ip, resolve))
  return {
    origin: `http://${ip}:${(server.address() as { port: number }).port}`,
    requests,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (created) {
        try { execFileSync('docker', ['network', 'rm', network], { stdio: 'ignore' }) } catch { /* gone */ }
      }
    },
  }
}
