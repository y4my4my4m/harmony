import { reactive } from 'vue'

export type Mode = readonly [number, number]

export const wallpaper = reactive({
  mode: [4, 7] as [number, number],
  intensity: 0.4,
  dark: false,
})

const MODES: Mode[] = [
  [4, 7], [2, 7], [3, 8], [5, 9], [1, 6], [3, 5], [2, 9], [5, 8], [1, 8], [6, 11], [4, 9], [3, 7],
]

/** Each page path gets its own figure. */
export function modeForPath(path: string): [number, number] {
  let h = 0
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0
  const m = MODES[Math.abs(h) % MODES.length]!
  return [m[0], m[1]]
}
