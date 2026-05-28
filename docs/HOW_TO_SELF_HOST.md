---
title: Redirecting to Self-Hosting Guide
head:
  - - meta
    - http-equiv: refresh
      content: '0; url=/self-hosting'
  - - link
    - rel: canonical
      href: https://docs.mony.lol/self-hosting
---

# Page Moved

This page has moved to [**/self-hosting**](/self-hosting).

You should be redirected automatically. If not, click the link above.

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vitepress'

onMounted(() => {
  const router = useRouter()
  router.go('/self-hosting')
})
</script>
