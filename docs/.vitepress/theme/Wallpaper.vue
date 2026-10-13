<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { wallpaper } from './wallpaper'

/**
 * Desktop wallpaper: a grid of monospace cells filled with scrolling chat text.
 * Each cell's brightness follows a Chladni figure, the nodal lines sand traces on a
 * plate vibrating at one of its modes:
 *   f(x, y) = cos(nπx)·cos(mπy) − cos(mπx)·cos(nπy),  bright where f ≈ 0.
 * Modes cross-fade on change. The pointer is a damped ripple added to f.
 */

const CORPUS = [
  'anyone up for a raid tonight?', '@mira@har.mony.lol pushed the new map', 'kei joined #playtest from harbor.city',
  'brb making tea', 'gg wp', 'who has the invite for the art server', 'theo is streaming in #war-room',
  'new thread: patch notes', 'boosted by @nyx@mastodon.social', 'lol same', 'can we get a #memes channel',
  'voice in 5?', 'welcome @sam, say hi', 'pinned a message', 'reacted :heart:', 'following @ana@pixelfed.social',
  'spatial audio is wild', 'drag me closer, cannot hear you', 'bridged from discord #general', 'my instance, my rules',
  'harmony doctor: all checks passed', 'who wants to playtest', 'meet in the lobby', 'ok who broke the bot',
  '!roll d20', 'rolled a 17', 'export done, moving to my own server', 'my followers moved with me',
  'quoted a post from misskey.io', 'screen share is up', 'mod note: be kind', 'poll: pizza or tacos',
  'thread has 42 replies', '@here stream starts now', 'good morning from osaka', 'night all',
  'Follow -> Accept', 'Create(Note)', 'Announce', 'Like', 'webhook posted to #ci', 'build passed',
  'is the server up? yes', 'new emoji just dropped', ':wave:', 'typing...', 'lgtm', 'shipping it',
].join('    ')

const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }'

// Pass 1 runs once per cell into a cols × rows target: R = line brightness, G = halo, B = quiet.
const CELL_FRAG = `
precision highp float;
uniform vec2 u_grid;
uniform vec2 u_css;
uniform vec2 u_cell;
uniform float u_time;
uniform vec2 u_modeA;
uniform vec2 u_modeB;
uniform float u_mix;
uniform float u_plate;
uniform float u_scroll;
uniform vec3 u_pointer;
uniform vec4 u_quiet[8];
uniform int u_quietCount;

const float PI = 3.14159265;

float chladni(vec2 p, vec2 nm) {
  return cos(nm.x * PI * p.x) * cos(nm.y * PI * p.y) - cos(nm.y * PI * p.x) * cos(nm.x * PI * p.y);
}

float field(vec2 c, float t) {
  vec2 p = (c - 0.5 * u_css + vec2(0.0, u_scroll * 0.08)) / u_plate;
  p += 0.012 * vec2(sin(t * 0.21 + p.y * 2.0), cos(t * 0.17 + p.x * 2.0));
  float r = length(c - u_pointer.xy);
  float ripple = u_pointer.z * sin(r * 0.05 - t * 6.0) * exp(-r / 170.0);
  return mix(chladni(p, u_modeA), chladni(p, u_modeB), u_mix) + ripple * 0.55;
}

float quiet(vec2 c) {
  float q = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= u_quietCount) break;
    vec4 r = u_quiet[i];
    vec2 d = max(r.xy - c, c - (r.xy + r.zw));
    float outside = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
    q = max(q, 1.0 - smoothstep(-24.0, 36.0, outside));
  }
  return q;
}

void main() {
  vec2 cell = vec2(floor(gl_FragCoord.x), u_grid.y - 1.0 - floor(gl_FragCoord.y));
  vec2 cc = (cell + 0.5) * u_cell;
  float t = u_time;

  // Distance to the nearest nodal line in CSS px: |f| / |grad f|.
  float f = field(cc, t);
  float gx = (field(cc + vec2(u_cell.x, 0.0), t) - f) / u_cell.x;
  float gy = (field(cc + vec2(0.0, u_cell.y), t) - f) / u_cell.y;
  float dist = abs(f) / max(length(vec2(gx, gy)), 1e-5);
  float core = u_cell.y * (0.7 + 0.1 * sin(t * 0.6));
  float b = exp(-(dist * dist) / (core * core));
  float halo = exp(-(dist * dist) / (16.0 * core * core));
  gl_FragColor = vec4(b, halo, quiet(cc), 1.0);
}
`

// Pass 2 runs per pixel: picks the cell's glyph and draws it.
const GLYPH_FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_time;
uniform vec2 u_cell;
uniform vec2 u_grid;
uniform sampler2D u_cells;
uniform sampler2D u_atlas;
uniform vec2 u_atlasGrid;
uniform sampler2D u_text;
uniform vec2 u_textSize;
uniform float u_scroll;
uniform float u_intensity;
uniform vec3 u_dim;
uniform vec3 u_hot;
uniform vec3 u_white;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 css = u_res / u_dpr;
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_dpr;
  vec2 cell = floor(frag / u_cell);
  vec2 inCell = fract(frag / u_cell);
  float t = u_time;

  vec4 v = texture2D(u_cells, vec2(cell.x + 0.5, u_grid.y - cell.y - 0.5) / u_grid);
  float b = v.r;
  float halo = v.g;
  float q = v.b;

  // Character: rows of corpus text drifting at their own speed.
  float row = cell.y + floor(u_scroll * 0.08 / u_cell.y);
  float speed = (hash(vec2(row, 7.0)) - 0.5) * 5.0;
  float idx = cell.x + floor(t * speed) + row * 131.0;
  float total = u_textSize.x * u_textSize.y;
  idx = mod(idx, total);
  vec2 tuv = (vec2(mod(idx, u_textSize.x), floor(idx / u_textSize.x)) + 0.5) / u_textSize;
  float code = floor(texture2D(u_text, tuv).r * 255.0 + 0.5);

  // Sand never leaves gaps on a line: spaces there become glyphs, and some flicker.
  float h = hash(cell + floor(t * 7.0));
  if (b > 0.35 && code < 0.5) { float k = floor(hash(cell) * 4.0); code = k < 1.0 ? 10.0 : k < 2.0 ? 11.0 : k < 3.0 ? 13.0 : 29.0; }
  if (b > 0.6 && h > 0.94) code = 33.0 + floor(fract(h * 7.0) * 58.0);

  float alpha = 0.045 + 0.06 * halo + 0.85 * b;
  vec3 col = mix(u_dim, u_hot, smoothstep(0.12, 0.65, b));
  col = mix(col, u_white, smoothstep(0.9, 1.0, b) * 0.6);

  alpha *= 0.86 + 0.14 * hash(cell + floor(t * 2.0) * 0.37);

  vec2 a = vec2(mod(code, u_atlasGrid.x), floor(code / u_atlasGrid.x));
  float glyph = texture2D(u_atlas, (a + inCell) / u_atlasGrid).r;

  vec2 vv = frag / css - 0.5;
  float vignette = smoothstep(0.95, 0.25, length(vv * vec2(1.0, 1.25)));
  alpha *= glyph * mix(0.55, 1.0, vignette) * u_intensity * (1.0 - 0.8 * q);

  gl_FragColor = vec4(col * alpha, alpha);
}
`

const canvas = ref<HTMLCanvasElement | null>(null)
const failed = ref(false)

let gl: WebGLRenderingContext | null = null
let cellProg: WebGLProgram | null = null
let glyphProg: WebGLProgram | null = null
const UC: Record<string, WebGLUniformLocation | null> = {}
const UG: Record<string, WebGLUniformLocation | null> = {}
let raf = 0
let running = false
let reduced = false
let cssW = 0
let cssH = 0
let dpr = 1
let cell: [number, number] = [9, 15]
let grid: [number, number] = [1, 1]
let atlasTex: WebGLTexture | null = null
let textTex: WebGLTexture | null = null
let cellTex: WebGLTexture | null = null
let cellFbo: WebGLFramebuffer | null = null
let textSize: [number, number] = [1024, 8]
let laidOut = false
let t0 = 0
let lastDraw = 0

const modeA: [number, number] = [wallpaper.mode[0], wallpaper.mode[1]]
const modeB: [number, number] = [wallpaper.mode[0], wallpaper.mode[1]]
let mixStart = -1
let mixVal = 0
const MIX_MS = 1600

const pointer = { x: -9999, y: -9999, tx: -9999, ty: -9999, amp: 0 }
let intensity = wallpaper.intensity
let quietEls: HTMLElement[] = []
let quietScan = -Infinity
const quietRects = new Float32Array(32)

function compile(type: number, src: string): WebGLShader {
  const s = gl!.createShader(type)!
  gl!.shaderSource(s, src)
  gl!.compileShader(s)
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) ?? 'shader')
  return s
}

function program(frag: string, names: string[], into: Record<string, WebGLUniformLocation | null>): WebGLProgram {
  const p = gl!.createProgram()!
  gl!.attachShader(p, compile(gl!.VERTEX_SHADER, VERT))
  gl!.attachShader(p, compile(gl!.FRAGMENT_SHADER, frag))
  gl!.bindAttribLocation(p, 0, 'p')
  gl!.linkProgram(p)
  if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) throw new Error(gl!.getProgramInfoLog(p) ?? 'link')
  for (const n of names) into[n] = gl!.getUniformLocation(p, n)
  return p
}

function texture(filter: number): WebGLTexture {
  const tex = gl!.createTexture()!
  gl!.bindTexture(gl!.TEXTURE_2D, tex)
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter)
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter)
  return tex
}

/** 95 printable ASCII glyphs (code − 32) on a 16 × 6 grid of cells. */
function buildAtlas() {
  const pw = Math.round(cell[0] * dpr)
  const ph = Math.round(cell[1] * dpr)
  const c = document.createElement('canvas')
  c.width = 16 * pw
  c.height = 6 * ph
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  if ('fontStretch' in g) g.fontStretch = 'condensed'
  let size = ph * 0.74
  g.font = `600 ${size}px "Martian Mono Variable", ui-monospace, monospace`
  const w = g.measureText('M').width
  if (w > pw * 0.9) {
    size *= (pw * 0.9) / w
    g.font = `600 ${size}px "Martian Mono Variable", ui-monospace, monospace`
  }
  for (let i = 0; i < 95; i++) {
    g.fillText(String.fromCharCode(32 + i), (i % 16) * pw + pw / 2, Math.floor(i / 16) * ph + ph / 2 + ph * 0.04)
  }
  gl!.bindTexture(gl!.TEXTURE_2D, atlasTex)
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, c)
}

function buildText() {
  const width = 1024
  const rows = 8
  const data = new Uint8Array(width * rows)
  for (let i = 0; i < data.length; i++) {
    const code = CORPUS.charCodeAt(i % CORPUS.length)
    data[i] = code >= 32 && code < 127 ? code - 32 : 0
  }
  textSize = [width, rows]
  gl!.bindTexture(gl!.TEXTURE_2D, textTex)
  gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1)
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.LUMINANCE, width, rows, 0, gl!.LUMINANCE, gl!.UNSIGNED_BYTE, data)
}

/** Riso inks: warm black text, mascot blue lines, red-orange cores; paper-white text in dark mode. */
function setInks() {
  if (!gl || !glyphProg) return
  gl.useProgram(glyphProg)
  if (wallpaper.dark) gl.uniform3f(UG.u_dim!, 0.86, 0.84, 0.8)
  else gl.uniform3f(UG.u_dim!, 26 / 255, 23 / 255, 18 / 255)
  gl.uniform3f(UG.u_hot!, 14 / 255, 165 / 255, 233 / 255)
  gl.uniform3f(UG.u_white!, 235 / 255, 78 / 255, 44 / 255)
}

function setup(): boolean {
  const c = canvas.value
  if (!c) return false
  gl = c.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true })
  if (!gl) return false
  try {
    cellProg = program(CELL_FRAG, ['u_grid', 'u_css', 'u_cell', 'u_time', 'u_modeA', 'u_modeB', 'u_mix', 'u_plate', 'u_scroll', 'u_pointer', 'u_quiet', 'u_quietCount'], UC)
    glyphProg = program(GLYPH_FRAG, ['u_res', 'u_dpr', 'u_time', 'u_cell', 'u_grid', 'u_cells', 'u_atlas', 'u_atlasGrid', 'u_text', 'u_textSize', 'u_scroll', 'u_intensity', 'u_dim', 'u_hot', 'u_white'], UG)
  } catch {
    return false
  }
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  gl.useProgram(glyphProg)
  setInks()
  gl.uniform1i(UG.u_atlas!, 0)
  gl.uniform1i(UG.u_text!, 1)
  gl.uniform1i(UG.u_cells!, 2)

  atlasTex = texture(gl.LINEAR)
  textTex = texture(gl.NEAREST)
  cellTex = texture(gl.NEAREST)
  cellFbo = gl.createFramebuffer()
  buildText()
  return true
}

function layout() {
  const c = canvas.value
  if (!c || !gl) return
  cssW = window.innerWidth
  cssH = window.innerHeight
  dpr = Math.min(window.devicePixelRatio || 1, cssW < 700 ? 1.5 : 2)
  cell = cssW < 700 ? [8, 13] : [9, 15]
  grid = [Math.ceil(cssW / cell[0]) + 1, Math.ceil(cssH / cell[1]) + 1]
  c.width = Math.round(cssW * dpr)
  c.height = Math.round(cssH * dpr)
  gl.bindTexture(gl.TEXTURE_2D, cellTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, grid[0], grid[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.bindFramebuffer(gl.FRAMEBUFFER, cellFbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cellTex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  buildAtlas()
  laidOut = true
}

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

function draw(now: number) {
  if (!gl || !laidOut) return
  const time = reduced ? 12 : (now - t0) / 1000

  if (mixStart >= 0) {
    const k = reduced ? 1 : Math.min(1, (now - mixStart) / MIX_MS)
    mixVal = easeInOut(k)
    if (k >= 1) {
      modeA[0] = modeB[0]
      modeA[1] = modeB[1]
      mixVal = 0
      mixStart = -1
    }
  }

  // Per-frame smoothing constants are tuned at 60 fps and scaled by elapsed time.
  const dt = lastDraw ? Math.min(100, now - lastDraw) / 16.67 : 1
  lastDraw = now
  const ease = (k: number) => 1 - Math.pow(1 - k, dt)
  pointer.x += (pointer.tx - pointer.x) * ease(0.2)
  pointer.y += (pointer.ty - pointer.y) * ease(0.2)
  pointer.amp *= Math.pow(0.965, dt)

  if (reduced || now - quietScan > 600) {
    quietEls = Array.from(document.querySelectorAll<HTMLElement>('[data-quiet]'))
    quietScan = now
  }
  let quietCount = 0
  for (const q of quietEls) {
    if (quietCount >= 8) break
    const r = q.getBoundingClientRect()
    if (r.bottom < -40 || r.top > cssH + 40 || r.width === 0) continue
    quietRects.set([r.left, r.top, r.width, r.height], quietCount * 4)
    quietCount++
  }
  intensity += (wallpaper.intensity - intensity) * (reduced ? 1 : ease(0.06))
  const scroll = window.scrollY

  gl.bindFramebuffer(gl.FRAMEBUFFER, cellFbo)
  gl.viewport(0, 0, grid[0], grid[1])
  gl.useProgram(cellProg)
  gl.uniform2f(UC.u_grid!, grid[0], grid[1])
  gl.uniform2f(UC.u_css!, cssW, cssH)
  gl.uniform2f(UC.u_cell!, cell[0], cell[1])
  gl.uniform1f(UC.u_time!, time)
  gl.uniform2f(UC.u_modeA!, modeA[0], modeA[1])
  gl.uniform2f(UC.u_modeB!, modeB[0], modeB[1])
  gl.uniform1f(UC.u_mix!, mixVal)
  gl.uniform1f(UC.u_plate!, Math.max(cssW, cssH) * 0.95)
  gl.uniform1f(UC.u_scroll!, scroll)
  gl.uniform3f(UC.u_pointer!, pointer.x, pointer.y, reduced ? 0 : pointer.amp)
  gl.uniform4fv(UC.u_quiet!, quietRects)
  gl.uniform1i(UC.u_quietCount!, quietCount)
  gl.drawArrays(gl.TRIANGLES, 0, 6)

  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(0, 0, canvas.value!.width, canvas.value!.height)
  gl.useProgram(glyphProg)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, atlasTex)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, textTex)
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, cellTex)
  gl.uniform2f(UG.u_res!, canvas.value!.width, canvas.value!.height)
  gl.uniform1f(UG.u_dpr!, dpr)
  gl.uniform1f(UG.u_time!, time)
  gl.uniform2f(UG.u_cell!, cell[0], cell[1])
  gl.uniform2f(UG.u_grid!, grid[0], grid[1])
  gl.uniform2f(UG.u_atlasGrid!, 16, 6)
  gl.uniform2f(UG.u_textSize!, textSize[0], textSize[1])
  gl.uniform1f(UG.u_scroll!, scroll)
  gl.uniform1f(UG.u_intensity!, intensity)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 6)
}

let lastFrame = 0

/** Full rate while the pointer ripples or a mode cross-fades, 30 fps otherwise. */
function loop(now: number) {
  if (!running) return
  const busy = pointer.amp > 0.02 || mixStart >= 0
  if (busy || now - lastFrame >= 32) {
    lastFrame = now
    draw(now)
  }
  raf = requestAnimationFrame(loop)
}

function start() {
  if (running || reduced || !gl) return
  running = true
  raf = requestAnimationFrame(loop)
}

function stop() {
  running = false
  cancelAnimationFrame(raf)
}

function redrawStill() {
  if (!running) requestAnimationFrame(draw)
}

function onPointer(e: PointerEvent) {
  if (e.pointerType === 'touch') return
  if (pointer.tx < -9000) {
    pointer.x = e.clientX
    pointer.y = e.clientY
  }
  pointer.tx = e.clientX
  pointer.ty = e.clientY
  pointer.amp = Math.min(1, pointer.amp + 0.08)
}

function onVisibility() {
  if (document.hidden) stop()
  else start()
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null
function onResize() {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    layout()
    redrawStill()
  }, 120)
}

watch(
  () => [wallpaper.mode[0], wallpaper.mode[1]] as const,
  ([n, m]) => {
    if (n === modeB[0] && m === modeB[1]) return
    if (mixStart >= 0 && mixVal > 0.5) {
      modeA[0] = modeB[0]
      modeA[1] = modeB[1]
    }
    modeB[0] = n
    modeB[1] = m
    mixStart = performance.now()
    mixVal = 0
    redrawStill()
  },
)

watch(
  () => wallpaper.dark,
  () => {
    setInks()
    redrawStill()
  },
)

onMounted(async () => {
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!setup()) {
    failed.value = true
    return
  }
  try {
    await document.fonts.load('500 15px "Martian Mono Variable"')
  } catch {
    // Atlas falls back to the system monospace face.
  }
  layout()
  t0 = performance.now()
  window.addEventListener('pointermove', onPointer, { passive: true })
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  if (reduced) {
    draw(performance.now())
    window.addEventListener('scroll', redrawStill, { passive: true })
  } else {
    start()
  }
})

onUnmounted(() => {
  stop()
  window.removeEventListener('pointermove', onPointer)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', redrawStill)
  document.removeEventListener('visibilitychange', onVisibility)
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  gl = null
})

</script>

<template>
  <div class="wallpaper" :class="{ 'wallpaper--flat': failed }" aria-hidden="true">
    <canvas v-if="!failed" ref="canvas" class="wallpaper-canvas" />
  </div>
</template>

<style scoped>
.wallpaper {
  position: fixed;
  inset: 0;
  z-index: var(--z-wallpaper);
  pointer-events: none;
  background-color: var(--paper);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .1 0 0 0 0 .09 0 0 0 0 .07 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
}

.wallpaper-canvas {
  width: 100%;
  height: 100%;
}

.wallpaper--flat {
  background-image:
    radial-gradient(rgba(26, 23, 18, 0.1) 1px, transparent 1px);
  background-size: 9px 15px;
}
</style>
