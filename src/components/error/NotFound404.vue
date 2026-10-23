<template>
  <div class="not-found" data-testid="not-found">
    <div class="not-found__inner">
      <div v-if="image" class="not-found__art" aria-hidden="true" data-testid="not-found-art">
        <img
          v-show="!imageError"
          ref="imageEl"
          :src="image"
          alt=""
          width="720"
          height="720"
          fetchpriority="high"
          decoding="async"
          class="not-found__img"
          :class="{ 'is-loaded': imageLoaded }"
          data-testid="not-found-img"
          @load="imageLoaded = true"
          @error="onImageError"
        >
      </div>

      <div class="not-found__copy">
        <p class="not-found__code">404</p>
        <h1 class="not-found__title">{{ heading }}</h1>
        <p class="not-found__text">{{ description }}</p>
        <p v-if="missingPath" class="not-found__path" data-testid="not-found-path">
          <span class="sr-only">{{ t('notFound.requestedAddress') }}</span>
          <code :title="missingPath">{{ missingPath }}</code>
        </p>

        <div class="not-found__actions">
          <RouterLink
            :to="primary.to"
            class="not-found__btn not-found__btn--primary"
            data-testid="not-found-primary"
          >
            <Icon :name="primary.icon" :size="18" />
            <span>{{ primary.label }}</span>
          </RouterLink>
          <button
            v-if="canGoBack"
            type="button"
            class="not-found__btn not-found__btn--secondary"
            data-testid="not-found-back"
            @click="router.back()"
          >
            <Icon name="arrow-left" :size="18" />
            <span>{{ t('notFound.goBack') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/common/Icon.vue'
import { randomNotFoundImage } from '@/utils/backgroundUtils'

interface Props {
  title?: string
  description?: string
  homeButtonText?: string
  suggestedRoute?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  description: '',
  homeButtonText: '',
  suggestedRoute: ''
})

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const image = randomNotFoundImage()
const imageEl = ref<HTMLImageElement | null>(null)
const imageLoaded = ref(false)
const imageError = ref(false)

const isAuthenticated = computed(() => authStore.isLoggedIn)

// The catch-all redirects to /404 or /404-public; redirectedFrom keeps the address
// that matched nothing. Path only: query and hash can carry tokens.
const requestedPath = computed(() => route.redirectedFrom?.path ?? route.path)

const missingPath = computed(() => {
  const path = route.redirectedFrom?.path
  if (!path) return ''
  try {
    return decodeURI(path)
  } catch {
    return path
  }
})

// vue-router's history state: `back` is the in-app entry before this one, null on a fresh load.
const canGoBack = Boolean(router.options?.history?.state?.back)

const heading = computed(() => props.title || t('notFound.pageNotFound'))

const description = computed(() => {
  if (props.description) return props.description
  const path = requestedPath.value
  if (path.startsWith('/social/')) return t('notFound.socialNotFound')
  if (path.startsWith('/chat/') || path.startsWith('/dm/')) return t('notFound.chatNotFound')
  if (path.startsWith('/settings/')) return t('notFound.settingsNotFound')
  return t('notFound.defaultNotFound')
})

const primary = computed(() => {
  if (props.suggestedRoute || props.homeButtonText) {
    return {
      to: props.suggestedRoute || (isAuthenticated.value ? '/chat' : '/login'),
      label: props.homeButtonText || t('notFound.goHome'),
      icon: 'home',
    }
  }
  if (!isAuthenticated.value) return { to: '/login', label: t('auth.signIn'), icon: 'log-in' }
  const path = requestedPath.value
  if (path.startsWith('/social/')) return { to: '/social/home', label: t('notFound.backToSocial'), icon: 'users' }
  if (path.startsWith('/chat/') || path.startsWith('/dm/')) {
    return { to: '/chat', label: t('notFound.backToChat'), icon: 'message-circle' }
  }
  return { to: '/chat', label: t('notFound.goHome'), icon: 'home' }
})

function onImageError() {
  debug.warn('Failed to load 404 image:', image)
  imageError.value = true
}

// A cached image can finish before the load listener is attached.
onMounted(() => {
  const el = imageEl.value
  if (el?.complete && el.naturalWidth > 0) imageLoaded.value = true
})
</script>

<style scoped>
/* Art side: at most 340px, 40% of the viewport height, the viewport width less the gutters. */
.not-found {
  --nf-art: min(340px, calc(40 * var(--app-dvh)), calc(100 * var(--app-vw) - 5rem));

  box-sizing: border-box;
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-5);
  color: var(--text-primary);
}

/* Auto margins centre without clipping the top when the content outgrows the box. */
.not-found__inner {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
  width: 100%;
  max-width: 60rem;
  text-align: center;
}

.not-found__art {
  position: relative;
  flex: none;
  width: var(--nf-art);
  aspect-ratio: 1;
}

.not-found__art::before {
  content: '';
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--harmony-primary) 22%, transparent),
    color-mix(in srgb, var(--harmony-primary) 9%, transparent) 70%,
    transparent
  );
}

.not-found__img {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.not-found__img.is-loaded {
  opacity: 1;
  animation: not-found-float 7s ease-in-out 0.2s infinite;
}

@keyframes not-found-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.not-found__copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  max-width: 28rem;
}

.not-found__code {
  margin: 0;
  padding: 0.2rem 0.7rem;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--harmony-primary) 16%, transparent);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}

.not-found__title {
  margin: 0;
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-bold);
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}

.not-found__title:focus {
  outline: none;
}

.not-found__text {
  margin: 0;
  max-width: 34ch;
  font-size: var(--font-size-base);
  line-height: 1.5;
  color: var(--text-secondary);
}

.not-found__path {
  display: flex;
  max-width: 100%;
  margin: 0;
}

.not-found__path code {
  overflow: hidden;
  max-width: 100%;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.not-found__actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
  width: 100%;
  max-width: 20rem;
  margin-top: var(--space-3);
}

.not-found__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.not-found__btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.not-found__btn--primary {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.not-found__btn--primary:hover {
  background: var(--harmony-primary-fill-hover);
}

.not-found__btn--secondary {
  background: transparent;
  border-color: var(--border-primary);
  color: var(--text-primary);
}

.not-found__btn--secondary:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

@media (min-width: 480px) {
  .not-found__actions {
    flex-direction: row;
    justify-content: center;
    width: auto;
    max-width: none;
  }
}

/* Side by side on wide screens and on short landscape phones. */
@media (min-width: 900px) and (min-height: 480px), (min-width: 560px) and (max-height: 560px) and (orientation: landscape) {
  .not-found {
    --nf-art: min(420px, calc(58 * var(--app-dvh)));
  }

  .not-found__inner {
    flex-direction: row;
    justify-content: center;
    gap: clamp(2rem, calc(5 * var(--app-vw)), 4.5rem);
    text-align: left;
  }

  .not-found__copy {
    flex: 0 1 28rem;
    align-items: flex-start;
  }

  .not-found__title {
    font-size: 2.5rem;
  }

  .not-found__actions {
    justify-content: flex-start;
  }
}

@media (prefers-contrast: more) {
  .not-found__btn {
    border: 2px solid currentColor;
  }
}

@media (prefers-reduced-motion: reduce) {
  .not-found__img,
  .not-found__img.is-loaded {
    animation: none;
    transition: none;
  }
}

:root[data-reduce-motion="true"] .not-found__img {
  animation: none;
  transition: none;
}
</style>
