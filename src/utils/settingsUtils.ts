import type { RouteLocationRaw } from 'vue-router'

export type SettingsSection = 
  | 'account' 
  | 'privacy'
  | 'bots'
  | 'appearance' 
  | 'notifications' 
  | 'announcements'
  | 'activitypub'
  | 'voice' 
  | 'keybinds'
  | 'audio'
  | 'language' 
  | 'advanced'

export function getSettingsRoute(section: SettingsSection): RouteLocationRaw {
  return {
    name: 'UserSettings',
    params: { section }
  }
}

export function getSettingsPath(section: SettingsSection): string {
  return `/settings/${section}`
}

export function isValidSettingsSection(section: string): section is SettingsSection {
  const validSections: SettingsSection[] = [
    'account',
    'privacy',
    'bots',
    'appearance',
    'notifications',
    'announcements',
    'voice',
    'keybinds',
    'audio',
    'language',
    'advanced'
  ]
  
  return validSections.includes(section as SettingsSection)
}

export function getDefaultSettingsSection(): SettingsSection {
  return 'account'
}

export function createSettingsNavigator(router: any) {
  return {
    navigateToSection(section: SettingsSection) {
      return router.push(getSettingsRoute(section))
    },

    replaceSection(section: SettingsSection) {
      return router.replace(getSettingsRoute(section))
    },

    getCurrentSection(route: any): SettingsSection {
      const section = Array.isArray(route.params.section) 
        ? route.params.section[0] 
        : route.params.section
      
      return isValidSettingsSection(section) ? section : getDefaultSettingsSection()
    }
  }
}