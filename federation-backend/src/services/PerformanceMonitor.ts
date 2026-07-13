import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export interface MetricOptions {
  labels?: Record<string, any>;
  source?: 'frontend' | 'backend' | 'federation-backend';
}

export interface SlowQueryOptions {
  queryText?: string;
  operationType?: string;
  tableName?: string;
  parameters?: Record<string, any>;
  source?: string;
  userId?: string;
  requestId?: string;
}

// Slow query threshold in milliseconds
const SLOW_QUERY_THRESHOLD = 100;

class PerformanceMonitor {
  private metricsBuffer: Array<{
    metric_type: string;
    metric_name: string;
    value: number;
    unit: string;
    labels: Record<string, any>;
    source: string;
    timestamp: Date;
  }> = [];

  private readonly BUFFER_SIZE = 100;
  private readonly FLUSH_INTERVAL = 10000; // 10 seconds
  private flushTimer: NodeJS.Timeout | null = null;
  private enabled = true;

  constructor() {
    this.startFlushTimer();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.metricsBuffer = [];
    }
  }

  recordMetric(
    type: string,
    name: string,
    value: number,
    unit: string = 'ms',
    options: MetricOptions = {}
  ): void {
    if (!this.enabled) return;

    this.metricsBuffer.push({
      metric_type: type,
      metric_name: name,
      value,
      unit,
      labels: options.labels || {},
      source: options.source || 'federation-backend',
      timestamp: new Date(),
    });

    // Flush if buffer is full
    if (this.metricsBuffer.length >= this.BUFFER_SIZE) {
      this.flush();
    }
  }

  recordRequestLatency(
    method: string,
    path: string,
    statusCode: number,
    durationMs: number,
    options: MetricOptions = {}
  ): void {
    const name = `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    this.recordMetric('request_latency', name, durationMs, 'ms', {
      ...options,
      labels: {
        ...options.labels,
        method,
        path,
        status_code: statusCode,
      },
    });

    if (durationMs > 1000) {
      logger.warn(`⚠️ Slow request: ${method} ${path} took ${durationMs}ms`);
    }
  }

  recordQueryTime(
    tableName: string,
    operation: string,
    durationMs: number,
    options: SlowQueryOptions = {}
  ): void {
    this.recordMetric('query_time', `${operation}_${tableName}`, durationMs, 'ms', {
      labels: { table: tableName, operation },
      source: options.source || 'federation-backend',
    });

    // Record slow query if above threshold
    if (durationMs > SLOW_QUERY_THRESHOLD) {
      this.recordSlowQuery(durationMs, {
        ...options,
        operationType: operation,
        tableName,
      });
    }
  }

  async recordSlowQuery(durationMs: number, options: SlowQueryOptions = {}): Promise<void> {
    if (!this.enabled) return;

    try {
      const supabase = getSupabaseClient();
      await supabase.rpc('record_slow_query', {
        p_duration_ms: durationMs,
        p_query_text: options.queryText || null,
        p_operation_type: options.operationType || null,
        p_table_name: options.tableName || null,
        p_parameters: options.parameters || null,
        p_source: options.source || 'federation-backend',
        p_user_id: options.userId || null,
        p_request_id: options.requestId || null,
      });

      logger.warn(`🐌 Slow query recorded: ${options.operationType || 'unknown'} on ${options.tableName || 'unknown'} (${durationMs}ms)`);
    } catch (error) {
      logger.error('Failed to record slow query:', error);
    }
  }

  recordFederationDelivery(
    targetDomain: string,
    success: boolean,
    durationMs: number,
    activityType?: string
  ): void {
    this.recordMetric('federation_delivery', targetDomain, durationMs, 'ms', {
      labels: {
        target_domain: targetDomain,
        success,
        activity_type: activityType,
      },
    });

    this.updateFederationHealth(targetDomain, success, durationMs);
  }

  recordQueueProcessing(queueName: string, durationMs: number, success: boolean): void {
    this.recordMetric('queue_processing', queueName, durationMs, 'ms', {
      labels: { queue: queueName, success },
    });
  }

  async updateFederationHealth(
    instanceDomain: string,
    success: boolean,
    latencyMs?: number,
    error?: string
  ): Promise<void> {
    if (!this.enabled) return;

    try {
      const supabase = getSupabaseClient();
      await supabase.rpc('update_federation_health', {
        p_instance_domain: instanceDomain,
        p_success: success,
        p_latency_ms: latencyMs || null,
        p_error: error || null,
      });
    } catch (err) {
      logger.error('Failed to update federation health:', err);
    }
  }

  startTimer(): () => number {
    const start = process.hrtime.bigint();
    return () => {
      const end = process.hrtime.bigint();
      return Number(end - start) / 1_000_000; // Convert to milliseconds
    };
  }

  async flush(): Promise<void> {
    if (this.metricsBuffer.length === 0) return;

    const metricsToFlush = [...this.metricsBuffer];
    this.metricsBuffer = [];

    try {
      const supabase = getSupabaseClient();

      // Batch insert metrics
      const { error } = await supabase
        .from('performance_metrics')
        .insert(metricsToFlush.map(m => ({
          metric_type: m.metric_type,
          metric_name: m.metric_name,
          value: m.value,
          unit: m.unit,
          labels: m.labels,
          source: m.source,
          timestamp: m.timestamp.toISOString(),
        })));

      if (error) {
        logger.error('Failed to flush metrics:', error);
        // Re-add failed metrics to buffer (up to limit)
        this.metricsBuffer = [...metricsToFlush.slice(-50), ...this.metricsBuffer];
      } else {
        logger.debug(`📊 Flushed ${metricsToFlush.length} metrics`);
      }
    } catch (error) {
      logger.error('Failed to flush metrics:', error);
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.FLUSH_INTERVAL);
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
  }

  async getMetricsSummary(): Promise<any> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('metrics_summary_view')
        .select('*')
        .limit(100);

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Failed to get metrics summary:', error);
      return [];
    }
  }

  async getSlowQueriesSummary(): Promise<any> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('slow_queries_summary')
        .select('*')
        .limit(50);

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Failed to get slow queries summary:', error);
      return [];
    }
  }

  async getFederationHealth(): Promise<any> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('federation_health')
        .select('*')
        .order('timestamp', { ascending: false });

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Failed to get federation health:', error);
      return [];
    }
  }

  async getHourlyMetrics(
    metricType: string,
    hours: number = 24
  ): Promise<any> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from('performance_metrics_hourly')
        .select('*')
        .eq('metric_type', metricType)
        .gte('hour', new Date(Date.now() - hours * 60 * 60 * 1000).toISOString())
        .order('hour', { ascending: true });

      if (error) throw error;
      return data;
    } catch (error) {
      logger.error('Failed to get hourly metrics:', error);
      return [];
    }
  }

  async runHourlyAggregation(): Promise<number> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('aggregate_hourly_metrics');

      if (error) throw error;
      logger.info(`📊 Hourly aggregation completed: ${data} records`);
      return data || 0;
    } catch (error) {
      logger.error('Failed to run hourly aggregation:', error);
      return 0;
    }
  }

  async runCleanup(
    rawRetentionDays: number = 7,
    hourlyRetentionDays: number = 90,
    slowQueryRetentionDays: number = 30
  ): Promise<any> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('cleanup_old_metrics', {
        p_raw_retention_days: rawRetentionDays,
        p_hourly_retention_days: hourlyRetentionDays,
        p_slow_query_retention_days: slowQueryRetentionDays,
      });

      if (error) throw error;
      logger.info('🧹 Metrics cleanup completed:', data);
      return data;
    } catch (error) {
      logger.error('Failed to run metrics cleanup:', error);
      return null;
    }
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

export function performanceMiddleware() {
  return (req: any, res: any, next: any) => {
    const stopTimer = performanceMonitor.startTimer();

    res.on('finish', () => {
      const durationMs = stopTimer();
      performanceMonitor.recordRequestLatency(
        req.method,
        req.path,
        res.statusCode,
        durationMs
      );
    });

    next();
  };
}

export default performanceMonitor;

