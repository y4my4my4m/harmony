<template>
  <div class="auth-wrapper">
    <div class="auth-container">
      <!-- Desktop: framed pane beside the card. Narrow: banner above it. -->
      <section class="auth-art" :class="{ 'is-loaded': artLoaded }" data-testid="auth-art">
        <img
          v-if="artUrl"
          :src="artUrl"
          alt=""
          class="auth-art-img"
          data-testid="auth-art-img"
          fetchpriority="high"
          decoding="async"
          @load="artLoaded = true"
          @error="artUrl = ''"
        />
        <div class="auth-art-caption">
          <h1 class="brand-title">{{ instanceName }}</h1>
          <p v-if="instanceDescription" class="brand-tagline">{{ instanceDescription }}</p>
        </div>
      </section>

      <div class="auth-panel">
        <div class="auth-card" :class="{ 'loading-state': busy }">
          <!-- Stands behind the card's top edge; the edge clips it. -->
          <div class="auth-mascot" :data-pose="mascotPose" aria-hidden="true" data-testid="auth-mascot">
            <div class="auth-mascot-body">
              <img
                v-for="pose in MASCOT_POSES"
                :key="pose"
                :src="`/mascot/${pose}.webp`"
                alt=""
                :class="{ 'is-shown': pose === mascotPose }"
              />
            </div>
          </div>

          <p class="auth-instance" data-testid="auth-instance">
            <img v-if="instanceIcon" :src="instanceIcon" alt="" class="auth-instance-icon" @error="instanceIcon = ''" />
            <svg v-else class="auth-instance-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
            </svg>
            <span class="sr-only">{{ $t('auth.instanceLabel') }}:</span>
            <span class="auth-instance-host">{{ instanceHost }}</span>
          </p>

          <slot />
        </div>
      </div>
    </div>

    <a href="https://github.com/y4my4my4m/harmony" target="_blank" rel="noopener" class="powered-by">
      <i18n-t keypath="auth.poweredBy" scope="global">
        <template #name><strong>Harmony</strong></template>
      </i18n-t>
    </a>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { loginBackground } from '@/utils/backgroundUtils'
import { adminService } from '@/services/AdminService'
import { getStoredInstance } from '@/services/instanceConfig'

// public/mascot/<pose>.webp. All four load with the page so a pose change never waits on the network.
const MASCOT_POSES = ['idle', 'hide', 'peek', 'oops'] as const
export type MascotPose = typeof MASCOT_POSES[number]

withDefaults(defineProps<{
  /** idle waves, hide covers its eyes, peek looks between its paws, oops follows a failed attempt. */
  mascotPose?: MascotPose
  busy?: boolean
}>(), {
  mascotPose: 'idle',
  busy: false,
})

const artUrl = ref(loginBackground())
const artLoaded = ref(false)

const instanceName = ref('Harmony')
const instanceDescription = ref('')
const instanceIcon = ref('')
// Native clients sign in to the instance picked at first launch; web signs in
// to the origin it is served from.
const instanceHost = computed(() => {
  const stored = getStoredInstance()
  if (stored) {
    try { return new URL(stored.origin).host } catch { /* fall through */ }
  }
  return window.location.host
})

onMounted(async () => {
  try {
    const config = await adminService.getInstanceConfig()
    if (config?.instance) {
      instanceName.value = config.instance.name || 'Harmony'
      instanceDescription.value = config.instance.description || ''
      instanceIcon.value = config.instance.iconUrl || ''
    }
  } catch (error) {
    debug.warn('Failed to load instance branding, using defaults:', error)
  }
})
</script>

<style scoped>
/* ========================================
   CSS Variables & Base Styles
   ======================================== */
.auth-wrapper {
  --primary: var(--harmony-primary);
  --primary-hover: var(--harmony-primary-hover);
  --page: #0b0b0f;
  --surface: #15151b;
  --surface-light: rgba(255, 255, 255, 0.03);
  --surface-hover: rgba(255, 255, 255, 0.06);
  --border: rgba(255, 255, 255, 0.08);
  --border-focus: color-mix(in srgb, var(--harmony-primary) 50%, transparent);
  --text: #ffffff;
  --text-muted: rgba(255, 255, 255, 0.64);
  --text-dim: rgba(255, 255, 255, 0.45);
  --autofill-bg: #15151b;
  --art-gap: 16px;
  --mascot-size: 112px;

  min-height: calc(100 * var(--app-vh));
  width: 100%;
  font-family: var(--font-family);
  background: var(--page);
  position: relative;
  /* clip, not hidden: hidden makes a scroll container and the sticky art pane stops following the page. */
  overflow-x: clip;
}

/* Light themes, including the signed-out system-light preset. On --surface:
   --text 16.5:1, --text-muted 6.1:1. */
:root[data-theme-type="light"] .auth-wrapper {
  --page: #eceef2;
  --surface: #ffffff;
  --surface-light: rgba(0, 0, 0, 0.03);
  --surface-hover: rgba(0, 0, 0, 0.06);
  --border: rgba(0, 0, 0, 0.12);
  --text: #1e1f22;
  --text-muted: rgba(30, 31, 34, 0.7);
  --text-dim: rgba(30, 31, 34, 0.55);
  --autofill-bg: #ffffff;
}

/* ========================================
   Layout
   ======================================== */
.auth-container {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(440px, 560px);
  min-height: calc(100 * var(--app-vh));
}

/* ========================================
   Art pane
   ======================================== */
.auth-art {
  position: sticky;
  top: var(--art-gap);
  align-self: start;
  height: calc(100 * var(--app-vh) - 2 * var(--art-gap));
  margin: var(--art-gap) 0 var(--art-gap) var(--art-gap);
  border-radius: 28px;
  overflow: hidden;
  isolation: isolate;
  /* Shows while the image loads and in place of a missing one. */
  background:
    radial-gradient(120% 90% at 15% 0%, color-mix(in srgb, var(--harmony-primary) 60%, transparent), transparent 60%),
    radial-gradient(90% 80% at 100% 100%, rgba(124, 92, 255, 0.5), transparent 65%),
    #0c1624;
}

.auth-art-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
}

.auth-art.is-loaded .auth-art-img {
  opacity: 1;
}

/* Caption legibility over any image. */
.auth-art::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.74) 0%, rgba(0, 0, 0, 0.32) 30%, transparent 58%);
  pointer-events: none;
}

.auth-art-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  max-width: 680px;
  padding: 40px 44px;
  color: #fff;
}

.brand-title {
  margin: 0;
  font-size: clamp(2.25rem, 3.2 * var(--app-vw), 3.5rem);
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: -0.03em;
  color: #fff;
  overflow-wrap: anywhere;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.35);
}

.brand-tagline {
  margin: 10px 0 0;
  max-width: 44ch;
  font-size: 1.05rem;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.88);
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.4);
}

/* ========================================
   Auth Panel & Card
   ======================================== */
.auth-panel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--mascot-size) + 32px) 40px 64px;
}

.auth-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 28px 36px 32px;
  box-shadow: var(--shadow-large);
}

.auth-card.loading-state {
  pointer-events: none;
  opacity: 0.7;
}

/* Bounding box is the strip above the card's top edge; overflow hides what
   drops below it. Pose images: 320 px square, feet on the bottom row. */
.auth-mascot {
  position: absolute;
  right: 28px;
  bottom: 100%;
  width: var(--mascot-size);
  height: var(--mascot-size);
  overflow: hidden;
  pointer-events: none;
}

.auth-mascot-body {
  position: relative;
  width: 100%;
  height: 100%;
}

/* Paws over the eyes stay above the edge; the body sinks behind it. */
.auth-mascot:is([data-pose="hide"], [data-pose="peek"]) .auth-mascot-body {
  transform: translateY(34%);
}

/* Swapped, not crossfaded: two half-transparent poses overlap as a ghost. */
.auth-mascot-body img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
}

.auth-mascot-body img.is-shown {
  opacity: 1;
}

@media (prefers-reduced-motion: no-preference) {
  .auth-mascot-body {
    transition: transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .auth-art-img {
    transition: opacity 0.5s ease;
  }
}

.auth-instance {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  margin: 0 0 20px;
  padding: 5px 12px 5px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-light);
  color: var(--text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.3;
}

.auth-instance-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 5px;
  object-fit: cover;
}

svg.auth-instance-icon {
  width: 16px;
  height: 16px;
  color: var(--primary);
}

.auth-instance-host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ========================================
   Powered By
   ======================================== */
.powered-by {
  position: fixed;
  bottom: 16px;
  right: 20px;
  z-index: 20;
  font-size: 0.75rem;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s ease;
}

.powered-by:hover {
  color: var(--text);
}

.powered-by strong {
  font-weight: 600;
  color: var(--text-link);
}

/* ========================================
   Responsive Design - Mobile
   ======================================== */
/* Narrow: the art becomes a banner and the card a sheet pulled up over its
   bottom edge. Content keeps a 480px column on tablets. */
@media (max-width: 959px) {
  .auth-wrapper {
    --art-gap: 12px;
    --mascot-size: 88px;
    --sheet-overlap: 28px;
    --sheet-inline: max(24px, calc((100% - 480px) / 2));
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }

  .auth-container {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .auth-art {
    position: relative;
    top: auto;
    align-self: stretch;
    flex-shrink: 0;
    height: clamp(200px, 36 * var(--app-vh), 440px);
    margin: var(--art-gap) var(--art-gap) 0;
    border-radius: 24px;
  }

  .auth-art-caption {
    padding: 20px calc(var(--mascot-size) + 36px) calc(var(--sheet-overlap) + 18px) 22px;
  }

  .brand-title {
    font-size: 1.75rem;
  }

  .brand-tagline {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    margin-top: 6px;
    font-size: 0.9rem;
  }

  .auth-panel {
    flex: 1;
    position: relative;
    z-index: 1;
    align-items: stretch;
    justify-content: flex-start;
    margin-top: calc(-1 * var(--sheet-overlap));
    padding: 0;
  }

  .auth-card {
    display: flex;
    flex-direction: column;
    max-width: none;
    border-width: 1px 0 0;
    border-radius: 28px 28px 0 0;
    padding: 24px var(--sheet-inline) 28px;
    box-shadow: 0 -16px 24px -16px rgba(0, 0, 0, 0.28);
  }

  .auth-instance {
    align-self: flex-start;
  }

  .auth-mascot {
    right: var(--sheet-inline);
    width: var(--mascot-size);
  }

  .powered-by {
    position: static;
    display: block;
    padding: 0 16px 24px;
    text-align: center;
  }
}

/* Safe area insets for notched phones */
@supports (padding-top: env(safe-area-inset-top)) {
  @media (max-width: 959px) {
    .auth-art {
      margin-top: calc(var(--art-gap) + env(safe-area-inset-top));
    }

    .powered-by {
      padding-bottom: calc(24px + env(safe-area-inset-bottom));
    }
  }
}
</style>
