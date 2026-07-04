/**
 * Debug Utility - Environment-aware logging for Harmony
 * 
 * Only logs when:
 * 1. Running in development mode (import.meta.env.DEV)
 * 2. VITE_DEBUG_LOGGING is explicitly set to 'true'
 * 
 * Usage:
 * import { debug, debugGroup, debugTime } from '@/utils/debug'
 * debug.log('Message', data)
 * debug.warn('Warning message')
 * debug.error('Error message') // Always logs in dev, errors are important
 */

const isDebugEnabled = (): boolean => {
  // In production, never log debug messages
  // if (!import.meta.env.DEV) return false
  // In dev, check if debug logging is explicitly enabled
  return import.meta.env.VITE_DEBUG_LOGGING === 'true'
}

// Cache the result at module load time for performance
const DEBUG_ENABLED = isDebugEnabled()

// Errors always log, including production - silent failures are undiagnosable.
const ERROR_LOGGING_ENABLED = true

/**
 * Main debug object - provides console methods that only execute in debug mode
 */
export const debug = {
  /**
   * Log a debug message (only in debug mode)
   */
  log: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.log(...args)
    }
  },

  /**
   * Log a warning (only in debug mode)
   */
  warn: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.warn(...args)
    }
  },

  /**
   * Log an error (always in development, errors are important)
   */
  error: (...args: any[]): void => {
    if (ERROR_LOGGING_ENABLED) {
      console.error(...args)
    }
  },

  /**
   * Log info (only in debug mode)
   */
  info: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.info(...args)
    }
  },

  /**
   * Log debug (only in debug mode)
   */
  debug: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.debug(...args)
    }
  },

  /**
   * Log a table (only in debug mode)
   */
  table: (data: any, columns?: string[]): void => {
    if (DEBUG_ENABLED) {
      console.table(data, columns)
    }
  },

  /**
   * Assert a condition (only in debug mode)
   */
  assert: (condition: boolean, ...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.assert(condition, ...args)
    }
  },

  /**
   * Log with a specific category prefix
   */
  category: (category: string) => ({
    log: (...args: any[]) => debug.log(`[${category}]`, ...args),
    warn: (...args: any[]) => debug.warn(`[${category}]`, ...args),
    error: (...args: any[]) => debug.error(`[${category}]`, ...args),
    info: (...args: any[]) => debug.info(`[${category}]`, ...args),
  }),
}

/**
 * Create a console group (only in debug mode)
 */
export const debugGroup = (label: string, fn: () => void, collapsed = true): void => {
  if (DEBUG_ENABLED) {
    if (collapsed) {
      console.groupCollapsed(label)
    } else {
      console.group(label)
    }
    try {
      fn()
    } finally {
      console.groupEnd()
    }
  }
}

/**
 * Time a function execution (only in debug mode)
 */
export const debugTime = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
  if (DEBUG_ENABLED) {
    console.time(label)
    try {
      const result = await fn()
      console.timeEnd(label)
      return result
    } catch (error) {
      console.timeEnd(label)
      throw error
    }
  }
  return fn()
}

/**
 * Create category-specific loggers
 */
export const createLogger = (category: string) => debug.category(category)

// Pre-defined category loggers for common use cases
export const loggers = {
  auth: createLogger('Auth'),
  presence: createLogger('Presence'),
  notification: createLogger('Notification'),
  activityPub: createLogger('ActivityPub'),
  voice: createLogger('Voice'),
  dm: createLogger('DM'),
  chat: createLogger('Chat'),
  webrtc: createLogger('WebRTC'),
  encryption: createLogger('Encryption'),
  theme: createLogger('Theme'),
}

export default debug

