/**
 * Environment-aware logging. Only logs when in dev mode AND
 * VITE_DEBUG_LOGGING=true, except errors which always log.
 */

const isDebugEnabled = (): boolean => {
  return import.meta.env.VITE_DEBUG_LOGGING === 'true'
}

const DEBUG_ENABLED = isDebugEnabled()

// Errors always log, including production - silent failures are undiagnosable.
const ERROR_LOGGING_ENABLED = true

export const debug = {
  log: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.log(...args)
    }
  },

  warn: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.warn(...args)
    }
  },

  error: (...args: any[]): void => {
    if (ERROR_LOGGING_ENABLED) {
      console.error(...args)
    }
  },

  info: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.info(...args)
    }
  },

  debug: (...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.debug(...args)
    }
  },

  table: (data: any, columns?: string[]): void => {
    if (DEBUG_ENABLED) {
      console.table(data, columns)
    }
  },

  assert: (condition: boolean, ...args: any[]): void => {
    if (DEBUG_ENABLED) {
      console.assert(condition, ...args)
    }
  },

  category: (category: string) => ({
    log: (...args: any[]) => debug.log(`[${category}]`, ...args),
    warn: (...args: any[]) => debug.warn(`[${category}]`, ...args),
    error: (...args: any[]) => debug.error(`[${category}]`, ...args),
    info: (...args: any[]) => debug.info(`[${category}]`, ...args),
  }),
}

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

export const createLogger = (category: string) => debug.category(category)

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

