#!/usr/bin/env node
/**
 * Synthesises the Flux audio pack into public/assets/sounds/flux/.
 *
 *   node scripts/sound-packs/flux.mjs
 *
 * Liquid synth: PolyBLEP saws gliding in pitch through a resonant low-pass
 * whose cutoff sweeps with them (the bloop), sine sub swells and drops, FM
 * glass for sparkle and band-passed air for sweeps, through a medium dark
 * room. Pitches sit on E dorian.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { air, drop, envelope, finish, fm, glideSaw, mix, note, reverb, svf, writePack } from './synth.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'public/assets/sounds/flux')

// MIDI numbers, E dorian from E2 to E6.
const N = {
  E2: 40, E3: 52, G3: 55, A3: 57, B3: 59, 'C#4': 61, D4: 62,
  E4: 64, G4: 67, A4: 69, B4: 71, D5: 74, E5: 76, G5: 79, A5: 81, B5: 83, E6: 88,
}
const f = (n) => note(N[n])

const room = (buf, wet = 0.18) => reverb(buf, { wet, room: 0.7, damp: 0.5 })

/**
 * Bloop: saw gliding a -> b while a resonant low-pass sweeps cut0 -> cut1.
 * High q makes the filter sing at the cutoff, the liquid vowel.
 */
function bloop(a, b, seconds, { cut0 = 500, cut1 = 3500, q = 5, decay = 14, glide = 0.06, gain = 1, attack = 0.004 } = {}) {
  const raw = glideSaw(f(a), f(b), seconds, { glide })
  return envelope(svf(raw, { from: cut0, to: cut1, q }), { attack, decay }).map((v) => v * gain)
}

const sparkle = (n, seconds, gain = 0.3) => fm(f(n), seconds, { ratio: 3.5, index: 1.4, indexDecay: 16, decay: 10, gain })
const sub = (a, b, seconds, gain = 0.8) => drop(f(a), f(b), seconds, { gain, sweep: seconds * 0.6, decay: 5 })

/** Saw chord through a slowly opening low-pass, for swells. */
function swell(notes, seconds, { from = 250, to = 2600, q = 1.2, attack = 0.06, decay = 2.4, gain = 0.5 } = {}) {
  const chord = mix(seconds, notes.map((n) => [0, glideSaw(f(n), f(n), seconds, { gain: 1 / notes.length })]))
  return envelope(svf(chord, { from, to, q }), { attack, decay }).map((v) => v * gain)
}

// Peaks: notifications -3 dBFS, voice toggles -7, interface -14.
const SOUNDS = {
  mention: () => finish(room(mix(1.0, [
    [0, bloop('E4', 'E5', 0.35, { glide: 0.12, cut0: 400, cut1: 3200, q: 6, decay: 9 })],
    [0.11, bloop('B4', 'B5', 0.4, { glide: 0.1, cut0: 600, cut1: 4200, q: 6, decay: 8 })],
    [0.2, sparkle('E6', 0.6, 0.35)],
  ])), -3),

  dm: () => finish(room(mix(0.65, [
    [0, bloop('G4', 'D5', 0.22, { cut0: 500, cut1: 2800, q: 7, decay: 16 })],
    [0.12, bloop('B4', 'G5', 0.3, { cut0: 600, cut1: 3600, q: 7, decay: 12 })],
  ])), -3),

  reaction: () => finish(room(bloop('B4', 'E5', 0.18, { cut0: 700, cut1: 3800, q: 6, decay: 26 }), 0.12), -6),

  reply: () => finish(room(mix(0.5, [
    [0, bloop('D5', 'A5', 0.25, { cut0: 600, cut1: 3500, q: 5, decay: 16 })],
    [0, sub('A3', 'E3', 0.3, 0.5)],
  ])), -4),

  server_invite: () => finish(room(mix(1.1, [
    ...['E4', 'G4', 'B4', 'D5', 'E5'].map((n, i) => [i * 0.06, bloop(n, n, 0.25, { cut0: 500 + i * 300, cut1: 3500, q: 5, decay: 14, glide: 0.01, gain: 0.7 })]),
    [0.3, sparkle('E6', 0.7, 0.35)],
  ]), 0.22), -3),

  friend_request: () => finish(room(mix(0.9, [
    [0, bloop('G4', 'G4', 0.4, { cut0: 400, cut1: 2600, q: 8, decay: 8, glide: 0.01 })],
    [0.16, bloop('B4', 'B4', 0.5, { cut0: 500, cut1: 3200, q: 8, decay: 7, glide: 0.01 })],
  ])), -4),

  server_update: () => finish(room(swell(['E3', 'B3', 'E4', 'G4'], 1.3)), -5),

  emoji_added: () => finish(room(mix(0.5, [
    ...['E5', 'G5', 'B5', 'E6'].map((n, i) => [i * 0.04, bloop(n, n, 0.14, { cut0: 1500, cut1: 6000, q: 4, decay: 30, glide: 0.01, gain: 0.6 })]),
  ])), -6),

  voice_channel_activity: () => finish(room(mix(0.4, [
    [0, bloop('A4', 'E5', 0.22, { cut0: 500, cut1: 2600, q: 5, decay: 18, gain: 0.8 })],
    [0.06, sparkle('B5', 0.25, 0.2)],
  ])), -7),

  voice_connect: () => finish(room(mix(0.9, [
    [0, sub('E2', 'E3', 0.5, 0.7)],
    [0, envelope(svf(glideSaw(f('E3'), f('E3'), 0.6), { from: 180, to: 4200, q: 4 }), { attack: 0.08, decay: 5 })],
    [0.38, bloop('B4', 'E5', 0.35, { cut0: 900, cut1: 4000, q: 5, decay: 9 })],
  ])), -4),

  voice_disconnect: () => finish(room(mix(0.8, [
    [0, envelope(svf(glideSaw(f('E3'), f('E3'), 0.5), { from: 4200, to: 180, q: 4 }), { attack: 0.01, decay: 4 })],
    [0.1, sub('E3', 'E2', 0.5, 0.7)],
  ])), -4),

  // Repeats every 3 s (IncomingCallModal); 2.4 s leaves a gap before the next ring.
  call_incoming: () => finish(room(mix(2.4, [
    [0, swell(['E3', 'B3'], 2.2, { from: 200, to: 900, attack: 0.3, decay: 1.2, gain: 0.35 })],
    ...[0, 0.5, 1.0].flatMap((t0) => [
      [t0, bloop('E4', 'E4', 0.3, { cut0: 400, cut1: 2800, q: 7, decay: 10, glide: 0.01, gain: 0.8 })],
      [t0 + 0.12, bloop('B4', 'B4', 0.3, { cut0: 500, cut1: 3400, q: 7, decay: 10, glide: 0.01, gain: 0.7 })],
      [t0, sub('E3', 'E2', 0.25, 0.4)],
    ]),
    [1.5, sparkle('E6', 0.8, 0.25)],
  ]), 0.2), -3),

  call_outgoing: () => finish(room(mix(1.9, [
    [0, bloop('A4', 'A4', 0.45, { cut0: 350, cut1: 1800, q: 6, decay: 6, glide: 0.01 })],
    [0.55, bloop('A4', 'A4', 0.45, { cut0: 350, cut1: 1800, q: 6, decay: 6, glide: 0.01, gain: 0.8 })],
  ])), -6),

  call_ended: () => finish(room(mix(0.8, [
    ...['B4', 'G4', 'E4'].map((n, i) => [i * 0.1, bloop(n, n, 0.3, { cut0: 3000, cut1: 500, q: 6, decay: 12, glide: 0.01, gain: 0.8 })]),
    [0.2, sub('E3', 'E2', 0.4, 0.5)],
  ])), -4),

  mic_on: () => finish(room(bloop('D5', 'A5', 0.14, { cut0: 800, cut1: 4000, q: 5, decay: 30 }), 0.1), -7),
  mic_off: () => finish(room(bloop('A5', 'D5', 0.14, { cut0: 4000, cut1: 800, q: 5, decay: 30 }), 0.1), -7),

  deafen_on: () => finish(room(mix(0.3, [
    [0, bloop('A4', 'A4', 0.12, { cut0: 3000, cut1: 700, q: 5, decay: 32, glide: 0.01 })],
    [0.08, bloop('E4', 'E4', 0.16, { cut0: 2400, cut1: 500, q: 5, decay: 28, glide: 0.01 })],
  ]), 0.1), -7),
  deafen_off: () => finish(room(mix(0.3, [
    [0, bloop('E4', 'E4', 0.12, { cut0: 500, cut1: 2400, q: 5, decay: 32, glide: 0.01 })],
    [0.08, bloop('A4', 'A4', 0.16, { cut0: 700, cut1: 3000, q: 5, decay: 28, glide: 0.01 })],
  ]), 0.1), -7),

  camera_on: () => finish(room(mix(0.35, [
    [0, bloop('E5', 'B5', 0.12, { cut0: 1000, cut1: 5000, q: 4, decay: 30 })],
    [0.03, air(0.12, 3000, 9000, { gain: 0.4, q: 1.5 })],
  ]), 0.1), -7),
  camera_off: () => finish(room(mix(0.35, [
    [0, bloop('B4', 'E4', 0.14, { cut0: 4000, cut1: 700, q: 4, decay: 26 })],
    [0.02, air(0.12, 6000, 1500, { gain: 0.35, q: 1.5 })],
  ]), 0.1), -8),

  screenshare_on: () => finish(room(mix(0.55, [
    [0, air(0.3, 700, 7000, { gain: 0.5, q: 3 })],
    [0.05, envelope(svf(glideSaw(f('E4'), f('E5'), 0.4, { glide: 0.3 }), { from: 300, to: 4000, q: 5 }), { attack: 0.03, decay: 6 })],
  ])), -7),
  screenshare_off: () => finish(room(mix(0.55, [
    [0, air(0.3, 7000, 700, { gain: 0.5, q: 3 })],
    [0.05, envelope(svf(glideSaw(f('E5'), f('E4'), 0.4, { glide: 0.3 }), { from: 4000, to: 300, q: 5 }), { attack: 0.01, decay: 6 })],
  ])), -7),

  ui_click: () => finish(bloop('E5', 'B5', 0.07, { cut0: 1200, cut1: 4200, q: 2.5, decay: 65, glide: 0.03 }), -14),
  ui_hover: () => finish(bloop('B5', 'E6', 0.04, { cut0: 2000, cut1: 6000, q: 2, decay: 110, glide: 0.02 }), -28),

  ui_success: () => finish(room(mix(1.0, [
    ...['E4', 'G4', 'B4'].map((n, i) => [i * 0.07, bloop(n, n, 0.6, { cut0: 500, cut1: 3500, q: 5, decay: 6, glide: 0.01, gain: 0.7 })]),
    [0.2, sparkle('E6', 0.6, 0.3)],
  ]), 0.22), -5),

  ui_error: () => finish(room(mix(0.4, [
    [0, bloop('E3', 'E3', 0.16, { cut0: 180, cut1: 1300, q: 7, decay: 14, glide: 0.01 })],
    [0.15, bloop('E3', 'E3', 0.2, { cut0: 180, cut1: 1100, q: 7, decay: 12, glide: 0.01 })],
  ]), 0.1), -8),

  ui_notification: () => finish(room(mix(0.5, [
    [0, bloop('G4', 'D5', 0.25, { cut0: 600, cut1: 3500, q: 6, decay: 14 })],
    [0.08, sparkle('B5', 0.35, 0.25)],
  ])), -6),
}

writePack(OUT, {
  id: 'flux',
  name: 'Flux',
  description: 'Resonant liquid synth, sub swells and glass sparkle for the Flux skin',
}, SOUNDS)
