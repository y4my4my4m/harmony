<script setup lang="ts">
import { withBase } from 'vitepress'

const sections = [
  { text: 'Use Harmony', link: '/use/', detail: 'Accounts, messages, voice, notifications' },
  { text: 'Run a server', link: '/run/', detail: 'Roles, moderation, the Discord bridge' },
  { text: 'Self-host', link: '/self-host/', detail: 'Install, configure and operate an instance' },
  { text: 'Build', link: '/build/', detail: 'Bots, webhooks, bridges' },
]
</script>

<template>
  <div class="hm-404" data-quiet>
    <div class="hm-404-win">
      <div class="hm-docbar hm-404-bar" aria-hidden="true">
        <i class="hm-docbar-box" />
        <i class="hm-docbar-stripes" />
        <span class="hm-docbar-title">404.md</span>
        <i class="hm-docbar-stripes" />
        <i class="hm-docbar-box hm-docbar-box--zoom" />
      </div>
      <div class="hm-404-body">
        <p class="hm-404-code">404</p>
        <h1 class="hm-404-title">This page does not exist</h1>
        <p class="hm-404-text">
          Search with <kbd>/</kbd> or <kbd>Ctrl</kbd> <kbd>K</kbd>, or start from the section
          that matches what you are doing.
        </p>
        <ul class="hm-404-links">
          <li v-for="s in sections" :key="s.link">
            <a :href="withBase(s.link)">
              <span class="hm-404-link-title">{{ s.text }}</span>
              <span class="hm-404-link-detail">{{ s.detail }}</span>
            </a>
          </li>
        </ul>
        <p class="hm-404-home"><a :href="withBase('/')">Docs home</a></p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hm-404 {
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 16px 112px;
}
.hm-404-win {
  border: 2px solid var(--hm-frame);
  border-radius: 10px;
  background: var(--hm-window);
  box-shadow: 6px 6px 0 var(--hm-shadow);
}
.hm-404-bar {
  margin: 0;
}
.hm-404-body {
  padding: 32px 40px 40px;
}
@media (max-width: 640px) {
  .hm-404 {
    padding-top: 32px;
  }
  .hm-404-win {
    box-shadow: 4px 4px 0 var(--hm-shadow);
  }
  .hm-404-body {
    padding: 24px 18px 28px;
  }
}
.hm-404-code {
  display: inline-block;
  margin: 0;
  padding: 0 0.3em;
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--hm-ink);
  background: var(--hm-marker);
}
.hm-404-title {
  margin: 16px 0 12px;
  font-family: var(--hm-font-display);
  font-size: 40px;
  line-height: 1.05;
  font-weight: 800;
  font-variation-settings: 'wdth' 82;
  letter-spacing: -0.03em;
  color: var(--vp-c-text-1);
}
.hm-404-text {
  margin: 0 0 32px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}
.hm-404-links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hm-404-links a {
  display: block;
  height: 100%;
  padding: 16px 18px;
  border: 2px solid var(--hm-frame);
  border-radius: 8px;
  background: var(--hm-window);
  text-decoration: none;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.hm-404-links a:hover {
  background: var(--hm-marker);
  transform: translate(-2px, -2px);
  box-shadow: 4px 4px 0 var(--hm-shadow);
}
.hm-404-links a:hover .hm-404-link-title,
.hm-404-links a:hover .hm-404-link-detail {
  color: var(--hm-ink);
}
@media (prefers-reduced-motion: reduce) {
  .hm-404-links a {
    transition: none;
  }
  .hm-404-links a:hover {
    transform: none;
  }
}
.hm-404-link-title {
  display: block;
  font-weight: 650;
  color: var(--vp-c-text-1);
}
.hm-404-link-detail {
  display: block;
  margin-top: 4px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.hm-404-home {
  margin-top: 32px;
}
.hm-404-home a {
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
kbd {
  padding: 1px 6px;
  border: 1px solid var(--vp-c-divider);
  border-bottom-width: 2px;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85em;
  background: var(--vp-c-bg-soft);
}
</style>
