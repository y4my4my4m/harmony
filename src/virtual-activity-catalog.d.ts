declare module 'virtual:activity-catalog' {
  /** Built-in activities of this build (vite-plugin-activities.ts). */
  const catalog: {
    v: 1
    apps: Array<{
      id: string
      name: string
      version: string
      description: string
      i18n?: Record<string, { name?: string; description?: string }>
      minPlayers: number
      maxPlayers: number
      contexts: Array<'direct' | 'group' | 'channel' | 'voice'>
      icon: string
      accent: string
      entry: string
    }>
  }
  export default catalog
}
