/**
 * Flux scene.
 *
 * 1. Liquid field: a WebGL metaball field behind the app. Seven balls drift
 *    on Lissajous paths and merge where they meet; four orbit rings turn
 *    slowly behind them. Light comes from the upper left. Nothing tracks the
 *    pointer.
 * 2. Lens: the SVG filter the stylesheet puts in the backdrop-filter of
 *    liquid-glass controls to bend what is behind their rims. Chromium alone
 *    renders url() in backdrop-filter; WebKit and Gecko draw nothing for the
 *    whole declaration, so <html data-flux-lens="on"> is set for Chromium only.
 * 3. Dock: in the horizontal layout, rail tooltips are given the hovered
 *    icon's position (--flux-tip-x / --flux-tip-y on body; the component
 *    assumes a vertical rail at x = 80px), and a vertical wheel scrolls the
 *    dock and the channel strip sideways.
 *
 * The field renders at RENDER_SCALE of the viewport. With drift on it draws
 * at DRIFT_FPS while the window is focused and visible; otherwise it draws
 * once per change. With reduced motion it never drifts.
 */
import type { SkinScene } from '../types'

const RENDER_SCALE = 0.5
const DRIFT_FPS = 20
const BALLS = 7
/** Width at and above which the stylesheet uses the horizontal layout. */
const DOCK_QUERY = '(min-width: 1024px)'

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

// Units: viewport heights, origin bottom-left; squared distances stay under
// ~4. The normal is a central difference over two render pixels, which
// mediump's 10-bit mantissa turns to speckle, so highp where the GPU has it.
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uBalls[${BALLS}];
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uRings;
uniform float uLiquid;
uniform float uDark;

float field(vec2 p) {
  float s = 0.0;
  for (int i = 0; i < ${BALLS}; i++) {
    vec2 d = p - uBalls[i].xy;
    float r = uBalls[i].z;
    s += r * r / (dot(d, d) + 0.0004);
  }
  return s;
}

// Thin-film interference approximated by a cosine palette.
vec3 film(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 p = gl_FragCoord.xy / uRes.y;
  vec2 view = vec2(uRes.x / uRes.y, 1.0);
  vec3 pm = vec3(0.0);
  float a = 0.0;

  if (uRings > 0.5) {
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 q = p - view * 0.5;
      float d = length(q);
      float rr = 0.34 + 0.2 * fi;
      float line = 1.0 - smoothstep(0.0, 1.6 / uRes.y, abs(d - rr));
      float ang = atan(q.y, q.x);
      float lit = pow(0.5 + 0.5 * sin(ang + uTime * (0.06 + 0.025 * fi) + fi * 1.9), 3.0);
      vec3 rc = i == 0 ? vec3(1.0, 0.27, 0.33) : i == 1 ? vec3(0.3, 0.95, 0.5) : i == 2 ? vec3(0.32, 0.5, 1.0) : vec3(0.78, 0.45, 1.0);
      float k = line * (0.12 + 0.6 * lit) * mix(0.75, 0.5, uDark);
      pm += rc * k;
      a += k;
    }
  }

  if (uLiquid > 0.5) {
    float f = field(p);
    float e = 2.0 / uRes.y;
    vec2 g = vec2(field(p + vec2(e, 0.0)) - field(p - vec2(e, 0.0)),
                  field(p + vec2(0.0, e)) - field(p - vec2(0.0, e))) / (2.0 * e);
    float edge = smoothstep(0.96, 1.04, f);
    // Surface height 1 - 1/f: a paraboloid per ball, steep at the rim, where
    // the raw field gradient would blow up at each centre. Merged balls keep
    // a dome each, which the specular picks out as speckles, so the slope
    // fades to a plateau between f = 2 and 3.5.
    vec2 slope = g / max(f * f, 1.0) * (1.0 - smoothstep(2.0, 3.5, f));
    vec3 n = normalize(vec3(-slope * 0.07, 1.0));
    vec3 L = normalize(vec3(-0.55, 0.65, 0.5));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float diff = clamp(dot(n, L), 0.0, 1.0);
    float nh = clamp(dot(n, H), 0.0, 1.0);
    float spec = pow(nh, 60.0) * 1.1 + pow(nh, 8.0) * 0.2;
    float fres = pow(1.0 - n.z, 2.0);
    float flow = 0.5 + 0.5 * sin(p.x * 2.4 - p.y * 1.7 + uTime * 0.35 + n.x * 1.5);
    vec3 base = mix(uColA, uColB, flow);
    base = mix(base, vec3(1.0), (1.0 - uDark) * 0.3);
    vec3 irid = film(fres * 1.2 + flow * 0.3 + uTime * 0.02);
    vec3 liquid = mix(base * 0.22, base, 0.3 + 0.7 * diff) + irid * fres * 0.85 + vec3(spec);
    liquid += base * (smoothstep(0.96, 1.0, f) - smoothstep(1.0, 1.3, f)) * 0.7;
    float glow = smoothstep(0.22, 1.0, f) * (1.0 - edge) * 0.34;
    pm += base * glow;
    a += glow;
    pm = liquid * edge + pm * (1.0 - edge);
    a = edge + a * (1.0 - edge);
  }

  a = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(min(pm, vec3(a)), a);
}
`

/**
 * Displacement map for the lens, stretched over each control. R moves
 * samples along x and G along y, 128 meaning none; both ramp from full
 * inward at an edge to neutral 18% in, steepest at the rim, so the backdrop
 * bends under the rim and stays true across the middle.
 */
const LENS_MAP =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'%3E" +
  "%3Cdefs%3E%3ClinearGradient id='x'%3E" +
  "%3Cstop offset='0' stop-color='rgb(255,0,0)'/%3E%3Cstop offset='.05' stop-color='rgb(196,0,0)'/%3E" +
  "%3Cstop offset='.1' stop-color='rgb(158,0,0)'/%3E%3Cstop offset='.18' stop-color='rgb(128,0,0)'/%3E" +
  "%3Cstop offset='.82' stop-color='rgb(128,0,0)'/%3E%3Cstop offset='.9' stop-color='rgb(98,0,0)'/%3E" +
  "%3Cstop offset='.95' stop-color='rgb(60,0,0)'/%3E%3Cstop offset='1' stop-color='rgb(0,0,0)'/%3E" +
  "%3C/linearGradient%3E%3ClinearGradient id='y' x2='0' y2='1'%3E" +
  "%3Cstop offset='0' stop-color='rgb(0,255,0)'/%3E%3Cstop offset='.05' stop-color='rgb(0,196,0)'/%3E" +
  "%3Cstop offset='.1' stop-color='rgb(0,158,0)'/%3E%3Cstop offset='.18' stop-color='rgb(0,128,0)'/%3E" +
  "%3Cstop offset='.82' stop-color='rgb(0,128,0)'/%3E%3Cstop offset='.9' stop-color='rgb(0,98,0)'/%3E" +
  "%3Cstop offset='.95' stop-color='rgb(0,60,0)'/%3E%3Cstop offset='1' stop-color='rgb(0,0,0)'/%3E" +
  "%3C/linearGradient%3E%3C/defs%3E" +
  "%3Crect width='100' height='100' fill='url(%23x)'/%3E" +
  "%3Crect width='100' height='100' fill='url(%23y)' style='mix-blend-mode:screen'/%3E%3C/svg%3E"

/** Peak displacement at the rim, CSS px. */
const LENS_SCALE = 22

interface Drift { ax: number; ay: number; fx: number; fy: number; phase: number; r: number; cx: number; cy: number }

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/** Any CSS colour to sRGB 0..1 through a 2D context's fillStyle normaliser. */
function cssColorToRgb(ctx: CanvasRenderingContext2D, value: string, fallback: [number, number, number]): [number, number, number] {
  ctx.fillStyle = '#000'
  ctx.fillStyle = value || '#000'
  const v = String(ctx.fillStyle)
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  const m = v.match(/[\d.]+/g)
  return m && m.length >= 3 ? [+m[0] / 255, +m[1] / 255, +m[2] / 255] : fallback
}

function isChromium(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands
  return !!brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand))
}

export default function createFluxScene(): SkinScene {
  const root = document.documentElement
  const body = document.body
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const dockQuery = window.matchMedia?.(DOCK_QUERY)

  let options: Record<string, boolean> = {}
  const on = (id: string) => options[id] !== false

  // Lens filter.
  const lens = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  lens.setAttribute('aria-hidden', 'true')
  lens.setAttribute('width', '0')
  lens.setAttribute('height', '0')
  Object.assign(lens.style, { position: 'absolute', width: '0', height: '0', overflow: 'hidden' })
  lens.innerHTML = `
    <filter id="harmony-flux-lens" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feImage href="${LENS_MAP}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="${LENS_SCALE}" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`
  body.appendChild(lens)
  const chromium = isChromium()

  // Field canvas.
  const canvas = document.createElement('canvas')
  canvas.id = 'harmony-skin-scene'
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    zIndex: '-1',
    pointerEvents: 'none',
  })
  body.appendChild(canvas)

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' })
  let program: WebGLProgram | null = null
  const u: Record<string, WebGLUniformLocation | null> = {}

  function initGl(): boolean {
    if (!gl) return false
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return false
    const prog = gl.createProgram()
    if (!prog) return false
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false
    program = prog
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    // One triangle covering the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    for (const name of ['uRes', 'uTime', 'uBalls', 'uColA', 'uColB', 'uRings', 'uLiquid', 'uDark']) {
      u[name] = gl.getUniformLocation(prog, name)
    }
    gl.clearColor(0, 0, 0, 0)
    return true
  }

  const live = initGl()
  root.setAttribute('data-skin-scene', live ? 'live' : 'fallback')

  const probe = document.createElement('canvas').getContext('2d')
  let colA: [number, number, number] = [0.49, 0.36, 1]
  let colB: [number, number, number] = [0.13, 0.88, 0.83]
  let dark = 1

  const drift: Drift[] = Array.from({ length: BALLS }, (_, i) => {
    const t = i / BALLS
    return {
      cx: 0.15 + 0.7 * ((i * 0.618) % 1),
      cy: 0.2 + 0.6 * ((i * 0.382 + 0.1) % 1),
      ax: 0.08 + 0.1 * ((i * 0.73) % 1),
      ay: 0.06 + 0.09 * ((i * 0.41) % 1),
      fx: 0.035 + 0.025 * t,
      fy: 0.025 + 0.03 * (1 - t),
      phase: i * 2.1,
      r: 0.075 + 0.055 * ((i * 0.57) % 1),
    }
  })
  const ballData = new Float32Array(BALLS * 3)
  let clock = 0
  let raf = 0
  let lastFrame = 0
  let lastDraw = 0
  let dirty = true
  let hasFocus = document.hasFocus()

  const reduced = () => !!motionQuery?.matches || root.getAttribute('data-reduce-motion') === 'true'
  const fieldHidden = () => root.getAttribute('data-high-contrast') === 'true' || (!on('liquid') && !on('orbits'))
  const drifting = () => on('drift') && !reduced()
  const dockActive = () => root.getAttribute('data-skin-dock') === 'on' && !!dockQuery?.matches

  function syncLens() {
    if (chromium && on('lens') && root.getAttribute('data-high-contrast') !== 'true') root.setAttribute('data-flux-lens', 'on')
    else root.removeAttribute('data-flux-lens')
  }

  function readTheme() {
    const cs = getComputedStyle(root)
    if (probe) {
      colA = cssColorToRgb(probe, cs.getPropertyValue('--harmony-primary').trim(), colA)
      colB = cssColorToRgb(probe, cs.getPropertyValue('--harmony-secondary').trim(), colB)
    }
    dark = root.getAttribute('data-theme-type') === 'light' ? 0 : 1
    syncLens()
    invalidate()
  }
  const themeObserver = new MutationObserver(readTheme)
  themeObserver.observe(root, { attributes: true, attributeFilter: ['style', 'data-theme-type', 'data-high-contrast', 'data-reduce-motion'] })

  function resize() {
    canvas.width = Math.max(1, Math.round(window.innerWidth * RENDER_SCALE))
    canvas.height = Math.max(1, Math.round(window.innerHeight * RENDER_SCALE))
    gl?.viewport(0, 0, canvas.width, canvas.height)
    invalidate()
  }

  function invalidate() {
    dirty = true
    wake()
  }

  function wake() {
    if (raf || !live || document.hidden) return
    if (!dirty && !(hasFocus && drifting())) return
    raf = requestAnimationFrame(frame)
  }

  function draw() {
    if (!gl || !program) return
    const aspect = window.innerWidth / window.innerHeight
    drift.forEach((b, i) => {
      ballData[i * 3] = (b.cx + b.ax * Math.sin(clock * b.fx * 6.283 + b.phase)) * aspect
      ballData[i * 3 + 1] = 1 - (b.cy + b.ay * Math.cos(clock * b.fy * 6.283 + b.phase * 1.3))
      ballData[i * 3 + 2] = b.r
    })
    gl.uniform2f(u.uRes, canvas.width, canvas.height)
    gl.uniform1f(u.uTime, clock)
    gl.uniform3fv(u.uBalls, ballData)
    gl.uniform3f(u.uColA, colA[0], colA[1], colA[2])
    gl.uniform3f(u.uColB, colB[0], colB[1], colB[2])
    gl.uniform1f(u.uRings, on('orbits') ? 1 : 0)
    gl.uniform1f(u.uLiquid, on('liquid') ? 1 : 0)
    gl.uniform1f(u.uDark, dark)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function frame(now: number) {
    raf = 0
    if (fieldHidden()) {
      canvas.style.display = 'none'
      dirty = false
      return
    }
    canvas.style.display = ''
    const animate = hasFocus && drifting()
    if (animate) {
      clock += Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 0)
      lastFrame = now
    } else {
      lastFrame = 0
    }
    if (dirty || (animate && now - lastDraw >= 1000 / DRIFT_FPS)) {
      draw()
      lastDraw = now
      dirty = false
    }
    if (animate) raf = requestAnimationFrame(frame)
  }

  // Dock helpers.
  const onPointerOver = (e: PointerEvent) => {
    if (!dockActive()) return
    const icon = (e.target as Element | null)?.closest?.('[data-region="rail"] :is(.rail-entry, .header-item-wrapper, .portal)')
    if (!icon) return
    const r = icon.getBoundingClientRect()
    body.style.setProperty('--flux-tip-x', `${r.left + r.width / 2}px`)
    body.style.setProperty('--flux-tip-y', `${r.bottom + 10}px`)
  }
  const onWheel = (e: WheelEvent) => {
    if (!dockActive() || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
    const strip = (e.target as Element | null)?.closest?.('[data-region="rail"] .servers-scroll-area, [data-region="nav"] .chat-content')
    if (!(strip instanceof HTMLElement) || strip.scrollWidth <= strip.clientWidth) return
    strip.scrollLeft += e.deltaY
    e.preventDefault()
  }

  const onVisibility = () => {
    lastFrame = 0
    if (!document.hidden) invalidate()
  }
  const onFocus = () => {
    hasFocus = true
    lastFrame = 0
    wake()
  }
  const onBlur = () => {
    hasFocus = false
  }
  const onLost = (e: Event) => {
    e.preventDefault()
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    root.setAttribute('data-skin-scene', 'fallback')
  }

  document.addEventListener('pointerover', onPointerOver, { passive: true })
  document.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('resize', resize, { passive: true })
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  canvas.addEventListener('webglcontextlost', onLost)
  motionQuery?.addEventListener?.('change', invalidate)

  resize()
  readTheme()

  return {
    update(next) {
      options = { ...next }
      syncLens()
      invalidate()
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      themeObserver.disconnect()
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('resize', resize)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', onLost)
      motionQuery?.removeEventListener?.('change', invalidate)
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
      lens.remove()
      body.style.removeProperty('--flux-tip-x')
      body.style.removeProperty('--flux-tip-y')
      root.removeAttribute('data-skin-scene')
      root.removeAttribute('data-flux-lens')
    },
  }
}
