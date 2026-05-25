import { mount, type MountingOptions } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import type { Component } from 'vue'

const defaultRoutes = [
  { path: '/', component: { template: '<div>Home</div>' } },
  { path: '/login', component: { template: '<div>Login</div>' } },
  { path: '/chat', component: { template: '<div>Chat</div>' } },
  { path: '/chat/:serverId/:channelId', component: { template: '<div>Channel</div>' } },
  { path: '/dm', component: { template: '<div>DM</div>' } },
  { path: '/dm/:conversationId', component: { template: '<div>Conversation</div>' } },
  { path: '/social/home', component: { template: '<div>Social</div>' } },
  { path: '/settings/:section?', name: 'UserSettings', component: { template: '<div>Settings</div>' } },
]

export interface MountComponentOptions extends MountingOptions<any> {
  initialRoute?: string
  piniaState?: Record<string, any>
}

/**
 * Mount a Vue component with Pinia, Router, and common stubs pre-configured.
 */
export async function mountComponent(component: Component, options: MountComponentOptions = {}) {
  const { initialRoute = '/', piniaState = {}, ...mountOptions } = options

  const pinia = createPinia()
  pinia.state.value = piniaState

  const router = createRouter({
    history: createMemoryHistory(),
    routes: defaultRoutes,
  })

  router.push(initialRoute)
  await router.isReady()

  return mount(component, {
    ...mountOptions,
    global: {
      plugins: [pinia, router],
      stubs: {
        teleport: true,
        transition: false,
        ...(mountOptions.global?.stubs as Record<string, any> || {}),
      },
      mocks: {
        $t: (key: string) => key,
        ...(mountOptions.global?.mocks || {}),
      },
      ...mountOptions.global,
    },
  })
}
