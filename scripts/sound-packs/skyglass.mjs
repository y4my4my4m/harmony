#!/usr/bin/env node
/**
 * Synthesises the Skyglass audio pack into public/assets/sounds/skyglass/.
 *
 *   node scripts/sound-packs/skyglass.mjs
 *
 * Three voices: glass bells, water drops and band-limited air (synth.mjs),
 * through a Schroeder reverb. Pitches sit on C major pentatonic around C6.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { air, bell, bubble, drop, finish, mix, note, pad, reverb, writePack } from './synth.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'public/assets/sounds/skyglass')

// MIDI numbers around C6; B6 is the one tone outside C major pentatonic.
const N = { G4: 67, C5: 72, D5: 74, E5: 76, G5: 79, A5: 81, C6: 84, D6: 86, E6: 88, G6: 91, A6: 93, B6: 95, C7: 96, D7: 98, E7: 100 }

// ---------------------------------------------------------------------------
// Sounds. Peaks: notifications -3 dBFS, voice toggles -6, interface -12.

const f = (n) => note(N[n])

const SOUNDS = {
  mention: () => finish(reverb(mix(1.3, [
    [0, drop(f('E5'), f('E6'), 0.3, { gain: 0.5 })],
    [0.05, bell(f('E6'), 1.2, { gain: 0.8 })],
    [0.17, bell(f('B6'), 1.1, { gain: 0.7 })],
    [0.17, bell(f('E7'), 0.6, { gain: 0.18, decay: 6 })],
  ]), { wet: 0.25 }), -3),

  dm: () => finish(reverb(mix(0.9, [
    [0, drop(f('G4'), f('G5'), 0.25, { gain: 0.8 })],
    [0.11, drop(f('C5'), f('C6'), 0.25, { gain: 0.8 })],
    [0.16, bell(f('G6'), 0.7, { gain: 0.35, decay: 4 })],
  ]), { wet: 0.2 }), -3),

  reaction: () => finish(reverb(mix(0.3, [
    [0, bubble(f('A6'), { gain: 0.8 })],
    [0.04, bell(f('E7'), 0.25, { gain: 0.12, decay: 9 })],
  ]), { wet: 0.15 }), -6),

  reply: () => finish(reverb(mix(0.7, [
    [0, drop(f('D5'), f('D6'), 0.25, { gain: 0.6 })],
    [0.06, bell(f('G6'), 0.6, { gain: 0.6, decay: 4 })],
  ]), { wet: 0.22 }), -3),

  server_invite: () => finish(reverb(mix(1.4, [
    ['C6', 'D6', 'E6', 'G6', 'A6'].map((n, i) => [i * 0.075, bell(f(n), 0.9, { gain: 0.55 })]),
    [[0.35, bell(f('C7'), 1.0, { gain: 0.35, decay: 2.6 })]],
  ].flat()), { wet: 0.3 }), -3),

  friend_request: () => finish(reverb(mix(1.0, [
    [0, bubble(f('C6'))],
    [0.08, bubble(f('E6'))],
    [0.14, bell(f('C6'), 0.8, { gain: 0.6 })],
    [0.22, bell(f('E6'), 0.8, { gain: 0.55 })],
  ]), { wet: 0.25 }), -3),

  server_update: () => finish(reverb(mix(1.2, [
    [0, bell(f('C6'), 1.1, { gain: 0.45, decay: 2.4 })],
    [0.02, bell(f('E6'), 1.1, { gain: 0.4, decay: 2.4 })],
    [0.04, bell(f('G6'), 1.1, { gain: 0.35, decay: 2.4 })],
  ]), { wet: 0.3 }), -4),

  emoji_added: () => finish(reverb(mix(0.7, [
    ['E6', 'G6', 'C7', 'E7'].map((n, i) => [i * 0.045, bell(f(n), 0.4, { gain: 0.45, decay: 6 })]),
  ].flat()), { wet: 0.3 }), -5),

  voice_channel_activity: () => finish(reverb(mix(0.45, [
    [0, bubble(f('G5'), { gain: 0.7 })],
    [0.07, bubble(f('D6'), { gain: 0.6 })],
  ]), { wet: 0.2 }), -6),

  voice_connect: () => finish(reverb(mix(1.0, [
    [0, air(0.45, 500, 3500, { gain: 0.5 })],
    [0.08, bubble(f('C6'), { gain: 0.5 })],
    [0.15, bubble(f('G6'), { gain: 0.4 })],
    [0.3, bell(f('G5'), 0.7, { gain: 0.6 })],
    [0.4, bell(f('D6'), 0.6, { gain: 0.6 })],
  ]), { wet: 0.25 }), -4),

  voice_disconnect: () => finish(reverb(mix(0.9, [
    [0, air(0.4, 3000, 500, { gain: 0.45 })],
    [0.05, bell(f('D6'), 0.6, { gain: 0.55 })],
    [0.17, bell(f('G5'), 0.7, { gain: 0.55 })],
    [0.2, drop(f('G5'), f('G4'), 0.3, { gain: 0.4, sweep: 0.08 })],
  ]), { wet: 0.25 }), -4),

  // Repeats every 3 s (IncomingCallModal); 2.4 s leaves a gap before the next ring.
  call_incoming: () => finish(reverb(mix(2.4, [
    [0, pad([f('C5'), f('G5'), f('E6')], 1.6, { gain: 0.12 })],
    ...[0, 0.6].flatMap((t0) => ['C6', 'E6', 'G6', 'E6'].map((n, i) => [t0 + i * 0.11, bell(f(n), 0.8, { gain: 0.5 })])),
    [1.25, bell(f('C7'), 1.1, { gain: 0.35, decay: 2.2 })],
  ]), { wet: 0.3 }), -3),

  call_outgoing: () => finish(reverb(mix(2.2, [
    [0, bell(f('G5'), 0.9, { gain: 0.5, decay: 2.6 })],
    [0.35, bell(f('C6'), 0.9, { gain: 0.45, decay: 2.6 })],
    [0, pad([f('G4'), f('D5')], 1.2, { gain: 0.08 })],
  ]), { wet: 0.3 }), -6),

  call_ended: () => finish(reverb(mix(1.0, [
    ['G6', 'E6', 'C6'].map((n, i) => [i * 0.12, bell(f(n), 0.7, { gain: 0.55 })]),
    [[0.25, drop(f('C5'), f('G4'), 0.4, { gain: 0.35, sweep: 0.1 })]],
  ].flat()), { wet: 0.28 }), -4),

  mic_on: () => finish(reverb(drop(f('G5'), f('D6') * 1.2, 0.2, { gain: 1 }), { wet: 0.12 }), -6),
  mic_off: () => finish(reverb(drop(f('D6'), f('G5') * 0.8, 0.2, { gain: 1, sweep: 0.05 }), { wet: 0.12 }), -6),

  deafen_on: () => finish(reverb(mix(0.4, [
    [0, drop(f('E6'), f('C6'), 0.2, { sweep: 0.05 })],
    [0.1, drop(f('C6'), f('G5'), 0.25, { sweep: 0.05 })],
  ]), { wet: 0.12 }), -6),
  deafen_off: () => finish(reverb(mix(0.4, [
    [0, drop(f('G5'), f('C6'), 0.2)],
    [0.1, drop(f('C6'), f('E6'), 0.25)],
  ]), { wet: 0.12 }), -6),

  camera_on: () => finish(reverb(mix(0.45, [
    [0, bell(f('E7'), 0.3, { gain: 0.5, decay: 10 })],
    [0.03, bell(f('G6'), 0.4, { gain: 0.5, decay: 6 })],
    [0.06, air(0.12, 4000, 8000, { gain: 0.25, q: 1.5 })],
  ]), { wet: 0.15 }), -6),
  camera_off: () => finish(reverb(mix(0.4, [
    [0, bell(f('G6'), 0.3, { gain: 0.45, decay: 8, bright: 0.5 })],
    [0.04, bell(f('C6'), 0.35, { gain: 0.45, decay: 7, bright: 0.5 })],
  ]), { wet: 0.15 }), -6),

  screenshare_on: () => finish(reverb(mix(0.7, [
    [0, air(0.35, 800, 6000, { gain: 0.5 })],
    [0.22, bell(f('C7'), 0.45, { gain: 0.4, decay: 5 })],
    [0.26, bell(f('G6'), 0.45, { gain: 0.4, decay: 5 })],
  ]), { wet: 0.2 }), -6),
  screenshare_off: () => finish(reverb(mix(0.6, [
    [0, air(0.35, 6000, 800, { gain: 0.5 })],
    [0.18, bell(f('C6'), 0.4, { gain: 0.4, decay: 5, bright: 0.6 })],
  ]), { wet: 0.2 }), -6),

  ui_click: () => finish(drop(f('C6'), f('G6'), 0.06, { gain: 1, sweep: 0.015, decay: 70 }), -12),
  ui_hover: () => finish(drop(f('G6'), f('C7'), 0.04, { gain: 1, sweep: 0.01, decay: 110 }), -24),

  ui_success: () => finish(reverb(mix(1.1, [
    ['C6', 'E6', 'G6', 'C7'].map((n, i) => [i * 0.07, bell(f(n), 0.8, { gain: 0.5 })]),
  ].flat()), { wet: 0.28 }), -4),

  ui_error: () => finish(reverb(mix(0.55, [
    [0, bell(note(N.E5 + 1), 0.4, { gain: 0.6, decay: 7, bright: 0.4 })],
    [0.12, bell(f('E5'), 0.45, { gain: 0.6, decay: 7, bright: 0.4 })],
    [0, drop(f('C5'), f('G4'), 0.3, { gain: 0.3, sweep: 0.06 })],
  ]), { wet: 0.12 }), -6),

  ui_notification: () => finish(reverb(mix(0.7, [
    [0, bubble(f('E6'), { gain: 0.6 })],
    [0.05, bell(f('A6'), 0.6, { gain: 0.5, decay: 4 })],
  ]), { wet: 0.22 }), -5),
}

writePack(OUT, {
  id: 'skyglass',
  name: 'Skyglass',
  description: 'Glass bells, water drops and bubbles for the Skyglass skin',
}, SOUNDS)
