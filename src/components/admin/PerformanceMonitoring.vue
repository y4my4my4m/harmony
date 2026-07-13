<template>
  <div class="performance-monitoring" :class="{ 'is-fullscreen': isFullscreen }" ref="monitoringEl">
    <!-- Header -->
    <div class="monitoring-header">
      <div class="header-content">
        <h1>Performance Monitoring</h1>
        <p>Metrics and insights for your Harmony instance. <span style="opacity: 0.6; font-size: 12px;">Overview, latency, and slow queries require a pg_cron job calling <code>aggregate_hourly_metrics()</code> to populate data.</span></p>
      </div>
      <div class="header-actions">
        <button @click="toggleFullscreen" class="fullscreen-btn" :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'">
          {{ isFullscreen ? '⛶' : '⛶' }}
        </button>
        <select v-model="timeRange" class="time-selector">
          <option value="1h">Last Hour</option>
          <option value="6h">Last 6 Hours</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 1 Month</option>
          <option value="90d">Last 3 Months</option>
        </select>
        <button class="refresh-btn" @click="refreshData" :disabled="loading">
          <svg 
            width="16" height="16" 
            viewBox="0 0 24 24" 
            fill="currentColor"
            :class="{ spinning: loading }"
          >
            <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
          </svg>
          {{ loading ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>
    </div>

    <!-- Overview Cards -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-icon requests">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/>
          </svg>
        </div>
        <div class="metric-content">
          <div class="metric-value">{{ formatNumber(metrics.totalRequests) }}</div>
          <div class="metric-label">Total Requests</div>
        </div>
        <div class="metric-trend" :class="metrics.requestsTrend > 0 ? 'up' : 'down'">
          <svg v-if="metrics.requestsTrend > 0" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"/>
          </svg>
          {{ Math.abs(metrics.requestsTrend) }}%
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon latency">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
          </svg>
        </div>
        <div class="metric-content">
          <div class="metric-value">{{ metrics.avgLatency }}<span class="unit">ms</span></div>
          <div class="metric-label">Avg Response Time</div>
        </div>
        <div class="metric-status" :class="getLatencyStatus(metrics.avgLatency)">
          {{ getLatencyLabel(metrics.avgLatency) }}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon errors">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
        </div>
        <div class="metric-content">
          <div class="metric-value">{{ metrics.errorRate }}<span class="unit">%</span></div>
          <div class="metric-label">Error Rate</div>
        </div>
        <div class="metric-status" :class="getErrorStatus(metrics.errorRate)">
          {{ getErrorLabel(metrics.errorRate) }}
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon federation">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
        </div>
        <div class="metric-content">
          <div class="metric-value">{{ metrics.federationSuccess }}<span class="unit">%</span></div>
          <div class="metric-label">Federation Success</div>
        </div>
        <div class="metric-status" :class="getFederationStatus(metrics.federationSuccess)">
          {{ getFederationLabel(metrics.federationSuccess) }}
        </div>
      </div>
    </div>

    <!-- Charts Section -->
    <div class="charts-section">
      <div class="chart-container">
        <h3>Request Latency Over Time</h3>
        <div class="chart-placeholder" v-if="!hasChartData">
          <p>No data available for the selected time range</p>
        </div>
        <div v-else class="simple-chart">
          <div class="chart-bars">
            <div 
              v-for="(point, i) in latencyData" 
              :key="i"
              class="bar"
              :style="{ height: `${(point.value / maxLatency) * 100}%` }"
              :title="`${point.label}: ${point.value}ms`"
            >
              <span class="bar-value">{{ point.value }}</span>
            </div>
          </div>
          <div class="chart-labels">
            <span v-for="(point, i) in latencyData" :key="i">{{ point.label }}</span>
          </div>
        </div>
      </div>

      <div class="chart-container">
        <h3>Request Distribution <span style="font-size: 11px; opacity: 0.5; font-weight: 400;">(hardcoded for now, would need cron queries)</span></h3>
        <div class="distribution-list">
          <div 
            v-for="endpoint in endpointStats" 
            :key="endpoint.path"
            class="distribution-item"
          >
            <div class="endpoint-info">
              <span class="method" :class="(endpoint.method ?? 'get').toLowerCase()">{{ endpoint.method }}</span>
              <span class="path">{{ endpoint.path }}</span>
            </div>
            <div class="endpoint-stats">
              <span class="requests">{{ formatNumber(endpoint.requests) }} req</span>
              <span class="latency">{{ endpoint.avgLatency }}ms avg</span>
            </div>
            <div class="progress-bar">
              <div 
                class="progress-fill" 
                :style="{ width: `${(endpoint.requests / maxEndpointRequests) * 100}%` }"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Slow Queries Section -->
    <div class="slow-queries-section">
      <div class="section-header">
        <h3>Slow Queries</h3>
        <span class="badge" v-if="slowQueries.length">{{ slowQueries.length }}</span>
      </div>
      
      <div v-if="slowQueries.length === 0" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" class="empty-icon">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <p>No slow queries detected</p>
        <span>Queries taking longer than 100ms will appear here</span>
      </div>

      <div v-else class="queries-list">
        <div v-for="query in slowQueries" :key="query.id" class="query-item">
          <div class="query-header">
            <span class="query-duration" :class="getDurationClass(query.duration)">
              {{ query.duration }}ms
            </span>
            <span class="query-time">{{ formatTime(query.timestamp) }}</span>
          </div>
          <code class="query-text">{{ truncateQuery(query.query) }}</code>
          <div class="query-meta">
            <span v-if="query.table">Table: {{ query.table }}</span>
            <span v-if="query.rows">Rows: {{ query.rows }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Federation Health -->
    <div class="federation-section">
      <div class="section-header">
        <h3>Federation Health</h3>
      </div>
      
      <div v-if="federationServers.length === 0" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" class="empty-icon">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>
        <p>No federation health data</p>
        <span>Federation metrics appear when the federation_health_metrics table is populated by outbound/inbound activity</span>
      </div>
      
      <div v-else class="federation-grid">
        <div v-for="server in federationServers" :key="server.domain" class="federation-card">
          <div class="server-status" :class="server.status">
            <div class="status-dot"></div>
          </div>
          <div class="server-info">
            <span class="server-domain">{{ server.domain }}</span>
            <span class="server-type">{{ server.software || 'Unknown' }}</span>
          </div>
          <div class="server-stats">
            <div class="stat">
              <span class="stat-value">{{ server.successRate }}%</span>
              <span class="stat-label">Success</span>
            </div>
            <div class="stat">
              <span class="stat-value">{{ server.avgLatency }}ms</span>
              <span class="stat-label">Latency</span>
            </div>
          </div>
          <span class="last-seen">Last seen: {{ formatRelativeTime(server.lastSeen) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/supabase'
import { formatDistanceToNow } from 'date-fns'

const loading = ref(false)
const timeRange = ref('24h')
const refreshInterval = ref<number | null>(null)
const isFullscreen = ref(false)
const monitoringEl = ref<HTMLElement | null>(null)

const toggleFullscreen = async () => {
  if (!monitoringEl.value) return
  if (!document.fullscreenElement) {
    await monitoringEl.value.requestFullscreen()
    isFullscreen.value = true
  } else {
    await document.exitFullscreen()
    isFullscreen.value = false
  }
}

const handleFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement
}
document.addEventListener('fullscreenchange', handleFullscreenChange)

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
})

const metrics = ref({
  totalRequests: 0,
  requestsTrend: 0,
  avgLatency: 0,
  errorRate: 0,
  federationSuccess: 0,
})

const latencyData = ref<{ label: string; value: number }[]>([])
const endpointStats = ref<{
  path: string
  method: string
  requests: number
  avgLatency: number
}[]>([])
const slowQueries = ref<{
  id: string
  query: string
  duration: number
  timestamp: string
  table?: string
  rows?: number
}[]>([])
const federationServers = ref<{
  domain: string
  software?: string
  status: 'healthy' | 'degraded' | 'down'
  successRate: number
  avgLatency: number
  lastSeen: Date
}[]>([])

const hasChartData = computed(() => latencyData.value.length > 0)
const maxLatency = computed(() => Math.max(...latencyData.value.map(d => d.value), 1))
const maxEndpointRequests = computed(() => Math.max(...endpointStats.value.map(e => e.requests), 1))

const formatNumber = (num: number): string => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return num.toString()
}

const formatTime = (timestamp: string): string => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString()
}

const formatRelativeTime = (date: Date): string => {
  return formatDistanceToNow(date, { addSuffix: true })
}

const truncateQuery = (query: string): string => {
  if (query.length <= 200) return query
  return query.substring(0, 200) + '...'
}

const getLatencyStatus = (latency: number): string => {
  if (latency < 100) return 'good'
  if (latency < 300) return 'warning'
  return 'critical'
}

const getLatencyLabel = (latency: number): string => {
  if (latency < 100) return 'Excellent'
  if (latency < 300) return 'Good'
  return 'Slow'
}

const getErrorStatus = (rate: number): string => {
  if (rate < 1) return 'good'
  if (rate < 5) return 'warning'
  return 'critical'
}

const getErrorLabel = (rate: number): string => {
  if (rate < 1) return 'Healthy'
  if (rate < 5) return 'Elevated'
  return 'Critical'
}

const getFederationStatus = (rate: number): string => {
  if (rate >= 95) return 'good'
  if (rate >= 80) return 'warning'
  return 'critical'
}

const getFederationLabel = (rate: number): string => {
  if (rate >= 95) return 'Healthy'
  if (rate >= 80) return 'Degraded'
  return 'Issues'
}

const getDurationClass = (duration: number): string => {
  if (duration < 200) return 'warning'
  if (duration < 500) return 'slow'
  return 'critical'
}

const refreshData = async () => {
  loading.value = true
  try {
    await Promise.all([
      fetchOverviewMetrics(),
      fetchLatencyData(),
      fetchEndpointStats(),
      fetchSlowQueries(),
      fetchFederationHealth(),
    ])
  } catch (error) {
    console.error('Failed to refresh metrics:', error)
  } finally {
    loading.value = false
  }
}

const fetchOverviewMetrics = async () => {
  try {
    const { data, error } = await supabase
      .from('performance_metrics_hourly')
      .select('*')
      .gte('hour', getTimeRangeStart())
      .order('hour', { ascending: false })

    if (error) throw error

    const computeFederationSuccess = async (): Promise<number> => {
      try {
        const { data: fedData } = await supabase
          .from('federation_health_metrics')
          .select('success')
          .gte('recorded_at', getTimeRangeStart())
        if (fedData && fedData.length > 0) {
          const successCount = fedData.filter((r: { success: boolean }) => r.success === true).length
          return Math.round((successCount / fedData.length) * 1000) / 10
        }
      } catch { /* ignore */ }
      return 0
    }

    const fedSuccess = await computeFederationSuccess()
    if (data && data.length > 0) {
      const totalRequests = data.reduce((sum, m) => sum + (m.request_count || 0), 0)
      const totalErrors = data.reduce((sum, m) => sum + (m.error_count || 0), 0)
      const avgLatency = Math.round(
        data.reduce((sum, m) => sum + (m.avg_latency || 0), 0) / data.length
      )
      metrics.value = {
        totalRequests,
        requestsTrend: calculateTrend(data),
        avgLatency,
        errorRate: totalRequests > 0 ? Math.round((totalErrors / totalRequests) * 100 * 10) / 10 : 0,
        federationSuccess: fedSuccess,
      }
    } else {
      metrics.value = { ...metrics.value, federationSuccess: fedSuccess }
    }
  } catch (error) {
    console.error('Failed to fetch overview metrics:', error)
  }
}

const fetchLatencyData = async () => {
  try {
    const { data, error } = await supabase
      .from('performance_metrics_hourly')
      .select('hour, avg_latency')
      .gte('hour', getTimeRangeStart())
      .order('hour', { ascending: true })
      .limit(24)

    if (error) throw error

    latencyData.value = (data || []).map(d => ({
      label: new Date(d.hour).toLocaleTimeString('en-US', { hour: 'numeric' }),
      value: Math.round(d.avg_latency || 0),
    }))
  } catch (error) {
    console.error('Failed to fetch latency data:', error)
  }
}

const fetchEndpointStats = async () => {
  // This would typically come from performance_metrics_raw aggregated by endpoint
  // Using placeholder data for now
  endpointStats.value = [
    { path: '/api/messages', method: 'GET', requests: 15420, avgLatency: 45 },
    { path: '/api/messages', method: 'POST', requests: 8234, avgLatency: 78 },
    { path: '/api/channels', method: 'GET', requests: 5621, avgLatency: 32 },
    { path: '/inbox', method: 'POST', requests: 3215, avgLatency: 125 },
    { path: '/api/users', method: 'GET', requests: 2890, avgLatency: 28 },
  ]
}

const fetchSlowQueries = async () => {
  try {
    const { data, error } = await supabase
      .from('slow_queries')
      .select('*')
      .gte('recorded_at', getTimeRangeStart())
      .order('duration_ms', { ascending: false })
      .limit(20)

    if (error) throw error

    slowQueries.value = (data || []).map(q => ({
      id: q.id,
      query: q.query_text,
      duration: q.duration_ms,
      timestamp: q.recorded_at,
      table: q.table_name,
      rows: q.rows_affected,
    }))
  } catch (error) {
    console.error('Failed to fetch slow queries:', error)
    slowQueries.value = []
  }
}

const fetchFederationHealth = async () => {
  try {
    const { data, error } = await supabase
      .from('federation_health_metrics')
      .select('*')
      .gte('recorded_at', getTimeRangeStart())

    if (error) throw error

    // Aggregate by domain
    const serverMap = new Map<string, any>()
    
    for (const metric of data || []) {
      if (!serverMap.has(metric.remote_domain)) {
        serverMap.set(metric.remote_domain, {
          domain: metric.remote_domain,
          software: metric.software_name,
          requests: [],
          lastSeen: new Date(metric.recorded_at),
        })
      }
      
      const server = serverMap.get(metric.remote_domain)!
      server.requests.push(metric)
      
      if (new Date(metric.recorded_at) > server.lastSeen) {
        server.lastSeen = new Date(metric.recorded_at)
      }
    }

    federationServers.value = Array.from(serverMap.values()).map(server => {
      const successCount = server.requests.filter((r: any) => r.success).length
      const totalLatency = server.requests.reduce((sum: number, r: any) => sum + (r.latency_ms || 0), 0)
      const successRate = server.requests.length > 0 
        ? Math.round((successCount / server.requests.length) * 100) 
        : 0
      
      return {
        domain: server.domain,
        software: server.software,
        status: successRate >= 95 ? 'healthy' : successRate >= 80 ? 'degraded' : 'down',
        successRate,
        avgLatency: server.requests.length > 0 
          ? Math.round(totalLatency / server.requests.length) 
          : 0,
        lastSeen: server.lastSeen,
      }
    })
  } catch (error) {
    console.error('Failed to fetch federation health:', error)
    federationServers.value = []
  }
}

const getTimeRangeStart = (): string => {
  const now = new Date()
  switch (timeRange.value) {
    case '1h':
      return new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    case '6h':
      return new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString()
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    case '90d':
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  }
}

const calculateTrend = (data: any[]): number => {
  if (data.length < 2) return 0
  
  const half = Math.floor(data.length / 2)
  const recent = data.slice(0, half)
  const older = data.slice(half)
  
  const recentTotal = recent.reduce((sum, m) => sum + (m.request_count || 0), 0)
  const olderTotal = older.reduce((sum, m) => sum + (m.request_count || 0), 0)
  
  if (olderTotal === 0) return 0
  return Math.round(((recentTotal - olderTotal) / olderTotal) * 100)
}

onMounted(() => {
  refreshData()
  // Auto-refresh every 30 seconds
  refreshInterval.value = window.setInterval(refreshData, 30000)
})

onUnmounted(() => {
  if (refreshInterval.value) {
    clearInterval(refreshInterval.value)
  }
})
</script>

<style scoped>
.performance-monitoring {
  padding: 24px;
  max-width: 1400px;
  margin: 0 auto;
}

.performance-monitoring.is-fullscreen {
  max-width: none;
  height: 100vh;
  overflow-y: auto;
  background: var(--background-primary, #1e1f22);
}

.fullscreen-btn {
  background: var(--background-tertiary, #2b2d31);
  border: 1px solid var(--border-color, #3f4147);
  color: var(--text-primary);
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
}

.fullscreen-btn:hover {
  background: var(--background-hover);
}

.monitoring-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}

.header-content h1 {
  margin: 0 0 4px 0;
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.header-content p {
  margin: 0;
  color: var(--text-secondary);
}

.header-actions {
  display: flex;
  gap: 12px;
}

.time-selector {
  padding: 8px 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--background-tertiary);
}

.refresh-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.refresh-btn svg.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Metrics Grid */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.metric-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--background-secondary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
}

.metric-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.metric-icon.requests { background: rgba(14, 165, 233, 0.15); color: var(--harmony-primary); }
.metric-icon.latency { background: rgba(46, 204, 113, 0.15); color: #2ECC71; }
.metric-icon.errors { background: rgba(231, 76, 60, 0.15); color: #E74C3C; }
.metric-icon.federation { background: rgba(155, 89, 182, 0.15); color: #9B59B6; }

.metric-content {
  flex: 1;
}

.metric-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1;
}

.metric-value .unit {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-left: 2px;
}

.metric-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.metric-trend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
}

.metric-trend.up { color: #2ECC71; }
.metric-trend.down { color: #E74C3C; }

.metric-status {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 12px;
}

.metric-status.good { background: rgba(46, 204, 113, 0.15); color: #2ECC71; }
.metric-status.warning { background: rgba(241, 196, 15, 0.15); color: #F1C40F; }
.metric-status.critical { background: rgba(231, 76, 60, 0.15); color: #E74C3C; }

/* Charts */
.charts-section {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.chart-container {
  background: var(--background-secondary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
  padding: 20px;
}

.chart-container h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.chart-placeholder {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.simple-chart {
  height: 200px;
  display: flex;
  flex-direction: column;
}

.chart-bars {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding-bottom: 8px;
}

.bar {
  flex: 1;
  background: var(--harmony-primary);
  border-radius: 4px 4px 0 0;
  min-height: 4px;
  position: relative;
  transition: height 0.3s ease;
}

.bar:hover {
  background: var(--harmony-primary-hover, #0284C7);
}

.bar-value {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  color: var(--text-secondary);
  opacity: 0;
  transition: opacity 0.2s;
}

.bar:hover .bar-value {
  opacity: 1;
}

.chart-labels {
  display: flex;
  gap: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.chart-labels span {
  flex: 1;
  text-align: center;
}

/* Distribution List */
.distribution-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.distribution-item {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.endpoint-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 200px;
}

.method {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.method.get { background: rgba(46, 204, 113, 0.15); color: #2ECC71; }
.method.post { background: rgba(52, 152, 219, 0.15); color: #3498DB; }
.method.put { background: rgba(241, 196, 15, 0.15); color: #F1C40F; }
.method.delete { background: rgba(231, 76, 60, 0.15); color: #E74C3C; }

.path {
  font-family: monospace;
  font-size: 13px;
  color: var(--text-primary);
}

.endpoint-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.progress-bar {
  width: 100%;
  height: 4px;
  background: var(--background-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--harmony-primary);
  border-radius: 2px;
  transition: width 0.3s ease;
}

/* Slow Queries */
.slow-queries-section,
.federation-section {
  background: var(--background-secondary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
  padding: 20px;
  margin-bottom: 24px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}

.section-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.badge {
  background: var(--harmony-primary);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.empty-state p {
  margin: 0 0 4px 0;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-state span {
  font-size: 13px;
}

.queries-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 400px;
  overflow-y: auto;
}

.query-item {
  padding: 12px;
  background: var(--background-tertiary);
  border-radius: 8px;
}

.query-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.query-duration {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}

.query-duration.warning { background: rgba(241, 196, 15, 0.15); color: #F1C40F; }
.query-duration.slow { background: rgba(230, 126, 34, 0.15); color: #E67E22; }
.query-duration.critical { background: rgba(231, 76, 60, 0.15); color: #E74C3C; }

.query-time {
  font-size: 12px;
  color: var(--text-secondary);
}

.query-text {
  display: block;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--background-primary);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.query-meta {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}

/* Federation */
.federation-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.federation-card {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  align-items: center;
}

.server-status {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.server-status.healthy .status-dot { background: #2ECC71; }
.server-status.degraded .status-dot { background: #F1C40F; }
.server-status.down .status-dot { background: #E74C3C; }

.server-info {
  flex: 1;
  min-width: 150px;
}

.server-domain {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.server-type {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
}

.server-stats {
  display: flex;
  gap: 16px;
}

.stat {
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.stat-label {
  display: block;
  font-size: 10px;
  color: var(--text-secondary);
}

.last-seen {
  width: 100%;
  font-size: 11px;
  color: var(--text-muted);
}

/* Responsive */
@media (max-width: 768px) {
  .monitoring-header {
    flex-direction: column;
    gap: 16px;
  }
  
  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }
  
  .charts-section {
    grid-template-columns: 1fr;
  }
}
</style>

