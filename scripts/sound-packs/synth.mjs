/**
 * Synthesis primitives shared by the sound-pack scripts in this directory.
 *
 * Mono, 48 kHz, Float32 buffers. Every voice returns a fresh buffer; mix()
 * places voices on a timeline. Noise comes from a seeded LCG that writePack
 * reseeds before each sound, so a pack is byte-identical across runs for a
 * given ffmpeg build.
 *
 * Requires ffmpeg with libmp3lame on PATH. Output: 48 kHz mono, 128 kb/s.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SR = 48000

/** Hz for a MIDI note number, A4 = 69 = 440 Hz. */
export const note = (n) => 440 * 2 ** ((n - 69) / 12)

const SEED = 0x5eed
let seed = SEED
export function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

export function buffer(seconds) {
  return new Float32Array(Math.ceil(seconds * SR))
}

/**
 * Glass bell: inharmonic partials at 1, 2.76, 5.40, 8.93 x f, the modes of a
 * free-free bar. Higher partials decay faster; 2 ms attack avoids a click.
 */
export function bell(freq, seconds, { gain = 1, decay = 3.2, bright = 1 } = {}) {
  const out = buffer(seconds)
  const partials = [
    [1, 1, 1],
    [2.76, 0.42 * bright, 1.9],
    [5.4, 0.2 * bright, 3.1],
    [8.93, 0.09 * bright, 4.6],
  ]
  const attack = 0.002 * SR
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    let v = 0
    for (const [ratio, amp, k] of partials) {
      if (freq * ratio > SR / 2.2) continue
      v += amp * Math.sin(2 * Math.PI * freq * ratio * t) * Math.exp(-decay * k * t)
    }
    out[i] = v * gain * Math.min(1, i / attack)
  }
  return out
}

/** Water drop: sine sweeping f0 -> f1 over `sweep` seconds, then ringing out. */
export function drop(f0, f1, seconds, { gain = 1, sweep = 0.035, decay = 28 } = {}) {
  const out = buffer(seconds)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const k = Math.min(1, t / sweep)
    const f = f0 * (f1 / f0) ** k
    phase += (2 * Math.PI * f) / SR
    const env = Math.min(1, i / (0.0015 * SR)) * Math.exp(-decay * t)
    out[i] = Math.sin(phase) * env * gain
  }
  return out
}

/** Bubble: short drop with a little upward wobble. */
export function bubble(freq, { gain = 0.6, seconds = 0.12 } = {}) {
  return drop(freq * 0.55, freq, seconds, { gain, sweep: 0.03, decay: 34 })
}

/**
 * Air: white noise through a two-pole resonant band-pass whose centre moves
 * from `fromHz` to `toHz`. Envelope is a raised-cosine swell.
 */
export function air(seconds, fromHz, toHz, { gain = 0.25, q = 2.5 } = {}) {
  const out = buffer(seconds)
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < out.length; i++) {
    const p = i / out.length
    const fc = fromHz * (toHz / fromHz) ** p
    const w = (2 * Math.PI * fc) / SR
    const r = Math.exp(-w / (2 * q))
    const a1 = 2 * r * Math.cos(w)
    const a2 = -r * r
    const x = rand() * 2 - 1
    const y = (1 - r) * x + a1 * y1 + a2 * y2
    y2 = y1
    y1 = y
    out[i] = y * gain * Math.sin(Math.PI * p) ** 2
  }
  return out
}

/** Soft pad: detuned sines with a slow attack, for call tones. */
export function pad(freqs, seconds, { gain = 0.18, attack = 0.12, release = 0.5 } = {}) {
  const out = buffer(seconds)
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const env = Math.min(1, t / attack) * Math.min(1, (seconds - t) / release)
    let v = 0
    for (const f of freqs) {
      v += Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.003 * t)
    }
    out[i] = (v / freqs.length) * env * gain
  }
  return out
}

/**
 * Two-operator FM: carrier `freq`, modulator `freq * ratio`. The modulation
 * index starts at `index` and decays at `indexDecay` per second, so the tone
 * opens bright and settles toward a sine; amplitude decays at `decay`.
 */
export function fm(freq, seconds, { ratio = 3.5, index = 2.5, indexDecay = 12, decay = 9, gain = 1, attack = 0.0015 } = {}) {
  const out = buffer(seconds)
  const a = attack * SR
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const idx = index * Math.exp(-indexDecay * t)
    const v = Math.sin(2 * Math.PI * freq * t + idx * Math.sin(2 * Math.PI * freq * ratio * t))
    out[i] = v * Math.exp(-decay * t) * Math.min(1, i / a) * gain
  }
  return out
}

/**
 * Tick: a one-pole high-passed noise burst under a fast exponential decay,
 * plus an optional sine blip at `tone` Hz. A key or relay click.
 */
export function tick(seconds, { gain = 1, decay = 260, tone = 0, toneGain = 0.4, hp = 0.92 } = {}) {
  const out = buffer(seconds)
  let prevX = 0
  let prevY = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const x = rand() * 2 - 1
    const y = hp * (prevY + x - prevX)
    prevX = x
    prevY = y
    let v = y * Math.exp(-decay * t)
    if (tone) v += toneGain * Math.sin(2 * Math.PI * tone * t) * Math.exp(-decay * 0.25 * t)
    out[i] = v * gain
  }
  return out
}

/**
 * Band-limited sawtooth: additive harmonics up to 0.45 x SR, so nothing
 * aliases. `detune` adds a second voice that many cents sharp.
 */
export function saw(freq, seconds, { gain = 0.5, decay = 6, detune = 0, attack = 0.004 } = {}) {
  const out = buffer(seconds)
  const voices = detune ? [freq, freq * 2 ** (detune / 1200)] : [freq]
  const a = attack * SR
  for (const f of voices) {
    const harmonics = Math.floor((SR * 0.45) / f)
    for (let i = 0; i < out.length; i++) {
      const t = i / SR
      let v = 0
      for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * f * h * t) / h
      out[i] += (v * 0.6 * Math.exp(-decay * t) * Math.min(1, i / a) * gain) / voices.length
    }
  }
  return out
}

/**
 * PolyBLEP sawtooth gliding exponentially from f0 to f1 over `glide` seconds.
 * The BLEP residual rounds each wrap, which removes most aliasing at a
 * fraction of additive synthesis's cost.
 */
export function glideSaw(f0, f1, seconds, { glide = seconds, gain = 1 } = {}) {
  const out = buffer(seconds)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const f = f0 * (f1 / f0) ** Math.min(1, t / glide)
    const dt = f / SR
    phase += dt
    if (phase >= 1) phase -= 1
    let v = 2 * phase - 1
    if (phase < dt) {
      const x = phase / dt
      v -= x + x - x * x - 1
    } else if (phase > 1 - dt) {
      const x = (phase - 1) / dt
      v -= x * x + x + x + 1
    }
    out[i] = v * gain
  }
  return out
}

/**
 * Resonant state-variable filter (Simper's trapezoidal SVF); returns a new
 * buffer.
 * Cutoff sweeps exponentially from `from` to `to` Hz over the buffer; `q` is
 * resonance (0.5 flat, 8 ringing). `mode` is 'low', 'band' or 'high'.
 */
export function svf(input, { from, to = from, q = 0.7, mode = 'low' }) {
  let ic1 = 0
  let ic2 = 0
  const k = 1 / q
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const p = i / input.length
    const fc = Math.min(SR * 0.45, from * (to / from) ** p)
    const g = Math.tan((Math.PI * fc) / SR)
    const a1 = 1 / (1 + g * (g + k))
    const a2 = g * a1
    const a3 = g * a2
    const v3 = input[i] - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    out[i] = mode === 'band' ? v1 : mode === 'high' ? input[i] - k * v1 - v2 : v2
  }
  return out
}

/** Multiplies a buffer by an attack-decay envelope: linear rise, exponential fall. */
export function envelope(input, { attack = 0.005, decay = 8 } = {}) {
  const a = attack * SR
  return input.map((v, i) => v * Math.min(1, i / a) * Math.exp(-decay * (i / SR)))
}

/** Places [startSeconds, buffer] events on a timeline of `seconds`. */
export function mix(seconds, events) {
  const out = buffer(seconds)
  for (const [start, buf] of events) {
    const o = Math.round(start * SR)
    for (let i = 0; i < buf.length && o + i < out.length; i++) out[o + i] += buf[i]
  }
  return out
}

/** Schroeder reverb (4 combs, 2 allpasses, Freeverb tunings scaled to SR); `wet` is the reverb share. */
export function reverb(input, { wet = 0.22, room = 0.8, damp = 0.3 } = {}) {
  const scale = SR / 44100
  const combs = [1116, 1188, 1277, 1356].map((n) => ({
    buf: new Float32Array(Math.round(n * scale)), i: 0, store: 0,
  }))
  const allpasses = [556, 441].map((n) => ({ buf: new Float32Array(Math.round(n * scale)), i: 0 }))
  const out = new Float32Array(input.length)
  for (let n = 0; n < input.length; n++) {
    const x = input[n] * 0.2
    let acc = 0
    for (const c of combs) {
      const y = c.buf[c.i]
      c.store = y * (1 - damp) + c.store * damp
      c.buf[c.i] = x + c.store * room
      c.i = (c.i + 1) % c.buf.length
      acc += y
    }
    for (const a of allpasses) {
      const b = a.buf[a.i]
      a.buf[a.i] = acc + b * 0.5
      a.i = (a.i + 1) % a.buf.length
      acc = b - acc
    }
    out[n] = input[n] * (1 - wet) + acc * wet
  }
  return out
}

/** Scales to `peakDb` dBFS and fades the last 8 ms to silence. */
export function finish(samples, peakDb) {
  let peak = 0
  for (const v of samples) peak = Math.max(peak, Math.abs(v))
  const g = peak > 0 ? 10 ** (peakDb / 20) / peak : 0
  const fade = Math.round(0.008 * SR)
  return samples.map((v, i) => v * g * Math.min(1, (samples.length - 1 - i) / fade))
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SR, 24)
  header.writeUInt32LE(SR * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Renders `sounds` ({ action: () => Float32Array }) to `<outDir>/<action>.mp3`
 * and writes the harmony-audio-pack manifest.json beside them.
 */
export function writePack(outDir, theme, sounds) {
  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(join(tmpdir(), `${theme.id}-`))
  try {
    for (const [name, build] of Object.entries(sounds)) {
      seed = SEED
      const wavPath = join(tmp, `${name}.wav`)
      writeFileSync(wavPath, wav(build()))
      execFileSync('ffmpeg', [
        '-v', 'error', '-y', '-i', wavPath,
        '-codec:a', 'libmp3lame', '-b:a', '128k', '-ac', '1', '-ar', String(SR),
        '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '0',
        join(outDir, `${name}.mp3`),
      ])
      process.stdout.write(`${name}.mp3\n`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const manifest = {
    format: 'harmony-audio-pack',
    version: 1,
    theme: {
      ...theme,
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      sounds: Object.fromEntries(Object.keys(sounds).map((k) => [k, `${k}.mp3`])),
    },
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}
