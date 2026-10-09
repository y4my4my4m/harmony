#!/usr/bin/env node
/**
 * Synthesises the Lattice audio pack into public/assets/sounds/lattice/.
 *
 *   node scripts/sound-packs/lattice.mjs
 *
 * Two-operator FM pings (ratio 3.5 for glass, 2 for clean tones), relay ticks,
 * band-limited sweeps and a detuned saw for errors, through a small damped
 * room. Pitches sit on D lydian; the raised fourth (G#) carries the
 * unresolved, machine-like colour.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { air, drop, finish, fm, mix, note, pad, reverb, saw, tick, writePack } from './synth.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'public/assets/sounds/lattice')

// MIDI numbers, D lydian from D3 to E7.
const N = {
  D3: 50, 'C#3': 49, D4: 62, A4: 69,
  D5: 74, E5: 76, 'F#5': 78, 'G#5': 80, A5: 81, B5: 83, 'C#6': 85,
  D6: 86, E6: 88, 'F#6': 90, 'G#6': 92, A6: 93, D7: 98, E7: 100,
}
const f = (n) => note(N[n])

const ROOM = { wet: 0.12, room: 0.55, damp: 0.55 }
const room = (buf, wet = ROOM.wet) => reverb(buf, { ...ROOM, wet })

const glass = (n, seconds, opts = {}) => fm(f(n), seconds, { ratio: 3.5, index: 1.6, indexDecay: 14, decay: 9, ...opts })
const clean = (n, seconds, opts = {}) => fm(f(n), seconds, { ratio: 2, index: 1.2, indexDecay: 18, decay: 11, ...opts })
const relay = (opts = {}) => tick(0.04, { decay: 300, tone: 3200, toneGain: 0.22, ...opts })

// Peaks: notifications -3 dBFS, voice toggles -7, interface -14.
const SOUNDS = {
  mention: () => finish(room(mix(1.1, [
    [0, relay({ gain: 0.5 })],
    ...['D6', 'F#6', 'A6'].map((n, i) => [0.01 + i * 0.045, clean(n, 0.25, { gain: 0.55, decay: 16 })]),
    [0.15, glass('A6', 0.9, { gain: 0.6, decay: 4 })],
    [0.15, glass('E7', 0.6, { gain: 0.22, decay: 6 })],
  ]), 0.16), -3),

  dm: () => finish(room(mix(0.7, [
    [0, relay({ gain: 0.4 })],
    [0.01, clean('A5', 0.4, { gain: 0.8, decay: 9 })],
    [0.09, clean('E6', 0.5, { gain: 0.8, decay: 7 })],
  ])), -3),

  reaction: () => finish(room(glass('F#6', 0.25, { decay: 22 })), -6),

  reply: () => finish(room(mix(0.45, [
    [0, relay({ gain: 0.45 })],
    [0.012, glass('D6', 0.4, { decay: 10 })],
  ])), -4),

  server_invite: () => finish(room(mix(1.1, [
    ...['D5', 'E5', 'F#5', 'G#5', 'A5'].map((n, i) => [i * 0.04, clean(n, 0.2, { gain: 0.45, decay: 18 })]),
    [0.22, glass('D6', 0.85, { gain: 0.7, decay: 4 })],
    [0.22, glass('A6', 0.6, { gain: 0.25, decay: 6 })],
  ]), 0.18), -3),

  friend_request: () => finish(room(mix(0.9, [
    [0, glass('G#5', 0.45, { gain: 0.5, decay: 8 })],
    [0, glass('C#6', 0.45, { gain: 0.5, decay: 8 })],
    [0.16, glass('G#5', 0.6, { gain: 0.5, decay: 6 })],
    [0.16, glass('C#6', 0.6, { gain: 0.5, decay: 6 })],
  ])), -4),

  server_update: () => finish(room(mix(1.2, [
    ...['D5', 'F#5', 'A5', 'C#6'].map((n, i) => [i * 0.015, clean(n, 1.1, { gain: 0.4, decay: 3, attack: 0.02 })]),
  ]), 0.18), -5),

  emoji_added: () => finish(room(mix(0.5, [
    ...['E7', 'D7', 'A6', 'F#6', 'E7'].map((n, i) => [i * 0.03, glass(n, 0.18, { gain: 0.45, decay: 18 })]),
  ])), -6),

  voice_channel_activity: () => finish(room(mix(0.35, [
    [0, relay({ gain: 0.6 })],
    [0.05, relay({ gain: 0.45 })],
    [0.06, clean('A5', 0.25, { gain: 0.6, decay: 14 })],
  ])), -7),

  voice_connect: () => finish(room(mix(0.8, [
    [0, drop(f('D4'), f('D6'), 0.32, { gain: 0.55, sweep: 0.26, decay: 6 })],
    [0.28, relay({ gain: 0.7 })],
    [0.29, glass('D6', 0.5, { gain: 0.6, decay: 7 })],
    [0.29, glass('A6', 0.45, { gain: 0.35, decay: 8 })],
  ])), -4),

  voice_disconnect: () => finish(room(mix(0.7, [
    [0, relay({ gain: 0.7 })],
    [0.01, drop(f('D6'), f('D4'), 0.4, { gain: 0.55, sweep: 0.3, decay: 6 })],
    [0.3, glass('A5', 0.4, { gain: 0.4, decay: 9 })],
  ])), -4),

  // Repeats every 3 s (IncomingCallModal); 2.4 s leaves a gap before the next ring.
  call_incoming: () => finish(room(mix(2.4, [
    [0, pad([f('D4'), f('A4')], 1.9, { gain: 0.1, attack: 0.2, release: 0.6 })],
    ...[0, 0.42, 0.84].flatMap((t0) => ['D6', 'F#6', 'A6'].map((n, i) => [t0 + i * 0.07, clean(n, 0.3, { gain: 0.5, decay: 12 })])),
    [1.1, glass('E7', 0.9, { gain: 0.3, decay: 4 })],
  ]), 0.16), -3),

  call_outgoing: () => finish(room(mix(2.0, [
    [0, clean('A5', 0.5, { gain: 0.5, decay: 6 })],
    [0.5, clean('A5', 0.5, { gain: 0.4, decay: 6 })],
    [0, pad([f('D4')], 1.0, { gain: 0.06, attack: 0.1, release: 0.4 })],
  ])), -7),

  call_ended: () => finish(room(mix(0.8, [
    [0, relay({ gain: 0.6 })],
    ...['A6', 'F#6', 'D6'].map((n, i) => [0.01 + i * 0.09, glass(n, 0.45, { gain: 0.55, decay: 9 })]),
  ])), -4),

  mic_on: () => finish(room(mix(0.22, [
    [0, relay({ gain: 0.6 })],
    [0.008, clean('A6', 0.2, { decay: 26 })],
  ])), -7),
  mic_off: () => finish(room(mix(0.22, [
    [0, relay({ gain: 0.6 })],
    [0.008, clean('D6', 0.2, { decay: 26 })],
  ])), -7),

  deafen_on: () => finish(room(mix(0.3, [
    [0, clean('A5', 0.15, { decay: 28 })],
    [0.07, clean('D5', 0.2, { decay: 24 })],
  ])), -7),
  deafen_off: () => finish(room(mix(0.3, [
    [0, clean('D5', 0.15, { decay: 28 })],
    [0.07, clean('A5', 0.2, { decay: 24 })],
  ])), -7),

  camera_on: () => finish(room(mix(0.3, [
    [0, tick(0.06, { decay: 120, gain: 0.9 })],
    [0.045, tick(0.05, { decay: 160, gain: 0.7 })],
    [0.05, glass('E7', 0.2, { gain: 0.3, decay: 20 })],
  ])), -7),
  camera_off: () => finish(room(mix(0.3, [
    [0, tick(0.06, { decay: 120, gain: 0.9, hp: 0.7 })],
    [0.05, tick(0.05, { decay: 160, gain: 0.6, hp: 0.7 })],
  ])), -8),

  screenshare_on: () => finish(room(mix(0.5, [
    [0, air(0.24, 900, 8000, { gain: 0.6, q: 4 })],
    [0.2, glass('A6', 0.3, { gain: 0.45, decay: 12 })],
  ])), -7),
  screenshare_off: () => finish(room(mix(0.5, [
    [0, air(0.24, 8000, 900, { gain: 0.6, q: 4 })],
    [0.2, glass('D6', 0.3, { gain: 0.45, decay: 12 })],
  ])), -7),

  ui_click: () => finish(relay({ tone: 3600, toneGain: 0.18, decay: 360 }), -14),
  ui_hover: () => finish(tick(0.02, { decay: 520 }), -28),

  ui_success: () => finish(room(mix(0.8, [
    ...['D6', 'A6', 'D7'].map((n, i) => [i * 0.06, clean(n, 0.6, { gain: 0.5, decay: 7 })]),
  ]), 0.16), -5),

  ui_error: () => finish(room(mix(0.35, [
    [0, saw(f('D3'), 0.2, { gain: 0.6, decay: 12, detune: 30 })],
    [0.11, saw(f('C#3'), 0.22, { gain: 0.6, decay: 12, detune: 30 })],
  ]), 0.08), -9),

  ui_notification: () => finish(room(mix(0.45, [
    [0, relay({ gain: 0.45 })],
    [0.01, glass('F#6', 0.4, { gain: 0.7, decay: 9 })],
  ])), -6),
}

writePack(OUT, {
  id: 'lattice',
  name: 'Lattice',
  description: 'FM crystal pings, relay ticks and sweeps for the Lattice skin',
}, SOUNDS)
