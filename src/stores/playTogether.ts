import { defineStore } from 'pinia'
import { computed, ref, shallowReactive, shallowRef, watch } from 'vue'
import { useToast } from 'vue-toastification'
import { i18n } from '@/i18n'
import { saveFile } from '@/services/downloads'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { fetchAppRows, fetchCatalog, localizedApp, mergeApps, type ActivityApp } from '@/services/playTogether/catalog'
import {
  ActivityError,
  getSessions,
  sessionTargetKey,
  startSession,
  targetKey,
  type ActivitySession,
  type ActivityTarget,
} from '@/services/playTogether/sessions'
import { ActivityRuntime, type RuntimeView } from '@/services/playTogether/activityRuntime'
import type { SessionContext, ThemeInfo } from '../../activities/sdk/protocol'

/**
 * Play together: the activity apps this instance offers, the sessions running where this client
 * looks, and the one session this client has joined.
 *
 * The joined session's frame lives in PlayTogetherHost (App.vue) and lays itself over the element
 * a visible panel registered (registerSlot): the DM or channel panel, or the call stage. With no
 * slot it keeps running hidden behind the mini card, so leaving the conversation does not leave the
 * game. Panel height (docked) is kept per device.
 */

const HEIGHT_KEY = 'harmony:play-together-height'
const NOTIFY_THROTTLE_MS = 8_000
export const PANEL_MIN_HEIGHT = 300
export const PANEL_DEFAULT_HEIGHT = 480

export interface JoinedSession {
  session: ActivitySession
  app: ActivityApp
  target: ActivityTarget
  runtime: ActivityRuntime
}

function storedHeight(): number {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(value) && value >= PANEL_MIN_HEIGHT ? value : PANEL_DEFAULT_HEIGHT
  } catch {
    return PANEL_DEFAULT_HEIGHT
  }
}

export function sessionTarget(session: ActivitySession): ActivityTarget {
  return session.conversation_id
    ? { kind: 'conversation', id: session.conversation_id }
    : { kind: 'channel', id: session.channel_id!, serverId: session.server_id!, voice: session.context === 'voice' }
}

export function targetContext(target: ActivityTarget, conversationType?: string | null): SessionContext {
  if (target.kind === 'conversation') return conversationType === 'group' ? 'group' : 'direct'
  return target.voice ? 'voice' : 'channel'
}

function errorKey(code: string): string {
  const known = ['ACTIVITY_APP_UNAVAILABLE', 'ACTIVITY_CONTEXT_UNSUPPORTED', 'ACTIVITY_RATE_LIMITED', 'NOT_FOUND', 'DM_BLOCKED',
    'SERVER_NOT_LOCAL', 'CHANNEL_TYPE', 'NOT_IN_CALL', 'CANNOT_SEND', 'NOT_LOCAL_ACCOUNT', 'ENDED', 'FULL', 'UNSUPPORTED_VERSION']
  return `playTogether.errors.${known.includes(code) ? code : 'UNKNOWN'}`
}

function currentTheme(): ThemeInfo {
  const style = getComputedStyle(document.documentElement)
  const accent = style.getPropertyValue('--harmony-primary').trim() || '#0EA5E9'
  const background = getComputedStyle(document.body).backgroundColor
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(background)
  const luminance = rgb ? (0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255 : 0
  return {
    scheme: luminance > 0.5 ? 'light' : 'dark',
    accent,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  }
}

export const usePlayTogetherStore = defineStore('playTogether', () => {
  const toast = useToast()
  const t = (key: string, values?: Record<string, unknown>) => i18n.global.t(key, values ?? {}) as string
  const locale = () => String(i18n.global.locale.value)

  /* Apps ------------------------------------------------------------------------------------- */

  const apps = ref<ActivityApp[]>([])
  const appsLoaded = ref(false)
  let appsPending: Promise<void> | null = null

  function loadApps(force = false): Promise<void> {
    if (appsPending && !force) return appsPending
    appsPending = (async () => {
      try {
        const [catalog, rows] = await Promise.all([fetchCatalog(), fetchAppRows()])
        apps.value = mergeApps(catalog, rows)
      } catch {
        apps.value = []
      } finally {
        appsLoaded.value = true
      }
    })()
    return appsPending
  }

  const enabledApps = computed(() => apps.value.filter((app) => app.enabled))

  function appsFor(context: SessionContext): ActivityApp[] {
    return enabledApps.value.filter((app) => app.contexts.includes(context))
  }

  function appById(id: string): ActivityApp | undefined {
    return apps.value.find((app) => app.id === id)
  }

  function appLabel(app: ActivityApp): { name: string; description: string } {
    return localizedApp(app, locale())
  }

  /* Sessions where this client looks --------------------------------------------------------- */

  const sessions = ref<Record<string, ActivitySession[]>>({})

  async function refresh(target: ActivityTarget): Promise<ActivitySession[]> {
    const list = await getSessions(target).catch(() => null)
    if (list) sessions.value = { ...sessions.value, [targetKey(target)]: list }
    return list ?? sessions.value[targetKey(target)] ?? []
  }

  function sessionIn(target: ActivityTarget): ActivitySession | null {
    return sessions.value[targetKey(target)]?.find((s) => s.status === 'active') ?? null
  }

  /* The joined session ------------------------------------------------------------------------ */

  const joined = shallowRef<JoinedSession | null>(null)
  // Shallow: the runtime replaces each field whole, and unwrapping the recursive Json of member
  // states exceeds the type checker's instantiation depth.
  const view = shallowReactive<RuntimeView>({ status: 'connecting', members: [], hostId: null, you: null, canEnd: false, final: null, frameReady: false, escaped: false })
  const mode = ref<'docked' | 'expanded'>('docked')
  const panelHeight = ref(storedHeight())
  const slots = shallowRef<HTMLElement[]>([])
  const slot = computed(() => slots.value[0] ?? null)
  const launcher = ref<{ target: ActivityTarget; conversationType?: string | null } | null>(null)
  const pageVisible = ref(typeof document === 'undefined' || document.visibilityState === 'visible')
  let lastNotify = 0

  const visible = computed(() => !!slot.value && pageVisible.value)

  function resetView(): void {
    Object.assign(view, { status: 'connecting', members: [], hostId: null, you: null, canEnd: false, final: null, frameReady: false, escaped: false })
  }

  function isJoined(sessionId: string): boolean {
    return joined.value?.session.id === sessionId
  }

  async function start(appId: string, target: ActivityTarget): Promise<boolean> {
    try {
      const { session, existing } = await startSession(appId, target)
      if (existing && session.app_id !== appId) {
        toast.info(t('playTogether.alreadyRunning', { name: session.app_name }))
      }
      sessions.value = { ...sessions.value, [targetKey(target)]: [session] }
      return join(session)
    } catch (error) {
      toast.error(t(errorKey(error instanceof ActivityError ? error.code : 'UNKNOWN')))
      return false
    }
  }

  async function join(session: ActivitySession): Promise<boolean> {
    if (isJoined(session.id)) return true
    await loadApps()
    const app = appById(session.app_id)
    if (!app || !app.enabled) {
      toast.error(t(errorKey('ACTIVITY_APP_UNAVAILABLE')))
      return false
    }
    leave()
    resetView()
    mode.value = 'docked'
    const runtime = new ActivityRuntime(
      session,
      (member) => (member.avatarUrl ? getAvatarUrl(member.avatarUrl, 128) : null),
      view,
      {
        locale,
        theme: currentTheme,
        visible: () => visible.value,
        notify: (text) => {
          if (visible.value) return
          const now = Date.now()
          if (now - lastNotify < NOTIFY_THROTTLE_MS) return
          lastNotify = now
          toast.info(`${appLabel(app).name}: ${text}`)
        },
        leave: () => leave(),
        save: async (blob, name) => {
          const url = URL.createObjectURL(blob)
          try {
            await saveFile(url, name)
            return true
          } catch {
            return false
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
          }
        },
      },
    )
    joined.value = { session, app, target: sessionTarget(session), runtime }
    runtime.start()
    // A call's game shows on the call view's stage.
    if (session.context === 'voice') useUnifiedVoiceChannelStore().isOverlayVisible = true
    return true
  }

  function leave(): void {
    const current = joined.value
    if (!current) return
    current.runtime.destroy()
    joined.value = null
    resetView()
    void refresh(current.target)
  }

  function endForEveryone(): void {
    joined.value?.runtime.end()
  }

  function openLauncher(target: ActivityTarget, conversationType?: string | null): void {
    void loadApps()
    void refresh(target)
    launcher.value = { target, conversationType }
  }

  function closeLauncher(): void {
    launcher.value = null
  }

  /** Shows the joined session's conversation or channel. */
  async function returnTo(): Promise<void> {
    const current = joined.value
    if (!current) return
    const target = current.target
    // Loaded here: the router's views import this store.
    const { default: router } = await import('@/router')
    if (target.kind === 'conversation') await router.push(`/dm/${target.id}`)
    else if (target.voice) useUnifiedVoiceChannelStore().isOverlayVisible = true
    else await router.push(`/chat/${target.serverId}/${target.id}`)
  }

  function registerSlot(el: HTMLElement): void {
    slots.value = [el, ...slots.value.filter((s) => s !== el)]
  }

  function unregisterSlot(el: HTMLElement): void {
    slots.value = slots.value.filter((s) => s !== el)
  }

  function setPanelHeight(height: number): void {
    panelHeight.value = Math.max(PANEL_MIN_HEIGHT, Math.round(height))
    try {
      localStorage.setItem(HEIGHT_KEY, String(panelHeight.value))
    } catch {
      /* per-device convenience */
    }
  }

  /** Refusal text for a relay or database code. */
  function errorText(code: string): string {
    return t(errorKey(code))
  }

  watch(visible, (value) => joined.value?.runtime.setVisible(value))

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      pageVisible.value = document.visibilityState === 'visible'
    })
  }

  watch(() => view.final, (final) => {
    if (!final || !joined.value) return
    if (final.kind === 'refused') toast.error(errorText(final.refusal))
    else if (final.kind === 'replaced') toast.info(t('playTogether.openedElsewhere'))
    else if (final.kind === 'unauthorized' || final.kind === 'error') toast.error(t('playTogether.errors.UNKNOWN'))
    if (final.kind !== 'ended') {
      const target = joined.value.target
      joined.value.runtime.destroy()
      joined.value = null
      resetView()
      void refresh(target)
    }
  })

  return {
    apps,
    appsLoaded,
    enabledApps,
    loadApps,
    appsFor,
    appById,
    appLabel,
    sessions,
    refresh,
    sessionIn,
    joined,
    view,
    mode,
    panelHeight,
    slot,
    visible,
    launcher,
    isJoined,
    start,
    join,
    leave,
    endForEveryone,
    openLauncher,
    closeLauncher,
    returnTo,
    registerSlot,
    unregisterSlot,
    setPanelHeight,
    errorText,
    pushTheme: () => joined.value?.runtime.pushTheme(currentTheme()),
    sessionTargetKey,
  }
})
