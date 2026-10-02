<template>
  <div class="admin-module retention-module">
    <div class="module-header">
      <Icon name="trending-up" :size="20" />
      <h2>{{ t('adminRetention.title') }}</h2>
      <div class="module-actions">
        <button type="button" class="action-btn" :disabled="loading" @click="load">
          <Icon name="refresh" :size="16" :class="{ spin: loading }" />
          {{ t('adminRetention.refresh') }}
        </button>
      </div>
    </div>

    <div class="module-body">
      <p class="module-hint">{{ t('adminRetention.intro') }}</p>

      <div class="retention-controls">
        <div class="control" role="group" :aria-label="t('adminRetention.period')">
          <span class="control-label">{{ t('adminRetention.period') }}</span>
          <div class="segmented">
            <button
              v-for="p in PERIODS"
              :key="p"
              type="button"
              :class="['segment', { active: period === p }]"
              :aria-pressed="period === p"
              @click="period = p"
            >
              {{ t(`adminRetention.${p}`) }}
            </button>
          </div>
        </div>
        <label class="control">
          <span class="control-label">{{ t('adminRetention.range') }}</span>
          <select v-model.number="months" class="cyber-select compact">
            <option v-for="n in RANGE_MONTHS" :key="n" :value="n">
              {{ t('adminRetention.rangeMonths', { n }) }}
            </option>
          </select>
        </label>
      </div>

      <EmptyState v-if="loading && rows.length === 0" :title="t('adminRetention.loading')">
        <template #icon><LoadingSpinner :size="24" /></template>
      </EmptyState>
      <EmptyState
        v-else-if="error !== null"
        tone="error"
        icon="alert-circle"
        :title="t('adminRetention.loadFailed')"
        :description="error || undefined"
        :action-label="t('common.retry')"
        @action="load"
      />
      <EmptyState
        v-else-if="totals.signups === 0"
        icon="users"
        :title="t('adminRetention.emptyTitle')"
        :description="t('adminRetention.emptyDescription')"
      />
      <template v-else>
        <div class="cohort-table-wrap" :class="{ refreshing: loading }" :aria-busy="loading">
          <table class="cohort-table" :aria-label="t('adminRetention.tableLabel')">
            <thead>
              <tr>
                <th scope="col" class="col-cohort">{{ t('adminRetention.columns.cohort') }}</th>
                <th scope="col" class="col-count" :title="t('adminRetention.help.signups')">
                  {{ t('adminRetention.columns.signups') }}
                </th>
                <th
                  v-for="m in RETENTION_METRICS"
                  :key="m.key"
                  scope="col"
                  :title="t(`adminRetention.help.${m.key}`)"
                >
                  {{ t(`adminRetention.columns.${m.key}`) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in tableRows"
                :key="row.key"
                :class="{ small: row.small, vacant: row.signups === 0 }"
              >
                <th scope="row" class="col-cohort">
                  {{ row.label }}
                  <span v-if="row.small" class="small-mark" :title="t('adminRetention.smallCohort', { n: SMALL_COHORT })">*</span>
                </th>
                <td class="col-count">{{ formatCount(row.signups) }}</td>
                <td
                  v-for="cell in row.cells"
                  :key="cell.key"
                  :class="['cell', cell.level === null ? 'heat-none' : `heat-${cell.level}`]"
                  :title="cell.title"
                >
                  {{ cell.text }}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" class="col-cohort">{{ t('adminRetention.total') }}</th>
                <td class="col-count">{{ formatCount(totals.signups) }}</td>
                <td
                  v-for="cell in totalCells"
                  :key="cell.key"
                  :class="['cell', cell.level === null ? 'heat-none' : `heat-${cell.level}`]"
                  :title="cell.title"
                >
                  {{ cell.text }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="table-note">
          <span class="small-mark" aria-hidden="true">*</span>
          {{ t('adminRetention.noteSmall', { n: SMALL_COHORT, points: Math.round(100 / SMALL_COHORT) }) }}
        </p>
        <p class="table-note">{{ t('adminRetention.noteWindows') }}</p>
      </template>

      <section class="metric-legend" aria-labelledby="retention-legend-title">
        <h3 id="retention-legend-title" class="legend-title">{{ t('adminRetention.legend') }}</h3>
        <dl>
          <div v-for="key in LEGEND_KEYS" :key="key" class="legend-row">
            <dt>{{ t(`adminRetention.columns.${key}`) }}</dt>
            <dd>{{ t(`adminRetention.help.${key}`) }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { adminService, type CohortPeriod, type SignupCohort } from '@/services/AdminService'
import {
  RANGE_MONTHS,
  RETENTION_METRICS,
  SMALL_COHORT,
  formatCohortDate,
  formatPercent,
  heatLevel,
  isSmallCohort,
  rate,
  sumCohorts,
} from './retentionFormat'

const { t, locale } = useI18n()

const PERIODS: readonly CohortPeriod[] = ['month', 'week']
const LEGEND_KEYS = ['signups', ...RETENTION_METRICS.map(m => m.key)]

const period = ref<CohortPeriod>('month')
const months = ref<number>(12)
const rows = ref<SignupCohort[]>([])
const rowsPeriod = ref<CohortPeriod>('month')
const loading = ref(true)
const error = ref<string | null>(null)
let requestId = 0

interface Cell {
  key: string
  text: string
  title: string
  level: number | null
}

function formatCount(n: number): string {
  return new Intl.NumberFormat(locale.value).format(n)
}

function buildCells(source: Omit<SignupCohort, 'cohort_start'>): Cell[] {
  return RETENTION_METRICS.map((m) => {
    const n = source[m.numerator]
    const d = source[m.denominator]
    const value = rate(n, d)
    const pct = formatPercent(value, locale.value)
    return {
      key: m.key,
      text: pct,
      title: value === null
        ? t('adminRetention.notReached')
        : t('adminRetention.cellTitle', { n: formatCount(n), d: formatCount(d), pct }),
      level: heatLevel(value),
    }
  })
}

const tableRows = computed(() =>
  [...rows.value].reverse().map(row => ({
    key: row.cohort_start,
    label: rowsPeriod.value === 'month'
      ? formatCohortDate(row.cohort_start, 'month', locale.value)
      : t('adminRetention.weekOf', { date: formatCohortDate(row.cohort_start, 'week', locale.value) }),
    signups: row.signups,
    small: isSmallCohort(row.signups),
    cells: buildCells(row),
  })),
)

const totals = computed(() => sumCohorts(rows.value))
const totalCells = computed(() => buildCells(totals.value))

async function load() {
  const id = ++requestId
  loading.value = true
  error.value = null
  try {
    const requested = period.value
    const data = await adminService.getSignupCohorts(months.value, requested)
    if (id !== requestId) return
    rows.value = data
    rowsPeriod.value = requested
  } catch (err: any) {
    if (id !== requestId) return
    debug.error('Failed to load signup cohorts:', err)
    error.value = err?.message ?? ''
    rows.value = []
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch([period, months], () => { void load() })
onMounted(load)
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.retention-module {
  min-width: 0;
}

.module-body {
  padding: 16px 24px 24px;
  min-width: 0;
}

.module-hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.retention-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 20px;
  margin-bottom: 16px;
}

.control {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.control-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.segmented {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.segment {
  min-height: 36px;
  padding: 0 14px;
  border: none;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.segment + .segment {
  border-left: 1px solid var(--border-color);
}

.segment:hover {
  color: var(--text-primary);
}

.segment.active {
  background: color-mix(in srgb, var(--harmony-primary) 14%, var(--background-tertiary));
  color: var(--harmony-primary);
}

.segment:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

.cyber-select.compact {
  width: auto;
  min-height: 36px;
  padding: 6px 10px;
}

/* The table scrolls inside the module; the page does not. */
.cohort-table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  transition: opacity 0.15s ease;
}

.cohort-table-wrap.refreshing {
  opacity: 0.6;
}

.cohort-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.cohort-table th,
.cohort-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  text-align: right;
  white-space: nowrap;
}

.cohort-table thead th {
  background: var(--background-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  white-space: normal;
  text-wrap: balance;
  min-width: 84px;
  vertical-align: bottom;
  cursor: help;
}

.cohort-table .col-cohort {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 128px;
  text-align: left;
  background: var(--background-secondary);
  font-weight: 600;
  color: var(--text-primary);
}

.cohort-table thead .col-cohort {
  z-index: 2;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: default;
}

.cohort-table .col-count {
  color: var(--text-primary);
  font-weight: 600;
}

.cohort-table tbody tr:last-child th,
.cohort-table tbody tr:last-child td {
  border-bottom: 2px solid var(--border-color);
}

.cohort-table tfoot th,
.cohort-table tfoot td {
  border-bottom: none;
  font-weight: 700;
}

.cohort-table tfoot .col-cohort {
  background: var(--background-tertiary);
}

.cell {
  color: var(--text-primary);
}

.heat-none {
  color: var(--text-muted);
}

.heat-0 {
  color: var(--text-secondary);
}

.heat-1 { background: color-mix(in srgb, var(--harmony-primary) 8%, transparent); }
.heat-2 { background: color-mix(in srgb, var(--harmony-primary) 16%, transparent); }
.heat-3 { background: color-mix(in srgb, var(--harmony-primary) 24%, transparent); }
.heat-4 { background: color-mix(in srgb, var(--harmony-primary) 32%, transparent); }
.heat-5 { background: color-mix(in srgb, var(--harmony-primary) 42%, transparent); }

tr.small .cell,
tr.small .col-count {
  opacity: 0.7;
}

tr.vacant th,
tr.vacant td {
  color: var(--text-muted);
}

.small-mark {
  margin-left: 2px;
  color: var(--warning);
  font-weight: 700;
  cursor: help;
}

.table-note {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
}

.metric-legend {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.legend-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.metric-legend dl {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  gap: 12px 24px;
  margin: 0;
}

.legend-row dt {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.legend-row dd {
  margin: 2px 0 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .module-body {
    padding: 12px 16px 16px;
  }

  .module-header {
    flex-wrap: wrap;
  }

  .cohort-table .col-cohort {
    min-width: 108px;
  }
}
</style>
