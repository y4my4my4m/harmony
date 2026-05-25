/**
 * Utility functions for settings navigation and URL handling
 */

import type { RouteLocationRaw } from 'vue-router'

export type SettingsSection = 
  | 'account' 
  | 'privacy' 
  | 'appearance' 
  | 'notifications' 
  | 'activitypub'
  | 'voice' 
  | 'keybinds' 
  | 'language' 
  | 'advanced'

/**
 * Generates a settings route for the given section
 */
export function getSettingsRoute(section: SettingsSection): RouteLocationRaw {
  return {
    name: 'UserSettings',
    params: { section }
  }
}

/**
 * Generates a settings URL path for the given section
 */
export function getSettingsPath(section: SettingsSection): string {
  return `/settings/${section}`
}

/**
 * Validates if a section name is valid
 */
export function isValidSettingsSection(section: string): section is SettingsSection {
  const validSections: SettingsSection[] = [
    'account',
    'privacy', 
    'appearance',
    'notifications',
    'voice',
    'keybinds',
    'language',
    'advanced'
  ]
  
  return validSections.includes(section as SettingsSection)
}

/**
 * Gets the default settings section
 */
export function getDefaultSettingsSection(): SettingsSection {
  return 'account'
}

/**
 * Creates a programmatic navigation helper for settings
 */
export function createSettingsNavigator(router: any) {
  return {
    /**
     * Navigate to a specific settings section
     */
    navigateToSection(section: SettingsSection) {
      return router.push(getSettingsRoute(section))
    },

    /**
     * Navigate to settings with URL replacement (for programmatic changes)
     */
    replaceSection(section: SettingsSection) {
      return router.replace(getSettingsRoute(section))
    },

    /**
     * Get the current settings section from route
     */
    getCurrentSection(route: any): SettingsSection {
      const section = Array.isArray(route.params.section) 
        ? route.params.section[0] 
        : route.params.section
      
      return isValidSettingsSection(section) ? section : getDefaultSettingsSection()
    }
  }
}