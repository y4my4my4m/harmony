/// <reference lib="webworker" />
/**
 * WebRTC frame crypto worker (PC3, BUGS.md)
 *
 * Runs AES-GCM encrypt/decrypt for every RTP frame off the renderer's main
 * thread so audio (~50 Hz) and video (~30 Hz) crypto can no longer stall
 * scroll / layout / Vue updates.
 *
 * Two activation paths are supported:
 *  - **RTCRtpScriptTransform** (Safari + recent Chromium/Firefox): the
 *    sender/receiver attaches a transform whose constructor runs inside this
 *    worker. We listen for `rtctransform` events.
 *  - **Transferable insertable streams** (older Chromium with
 *    `createEncodedStreams()`): the main thread calls `createEncodedStreams`
 *    and transfers the `readable`/`writable` ReadableStream/WritableStream
 *    pair into this worker over `postMessage`. The worker then sets up the
 *    `TransformStream` pipeline locally.
 *
 * Both paths funnel through the same per-peer `FrameEncryptor` instances.
 */

import { FrameEncryptor } from './FrameEncryptor'

declare const self: DedicatedWorkerGlobalScope

interface PeerCiphers {
  enc: FrameEncryptor
  dec: FrameEncryptor
}

const peers = new Map<string, PeerCiphers>()

type Direction = 'encrypt' | 'decrypt'

type WorkerInMessage =
  | { type: 'init'; peerId: string; keyMaterial: ArrayBuffer }
  | { type: 'remove'; peerId: string }
  | { type: 'reset' }
  | {
      type: 'pipe'
      peerId: string
      direction: Direction
      readable: ReadableStream<RTCEncodedFrame>
      writable: WritableStream<RTCEncodedFrame>
    }

async function ensurePeer(peerId: string, keyMaterial?: ArrayBuffer): Promise<PeerCiphers | null> {
  const existing = peers.get(peerId)
  if (existing) return existing
  if (!keyMaterial) return null

  const enc = new FrameEncryptor()
  const dec = new FrameEncryptor()
  // Clone the buffer so encrypt and decrypt both own independent keys -
  // `crypto.subtle.importKey` consumes the buffer, and we need it twice.
  const encBuf = keyMaterial.slice(0)
  const decBuf = keyMaterial.slice(0)
  await enc.initialize(encBuf)
  await dec.initialize(decBuf)
  const ciphers: PeerCiphers = { enc, dec }
  peers.set(peerId, ciphers)
  return ciphers
}

function buildTransform(ciphers: PeerCiphers, direction: Direction): TransformStream<RTCEncodedFrame, RTCEncodedFrame> {
  return new TransformStream({
    transform: async (encodedFrame, controller) => {
      try {
        const data = new Uint8Array((encodedFrame as any).data)
        const out =
          direction === 'encrypt'
            ? await ciphers.enc.encrypt(data)
            : await ciphers.dec.decrypt(data)
        ;(encodedFrame as any).data = out.buffer
        controller.enqueue(encodedFrame)
      } catch {
        // INTENTIONAL: drop the frame on crypto failure. Forwarding cleartext
        // (or raw ciphertext to the decoder) would silently downgrade E2EE.
      }
    },
  })
}

self.addEventListener('message', (event: MessageEvent<WorkerInMessage>) => {
  const data = event.data
  if (!data || typeof data !== 'object') return

  switch (data.type) {
    case 'init':
      ensurePeer(data.peerId, data.keyMaterial).catch(() => {
        // Surfacing the failure via postMessage would let the main thread
        // fall back to non-E2EE silently - that's a downgrade. Drop the
        // request; encryptSender/decryptReceiver will skip if peer absent.
      })
      break
    case 'remove':
      peers.delete(data.peerId)
      break
    case 'reset':
      peers.clear()
      break
    case 'pipe': {
      const ciphers = peers.get(data.peerId)
      if (!ciphers) return
      const transform = buildTransform(ciphers, data.direction)
      data.readable.pipeThrough(transform).pipeTo(data.writable).catch(() => {
        /* pipeline closed */
      })
      break
    }
    default:
      // Unknown message - ignore.
      break
  }
})

// `RTCRtpScriptTransform` path (modern API). When the main thread does
// `sender.transform = new RTCRtpScriptTransform(worker, { peerId, direction })`,
// the worker receives an `rtctransform` event with a `RTCTransformEvent` whose
// `transformer.options` carries our routing payload.
self.addEventListener('rtctransform' as any, async (event: any) => {
  const transformer = event.transformer
  if (!transformer) return
  const opts = (transformer.options as { peerId?: string; direction?: Direction }) ?? {}
  const peerId = opts.peerId
  const direction: Direction = opts.direction === 'decrypt' ? 'decrypt' : 'encrypt'
  if (!peerId) return
  const ciphers = peers.get(peerId)
  if (!ciphers) return
  const transform = buildTransform(ciphers, direction)
  try {
    transformer.readable.pipeThrough(transform).pipeTo(transformer.writable).catch(() => {
      /* pipeline closed */
    })
  } catch {
    /* transform construction failed - drop silently to fail closed */
  }
})

// Minimal typings for the WebRTC encoded-frame shape (not present in DOM lib
// across all supported TS versions). Kept local to the worker module.
interface RTCEncodedFrame {
  data: ArrayBuffer
  timestamp: number
  getMetadata?: () => unknown
}
