/**
 * Frontend Logging Service
 * 
 * Privacy-respecting logging with:
 * - Error logging (automatic capture)
 * - User action logging (opt-in, privacy-aware)
 * - Performance logging (page load, interaction delays)
 * - Local storage buffer with batch sending
 * - Integration with backend aggregation
 */

import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'


export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogCategory = 
  | 'error'
  | 'performance'
  | 'navigation'
  | 'interaction'
  | 'network'
  | 'auth'
  | 'federation'
  | 'voice'
  | 'custom'

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  category: LogCategory
  message: string
  data?: Record<string, any>
  context?: {
    url?: string
    route?: string
    userId?: string // Hashed if consent not given
    sessionId?: string
    userAgent?: string
    viewport?: { width: number; height: number }
  }
  performance?: {
    duration?: number
    memoryUsage?: number
    timestamp?: number
  }
  error?: {
    name?: string
    message?: string
    stack?: string
    componentStack?: string
  }
}

export interface LoggingConfig {
  enabled: boolean
  minLevel: LogLevel
  sendToServer: boolean
  bufferSize: number
  flushInterval: number // ms
  userConsent: boolean // Privacy consent for detailed logging
  includePerformance: boolean
  includeNavigation: boolean
  includeInteractions: boolean
  excludePatterns: RegExp[] // Patterns to exclude from logging
}


const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const DEFAULT_CONFIG: LoggingConfig = {
  enabled: true,
  minLevel: 'warn',
  sendToServer: false, // Disabled by default for privacy
  bufferSize: 100,
  flushInterval: 30000, // 30 seconds
  userConsent: false,
  includePerformance: true,
  includeNavigation: true,
  includeInteractions: false, // Opt-in for privacy
  excludePatterns: [
    /password/i,
    /token/i,
    /secret/i,
    /api_key/i,
    /authorization/i,
    /credential/i,
  ],
}

const STORAGE_KEY = 'harmony_log_buffer'
const CONSENT_KEY = 'harmony_logging_consent'
const SESSION_ID_KEY = 'harmony_session_id'


class LoggingService {
  private config: LoggingConfig
  private buffer: LogEntry[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private sessionId: string
  private errorCount = 0
  private readonly MAX_ERRORS_PER_SESSION = 100

  constructor() {
    this.config = this.loadConfig()
    this.sessionId = this.getOrCreateSessionId()
    this.loadBufferFromStorage()
    this.setupGlobalErrorHandlers()
    this.setupPerformanceObservers()
    this.startFlushTimer()
  }


  private loadConfig(): LoggingConfig {
    try {
      const stored = localStorage.getItem('harmony_logging_config')
      if (stored) {
        return { ...DEFAULT_CONFIG, ...JSON.parse(stored) }
      }
    } catch {
      // Ignore errors
    }
    return { ...DEFAULT_CONFIG }
  }

  updateConfig(updates: Partial<LoggingConfig>): void {
    this.config = { ...this.config, ...updates }
    try {
      localStorage.setItem('harmony_logging_config', JSON.stringify(this.config))
    } catch {
      // Ignore storage errors
    }
  }

  setUserConsent(consent: boolean): void {
    this.config.userConsent = consent
    try {
      localStorage.setItem(CONSENT_KEY, consent ? 'true' : 'false')
    } catch {
      // Ignore
    }
    this.updateConfig({ userConsent: consent })
  }

  hasUserConsent(): boolean {
    return this.config.userConsent
  }


  private getOrCreateSessionId(): string {
    try {
      let sessionId = sessionStorage.getItem(SESSION_ID_KEY)
      if (!sessionId) {
        sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        sessionStorage.setItem(SESSION_ID_KEY, sessionId)
      }
      return sessionId
    } catch {
      return `session_${Date.now()}`
    }
  }


  private shouldLog(level: LogLevel): boolean {
    if (!this.config.enabled) return false
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.minLevel]
  }

  private sanitizeData(data: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {}
    
    for (const [key, value] of Object.entries(data)) {
      if (this.config.excludePatterns.some(pattern => pattern.test(key))) {
        sanitized[key] = '[REDACTED]'
        continue
      }
      
      // Recursively sanitize nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeData(value)
      } else if (typeof value === 'string') {
        if (this.config.excludePatterns.some(pattern => pattern.test(value))) {
          sanitized[key] = '[REDACTED]'
        } else {
          sanitized[key] = value
        }
      } else {
        sanitized[key] = value
      }
    }
    
    return sanitized
  }

  private createEntry(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, any>,
    error?: Error
  ): LogEntry {
    const entry: LogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
    }

    if (data) {
      entry.data = this.sanitizeData(data)
    }

    entry.context = {
      url: window.location.pathname, // Only path, not full URL
      sessionId: this.sessionId,
    }

    if (this.config.userConsent) {
      entry.context.userAgent = navigator.userAgent
      entry.context.viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      }
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: this.config.userConsent ? error.stack : undefined,
      }
    }

    return entry
  }

  private addToBuffer(entry: LogEntry): void {
    this.buffer.push(entry)
    
    // Trim buffer if too large
    if (this.buffer.length > this.config.bufferSize) {
      this.buffer = this.buffer.slice(-this.config.bufferSize)
    }
    
    this.saveBufferToStorage()
  }


  debug(message: string, data?: Record<string, any>): void {
    if (!this.shouldLog('debug')) return
    debug.log(message, data)
    const entry = this.createEntry('debug', 'custom', message, data)
    this.addToBuffer(entry)
  }

  info(message: string, data?: Record<string, any>): void {
    if (!this.shouldLog('info')) return
    debug.log(message, data)
    const entry = this.createEntry('info', 'custom', message, data)
    this.addToBuffer(entry)
  }

  warn(message: string, data?: Record<string, any>): void {
    if (!this.shouldLog('warn')) return
    debug.warn(message, data)
    const entry = this.createEntry('warn', 'custom', message, data)
    this.addToBuffer(entry)
  }

  error(message: string, error?: Error, data?: Record<string, any>): void {
    if (!this.shouldLog('error')) return
    if (this.errorCount >= this.MAX_ERRORS_PER_SESSION) return
    
    this.errorCount++
    debug.error(message, error, data)
    const entry = this.createEntry('error', 'error', message, data, error)
    this.addToBuffer(entry)
  }


  logNavigation(from: string, to: string, duration?: number): void {
    if (!this.config.includeNavigation) return
    if (!this.shouldLog('info')) return

    const entry = this.createEntry('info', 'navigation', 'Page navigation', {
      from,
      to,
      duration,
    })
    this.addToBuffer(entry)
  }

  logInteraction(action: string, element?: string, data?: Record<string, any>): void {
    if (!this.config.includeInteractions || !this.config.userConsent) return
    if (!this.shouldLog('info')) return

    const entry = this.createEntry('info', 'interaction', action, {
      element,
      ...data,
    })
    this.addToBuffer(entry)
  }

  logPerformance(metric: string, value: number, unit: string = 'ms', data?: Record<string, any>): void {
    if (!this.config.includePerformance) return
    if (!this.shouldLog('info')) return

    const entry = this.createEntry('info', 'performance', metric, {
      value,
      unit,
      ...data,
    })
    entry.performance = {
      duration: value,
      timestamp: performance.now(),
    }
    this.addToBuffer(entry)
  }

  logNetworkError(url: string, status: number, message: string): void {
    if (!this.shouldLog('error')) return

    // Redact full URLs, only log path
    const path = new URL(url, window.location.origin).pathname
    
    const entry = this.createEntry('error', 'network', 'Network request failed', {
      path,
      status,
      message,
    })
    this.addToBuffer(entry)
  }

  logAuthEvent(event: string, success: boolean, data?: Record<string, any>): void {
    if (!this.shouldLog('info')) return

    const entry = this.createEntry(
      success ? 'info' : 'warn',
      'auth',
      `Auth event: ${event}`,
      { event, success, ...data }
    )
    this.addToBuffer(entry)
  }

  logFederationEvent(event: string, domain: string, success: boolean, latencyMs?: number): void {
    if (!this.shouldLog('info')) return

    const entry = this.createEntry(
      success ? 'info' : 'warn',
      'federation',
      `Federation: ${event}`,
      { event, domain, success, latencyMs }
    )
    this.addToBuffer(entry)
  }

  logVoiceEvent(event: string, data?: Record<string, any>): void {
    if (!this.shouldLog('info')) return

    const entry = this.createEntry('info', 'voice', `Voice: ${event}`, data)
    this.addToBuffer(entry)
  }


  private saveBufferToStorage(): void {
    try {
      // Only save recent entries to avoid storage quota issues
      const recentEntries = this.buffer.slice(-50)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recentEntries))
    } catch {
      // Storage quota exceeded or other error - clear old entries
      this.buffer = this.buffer.slice(-25)
    }
  }

  private loadBufferFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        this.buffer = JSON.parse(stored)
      }
    } catch {
      this.buffer = []
    }
  }

  clearBuffer(): void {
    this.buffer = []
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Ignore
    }
  }

  // Server Sync (Optional)

  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    
    this.flushTimer = setInterval(() => {
      this.flushToServer()
    }, this.config.flushInterval)
  }

  async flushToServer(): Promise<void> {
    if (!this.config.sendToServer || this.buffer.length === 0) return
    if (!this.config.userConsent) return // Require consent for server logging

    const entriesToSend = [...this.buffer]
    
    try {
      // Filter to only errors and warnings for server
      const filtered = entriesToSend.filter(e => 
        LOG_LEVELS[e.level] >= LOG_LEVELS['warn']
      )

      if (filtered.length === 0) return

      const { error } = await supabase.functions.invoke('log-aggregation', {
        body: { logs: filtered },
      })

      if (!error) {
        this.buffer = this.buffer.filter(e => !entriesToSend.includes(e))
        this.saveBufferToStorage()
        debug.log(`Flushed ${filtered.length} logs to server`)
      }
    } catch (error) {
      debug.error('Failed to flush logs to server:', error)
    }
  }


  private setupGlobalErrorHandlers(): void {
    // Unhandled errors
    window.addEventListener('error', (event) => {
      this.error('Unhandled error', event.error, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      })
    })

    // Unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason instanceof Error 
        ? event.reason 
        : new Error(String(event.reason))
      
      this.error('Unhandled promise rejection', error)
    })

    // Console errors (optional, can be noisy)
    if (this.config.minLevel === 'debug') {
      const originalError = console.error
      console.error = (...args) => {
        originalError.apply(console, args)
        const message = args.map(a => String(a)).join(' ')
        this.error('Console error', undefined, { message })
      }
    }
  }


  private setupPerformanceObservers(): void {
    if (!this.config.includePerformance) return
    if (typeof PerformanceObserver === 'undefined') return

    try {
      // Long Task Observer (tasks > 50ms)
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 100) { // Only log tasks > 100ms
            this.logPerformance('long_task', entry.duration, 'ms', {
              startTime: entry.startTime,
            })
          }
        }
      })
      
      longTaskObserver.observe({ entryTypes: ['longtask'] })

      // Layout Shift Observer (CLS)
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (entry.value > 0.1) { // Significant layout shift
            this.logPerformance('layout_shift', entry.value, 'score', {
              hadRecentInput: entry.hadRecentInput,
            })
          }
        }
      })
      
      clsObserver.observe({ entryTypes: ['layout-shift'] })

      // LCP Observer (Largest Contentful Paint)
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const lastEntry = entries[entries.length - 1]
        if (lastEntry) {
          this.logPerformance('lcp', lastEntry.startTime, 'ms')
        }
      })
      
      lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] })

    } catch (error) {
      debug.warn('Failed to setup performance observers:', error)
    }

    // Page load timing
    window.addEventListener('load', () => {
      setTimeout(() => {
        const timing = performance.timing
        if (timing) {
          const pageLoadTime = timing.loadEventEnd - timing.navigationStart
          const domContentLoaded = timing.domContentLoadedEventEnd - timing.navigationStart
          const ttfb = timing.responseStart - timing.navigationStart

          this.logPerformance('page_load', pageLoadTime, 'ms')
          this.logPerformance('dom_content_loaded', domContentLoaded, 'ms')
          this.logPerformance('ttfb', ttfb, 'ms')
        }
      }, 0)
    })
  }


  getBuffer(): LogEntry[] {
    return [...this.buffer]
  }

  exportLogs(): string {
    return JSON.stringify(this.buffer, null, 2)
  }

  downloadLogs(): void {
    const data = this.exportLogs()
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `harmony-logs-${new Date().toISOString()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }


  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    this.flushToServer()
  }
}


export const loggingService = new LoggingService()

export const log = {
  debug: (message: string, data?: Record<string, any>) => loggingService.debug(message, data),
  info: (message: string, data?: Record<string, any>) => loggingService.info(message, data),
  warn: (message: string, data?: Record<string, any>) => loggingService.warn(message, data),
  error: (message: string, error?: Error, data?: Record<string, any>) => loggingService.error(message, error, data),
  performance: (metric: string, value: number, unit?: string, data?: Record<string, any>) => 
    loggingService.logPerformance(metric, value, unit, data),
  navigation: (from: string, to: string, duration?: number) => 
    loggingService.logNavigation(from, to, duration),
  interaction: (action: string, element?: string, data?: Record<string, any>) => 
    loggingService.logInteraction(action, element, data),
}

export default loggingService

