// A LiveKit server for journeys that place real calls, and the synthetic speech Chrome's
// fake capture device plays into them.
//
// livekit-server runs in Docker on the host network, so the ICE candidates it advertises
// (127.0.0.1) are the ones the browser reaches. Ports derive from E2E_PORT, so stacks of
// separate checkouts do not collide. The federation backend mints tokens for it: pass
// liveKit.env to startBackend().

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE = process.env.E2E_LIVEKIT_IMAGE ?? 'livekit/livekit-server:v1.9.4'
// livekit-server refuses secrets shorter than 32 characters.
const KEY = 'e2ekey'
const SECRET = 'e2e-livekit-secret-0123456789abcdef'

export interface LiveKit {
  url: string
  /** Environment for startBackend(): the backend signs tokens with these keys. */
  env: Record<string, string>
  stop(): void
}

export interface LiveKitOptions {
  /**
   * SFU speaker update interval, ms (livekit-server audio.update_interval, default 500).
   * A long interval keeps SFU-reported speaking out of reach of an assertion window.
   */
  speakerUpdateMs?: number
}

export async function startLiveKit(options: LiveKitOptions = {}): Promise<LiveKit> {
  const base = Number(process.env.E2E_LIVEKIT_PORT ?? Number(process.env.E2E_PORT ?? 54480) + 1000)
  const name = `hm-e2e-livekit-${base}`
  const config = [
    `port: ${base}`,
    'bind_addresses: ["127.0.0.1"]',
    'rtc:',
    `  tcp_port: ${base + 1}`,
    `  port_range_start: ${base + 2}`,
    `  port_range_end: ${base + 12}`,
    '  node_ip: 127.0.0.1',
    '  use_external_ip: false',
    'audio:',
    `  update_interval: ${options.speakerUpdateMs ?? 500}`,
    'keys:',
    `  ${KEY}: ${SECRET}`,
    'logging:',
    '  level: warn',
  ].join('\n')

  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host', '-e', `LIVEKIT_CONFIG=${config}`, IMAGE], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const url = `http://127.0.0.1:${base}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) break
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' })
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
      throw new Error(`livekit-server did not start on ${url}:\n${logs.stdout}${logs.stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return {
    url,
    env: {
      LIVEKIT_URL: `ws://127.0.0.1:${base}`,
      LIVEKIT_PUBLIC_URL: `ws://127.0.0.1:${base}`,
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
    },
    stop() {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
    },
  }
}

/**
 * Writes a mono 48 kHz 16-bit WAV of syllable-like bursts: harmonic complexes on a
 * 120-220 Hz fundamental, 250 ms on and 80 ms off, about -18 dBFS RMS while voiced.
 * Gaps stay under the detector's 300 ms hangover, so it reads as one utterance; the
 * pitch changes per burst so WebRTC noise suppression does not settle on it as noise.
 * Returns the path, for --use-file-for-fake-audio-capture.
 */
export function writeSpeechWav(seconds = 6): string {
  const rate = 48_000
  const total = rate * seconds
  const pcm = Buffer.alloc(total * 2)
  const on = Math.round(rate * 0.25)
  const period = on + Math.round(rate * 0.08)
  let f0 = 160
  for (let i = 0; i < total; i += 1) {
    const pos = i % period
    if (pos === 0) f0 = 120 + ((i / period) * 37) % 100
    let sample = 0
    if (pos < on) {
      const t = i / rate
      // 10 ms raised-cosine edges avoid clicks.
      const edge = Math.min(1, pos / 480, (on - pos) / 480)
      for (let h = 1; h <= 12; h += 1) sample += Math.sin(2 * Math.PI * f0 * h * t) / h
      sample *= 0.12 * edge
    }
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  const file = path.join(os.tmpdir(), `hm-e2e-speech-${process.pid}.wav`)
  fs.writeFileSync(file, Buffer.concat([header, pcm]))
  return file
}
