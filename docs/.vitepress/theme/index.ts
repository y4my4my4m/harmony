import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { onContentUpdated, useData, useRoute } from 'vitepress'
import { h, watch, nextTick, onMounted } from 'vue'
import NotFound from './NotFound.vue'
import DocBar from './DocBar.vue'
import Wallpaper from './Wallpaper.vue'
import { modeForPath, wallpaper } from './wallpaper'
import { squish } from './squish'
import './fonts.css'
import './custom.css'

const APP_URL = 'https://har.mony.lol'

// Frontmatter of a legacy URL stub:
//   redirect: /self-host/
//   redirectAnchors: { voice-and-video: /self-host/voice }
// The visitor's #hash picks a target from redirectAnchors; an unknown hash
// is carried over to `redirect`. Pages render a plain link for no-JS clients.
function followRedirect(fm: Record<string, any>) {
  const to = fm.redirect
  if (typeof to !== 'string') return
  const hash = decodeURIComponent(window.location.hash.slice(1))
  const anchors: Record<string, string> = fm.redirectAnchors ?? {}
  const target = hash && anchors[hash] ? anchors[hash] : hash ? `${to}#${hash}` : to
  window.location.replace(target)
}

// Mermaid scales a diagram to its column; wide ones keep 70% of their natural
// width and scroll inside their frame so labels stay legible.
function fitMermaid() {
  document.querySelectorAll<SVGSVGElement>('.vp-doc .mermaid > svg').forEach((svg) => {
    const w = svg.viewBox.baseVal?.width
    if (w) svg.style.minWidth = `${Math.round(w * 0.7)}px`
  })
}

// VPNavScreen links carry no active state; the screen mounts on open.
function markScreenLinks(path: string) {
  document.querySelectorAll<HTMLAnchorElement>('.VPNavScreenMenuLink').forEach((a) => {
    const href = new URL(a.href, window.location.href).pathname
    const on = href.endsWith('/') ? path.startsWith(href) : path === href
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
}

// Light glyphs on a dark desk read louder than ink on paper; dark mode prints fainter.
const intensityFor = (home: boolean, dark: boolean) => (home ? 0.85 : 0.4) * (dark ? 0.45 : 1)

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'layout-top': () => h(Wallpaper),
      'doc-before': () => h(DocBar),
      'not-found': () => h(NotFound),
      'nav-bar-content-after': () => h('a', { class: 'hm-nav-cta', href: APP_URL }, 'Open Harmony'),
      'nav-screen-content-after': () =>
        h('div', { class: 'hm-screen-actions' }, [h('a', { class: 'hm-nav-cta', href: APP_URL }, 'Open Harmony')]),
    }),
  setup() {
    if (typeof window === 'undefined') return
    const { frontmatter, isDark } = useData()
    const route = useRoute()
    watch(
      () => route.path,
      (path) => {
        wallpaper.mode = modeForPath(path)
        const home = frontmatter.value.layout === 'home'
        wallpaper.intensity = intensityFor(home, isDark.value)
        nextTick(() => {
          followRedirect(frontmatter.value)
          // Home hero text gets a quiet field.
          document.querySelectorAll('.VPHero .main').forEach((el) => el.setAttribute('data-quiet', ''))
        })
      },
      { immediate: true },
    )
    watch(
      isDark,
      (d) => {
        wallpaper.dark = d
        wallpaper.intensity = intensityFor(frontmatter.value.layout === 'home', d)
      },
      { immediate: true },
    )
    onContentUpdated(squish)
    onMounted(() => {
      squish()
      const content = document.getElementById('VPContent')
      if (content) new MutationObserver(fitMermaid).observe(content, { childList: true, subtree: true })
      fitMermaid()
      const nav = document.querySelector('.VPNav')
      if (nav) new MutationObserver(() => markScreenLinks(route.path)).observe(nav, { childList: true })
    })
  },
} satisfies Theme
