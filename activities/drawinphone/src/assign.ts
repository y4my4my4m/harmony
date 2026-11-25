/**
 * Who handles which chain at which step.
 *
 * Chain c starts with seat c. At step s it is handled by seat (c + offset[s]) mod n. offset[0] is 0
 * and offset[1..n-1] is a seeded permutation of 1..n-1, so in one lap every seat handles every chain
 * exactly once, every step is a permutation of seats, and consecutive steps of a chain always have
 * different hands. Because the differences between consecutive offsets vary, a seat does not always
 * receive from the same neighbour. Marathon repeats the lap (offset[n + k] = offset[k]).
 */

export type Mode = 'classic' | 'speed' | 'marathon'
export type StepKind = 'write' | 'draw' | 'describe'

export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 16
export const MAX_STEPS = 16

/** mulberry32: 32-bit seed, uniform floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function stepKind(step: number): StepKind {
  if (step === 0) return 'write'
  return step % 2 === 1 ? 'draw' : 'describe'
}

export function stepCount(players: number, mode: Mode): number {
  const n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, players))
  return mode === 'marathon' ? Math.min(2 * n, MAX_STEPS) : n
}

export function offsets(players: number, steps: number, seed: number): number[] {
  const random = rng(seed)
  const lap = Array.from({ length: players - 1 }, (_, i) => i + 1)
  for (let i = lap.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[lap[i], lap[j]] = [lap[j], lap[i]]
  }
  const one = [0, ...lap]
  return Array.from({ length: steps }, (_, s) => one[s % players])
}

/** Seat handling `chain` at `step`. */
export function handler(chain: number, step: number, players: number, offs: number[]): number {
  return (chain + offs[step]) % players
}

/** Chain `seat` handles at `step`. */
export function chainOf(seat: number, step: number, players: number, offs: number[]): number {
  return (((seat - offs[step]) % players) + players) % players
}
