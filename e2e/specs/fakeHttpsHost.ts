// A local HTTPS server answering as a public host (cdn.discordapp.com, discord.com) for a child
// process such as the bot gateway: `env` routes its fetches through a CONNECT proxy
// (NODE_USE_ENV_PROXY, HTTPS_PROXY) and trusts a test CA (NODE_EXTRA_CA_CERTS). Loopback stays
// direct.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export interface FakeHttpsHost {
  env: Record<string, string>
  /** CONNECT targets, `host:443` each. */
  tunnels: string[]
  close(): Promise<void>
}

export async function fakeHttpsHost(host: string, handler: http.RequestListener): Promise<FakeHttpsHost> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-e2e-https-'))
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Harmony E2E CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'host.key', '-out', 'host.csr', '-subj', `/CN=${host}`])
  fs.writeFileSync(path.join(dir, 'san.cnf'), `subjectAltName=DNS:${host}\n`)
  run(['x509', '-req', '-in', 'host.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'host.pem', '-days', '1', '-extfile', 'san.cnf'])

  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'host.key')), cert: fs.readFileSync(path.join(dir, 'host.pem')) }, handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const tunnels: string[] = []
  const proxy = http.createServer()
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url ?? '')
    const upstream = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    env: {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      NO_PROXY: '127.0.0.1,localhost',
      NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem'),
    },
    tunnels,
    async close() {
      proxy.closeAllConnections()
      server.closeAllConnections()
      await new Promise((resolve) => proxy.close(resolve))
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
