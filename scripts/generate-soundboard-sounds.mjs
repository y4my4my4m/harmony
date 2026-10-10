#!/usr/bin/env node
// Built-in soundboard clips, synthesized from oscillators and seeded noise; no samples.
// Writes public/assets/sounds/soundboard/<key>.mp3 (mono, 44.1 kHz, 96 kbit/s) through ffmpeg
// with libmp3lame. Output is deterministic for a given ffmpeg build.
//
//   node scripts/generate-soundboard-sounds.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'sounds', 'soundboard');

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds) => new Float64Array(Math.round(seconds * RATE));

function addAt(target, source, atSeconds, gain = 1) {
  const offset = Math.round(atSeconds * RATE);
  for (let i = 0; i < source.length && offset + i < target.length; i++) target[offset + i] += source[i] * gain;
}

// Linear attack, exponential decay with time constant tau (s).
function envelope(i, attack, tau) {
  const t = i / RATE;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  return a * Math.exp(-t / tau);
}

// Fixed-length fade at both ends so no clip starts or stops on a click.
function edges(samples, fadeIn = 0.003, fadeOut = 0.03) {
  const fi = Math.round(fadeIn * RATE);
  const fo = Math.round(fadeOut * RATE);
  for (let i = 0; i < fi && i < samples.length; i++) samples[i] *= i / fi;
  for (let i = 0; i < fo && i < samples.length; i++) samples[samples.length - 1 - i] *= i / fo;
  return samples;
}

// Gain to an RMS of rmsDb dBFS, capped so the peak stays at or below peakDb dBFS; clips of
// different character come out about equally loud.
function normalize(samples, peakDb = -1, rmsDb = -16) {
  let peak = 0;
  let sum = 0;
  for (const s of samples) {
    peak = Math.max(peak, Math.abs(s));
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (peak === 0) return samples;
  const gain = Math.min(Math.pow(10, peakDb / 20) / peak, Math.pow(10, rmsDb / 20) / rms);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}

// RBJ cookbook band-pass (constant 0 dB peak gain), coefficients per sample.
function bandpass(input, centerAt, q) {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const w0 = (2 * Math.PI * centerAt(i / RATE)) / RATE;
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0;
    const a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
    const y = b0 * input[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = input[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

function onePoleLowpass(input, cutoff) {
  const out = new Float64Array(input.length);
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    y += k * (input[i] - y);
    out[i] = y;
  }
  return out;
}

function highpass(input, cutoff) {
  const low = onePoleLowpass(input, cutoff);
  return input.map((s, i) => s - low[i]);
}

function noise(seconds, seed) {
  const r = rng(seed);
  return buffer(seconds).map(() => r() * 2 - 1);
}

// Band-limited sawtooth by additive synthesis; freqAt(t) in Hz.
function saw(seconds, freqAt, harmonics = 12) {
  const out = buffer(seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = freqAt(i / RATE);
    phase += (2 * Math.PI * f) / RATE;
    let s = 0;
    for (let n = 1; n <= harmonics && n * f < RATE / 2; n++) s += Math.sin(n * phase) / n;
    out[i] = s;
  }
  return out;
}

function sine(seconds, freqAt) {
  const out = buffer(seconds);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    phase += (2 * Math.PI * freqAt(i / RATE)) / RATE;
    out[i] = Math.sin(phase);
  }
  return out;
}

// CLIPS

function ding() {
  const out = buffer(1.4);
  // Inharmonic bell partials: ratio, amplitude, decay tau (s).
  const partials = [[1, 1, 0.6], [2, 0.45, 0.35], [2.76, 0.3, 0.25], [5.4, 0.15, 0.12], [8.93, 0.08, 0.07]];
  const f0 = 880;
  for (const [ratio, amp, tau] of partials) {
    const tone = sine(1.4, () => f0 * ratio);
    for (let i = 0; i < out.length; i++) out[i] += tone[i] * amp * envelope(i, 0.002, tau);
  }
  return edges(normalize(out));
}

function tada() {
  const out = buffer(1.3);
  const chord = [523.25, 659.25, 783.99, 1046.5];
  const note = (seconds, attack, release, vibrato) => chord.map((f) => {
    const tone = onePoleLowpass(saw(seconds, (t) => f * (1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t))), 3200);
    for (let i = 0; i < tone.length; i++) {
      const t = i / RATE;
      const a = Math.min(1, t / attack);
      const r = Math.min(1, Math.max(0, (seconds - t) / release));
      tone[i] *= a * r;
    }
    return tone;
  });
  for (const tone of note(0.11, 0.01, 0.03, 0)) addAt(out, tone, 0, 0.6);
  for (const tone of note(1.12, 0.02, 0.5, 0.006)) addAt(out, tone, 0.16, 0.8);
  return edges(normalize(out));
}

function rimshot() {
  const out = buffer(1.3);
  const tom = (from, to) => {
    const body = sine(0.35, (t) => to + (from - to) * Math.exp(-t / 0.04));
    for (let i = 0; i < body.length; i++) body[i] *= envelope(i, 0.001, 0.09);
    return body;
  };
  addAt(out, tom(190, 110), 0.0, 0.9);
  addAt(out, tom(150, 85), 0.17, 1.0);

  const snare = highpass(noise(0.25, 7), 1800);
  const snareTone = sine(0.25, () => 190);
  for (let i = 0; i < snare.length; i++) {
    snare[i] = (snare[i] * 0.8 + snareTone[i] * 0.5) * envelope(i, 0.001, 0.05);
  }
  addAt(out, snare, 0.42, 0.9);

  const cymbal = highpass(highpass(noise(0.85, 11), 5000), 5000);
  for (let i = 0; i < cymbal.length; i++) cymbal[i] *= envelope(i, 0.002, 0.28);
  addAt(out, cymbal, 0.42, 1.4);
  return edges(normalize(out));
}

function sadTrombone() {
  const out = buffer(2.6);
  // Descending semitones; each note sags a little in pitch, the last wobbles.
  const notes = [[293.66, 0.0, 0.42], [277.18, 0.47, 0.42], [261.63, 0.94, 0.42], [246.94, 1.41, 1.15]];
  notes.forEach(([f, at, seconds], index) => {
    const last = index === notes.length - 1;
    const tone = onePoleLowpass(saw(seconds, (t) => {
      const sag = 1 - 0.012 * (t / seconds);
      const wobble = last ? 1 + 0.018 * Math.sin(2 * Math.PI * 5 * t) * Math.min(1, t / 0.25) : 1;
      return f * sag * wobble;
    }, 16), 1400);
    for (let i = 0; i < tone.length; i++) {
      const t = i / RATE;
      const a = Math.min(1, t / 0.04);
      const r = Math.min(1, Math.max(0, (seconds - t) / (last ? 0.5 : 0.08)));
      tone[i] *= a * r;
    }
    addAt(out, tone, at, 1);
  });
  return edges(normalize(out));
}

function boing() {
  const seconds = 0.7;
  const out = sine(seconds, (t) => {
    const glide = 160 + 380 * (1 - Math.exp(-t / 0.08));
    const wobble = 1 + 0.12 * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * 14 * t);
    return glide * wobble;
  });
  const overtone = sine(seconds, (t) => 2 * (160 + 380 * (1 - Math.exp(-t / 0.08))));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] + 0.25 * overtone[i]) * envelope(i, 0.004, 0.22);
  return edges(normalize(out));
}

function whoosh() {
  const seconds = 0.8;
  const swept = bandpass(noise(seconds, 23), (t) => {
    const x = t / seconds;
    return x < 0.55 ? 300 + 2700 * (x / 0.55) : 3000 - 2200 * ((x - 0.55) / 0.45);
  }, 2.5);
  for (let i = 0; i < swept.length; i++) {
    const x = i / swept.length;
    swept[i] *= Math.sin(Math.PI * Math.min(1, x / 0.9)) ** 2;
  }
  return edges(normalize(swept), 0.003, 0.05);
}

const CLIPS = { ding, tada, rimshot, 'sad-trombone': sadTrombone, boing, whoosh };

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

mkdirSync(OUT_DIR, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'soundboard-'));
try {
  for (const [key, make] of Object.entries(CLIPS)) {
    const samples = make();
    const source = join(work, `${key}.wav`);
    writeFileSync(source, wav(samples));
    const target = join(OUT_DIR, `${key}.mp3`);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
      '-ac', '1', '-ar', String(RATE), '-codec:a', 'libmp3lame', '-b:a', '96k', target,
    ]);
    console.log(`${key}.mp3  ${Math.round((samples.length / RATE) * 1000)} ms`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
