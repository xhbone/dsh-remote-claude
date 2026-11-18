import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const percent = value => {
  const number = finite(value)
  return number === undefined ? null : Math.round(number * 10) / 10
}
const fractionPercent = value => {
  const number = finite(value)
  return number === undefined ? null : Math.round(number * 1000) / 10
}
const isoTime = value => {
  if (typeof value === 'string' && value.length <= 80) return value
  const seconds = finite(value)
  return seconds === undefined ? null : new Date(seconds * 1000).toISOString()
}

const WINDOW_LABELS = { five_hour: '5 小时窗口', seven_day: '7 天窗口' }

// `rate_limit_event` reports utilization as a 0-1 fraction; `get_usage` reports
// percentages. Both end up as 0-100 numbers so the UI has one scale.
export function rateLimitSummary(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const key of ['status', 'rateLimitType', 'overageStatus', 'overageDisabledReason']) {
    if (typeof raw[key] === 'string') out[key] = raw[key].slice(0, 100)
  }
  if (typeof raw.resetsAt === 'string' || finite(raw.resetsAt) !== undefined) out.resetsAt = isoTime(raw.resetsAt)
  if (finite(raw.utilization) !== undefined) out.utilization = fractionPercent(raw.utilization)
  const windows = []
  const source = raw.unifiedWindows && typeof raw.unifiedWindows === 'object' ? raw.unifiedWindows : {}
  for (const [id, label] of Object.entries(WINDOW_LABELS)) {
    const window = source[id]
    if (!window || typeof window !== 'object') continue
    windows.push({ id, label, utilization: fractionPercent(window.utilization), resetsAt: isoTime(window.resetsAt) })
  }
  if (windows.length) out.windows = windows
  return Object.keys(out).length ? out : null
}

// Accepts the whole `get_usage` response or its `rate_limits` member.
export function accountLimits(raw) {
  if (!raw || typeof raw !== 'object') return null
  const source = raw.rate_limits && typeof raw.rate_limits === 'object' ? raw.rate_limits : raw
  const windows = []
  const push = (id, label, value) => {
    if (!value || typeof value !== 'object') return
    const utilization = percent(value.utilization)
    const resetsAt = isoTime(value.resets_at)
    if (utilization === null && !resetsAt) return
    windows.push({ id, label, utilization, resetsAt })
  }
  for (const [id, label] of Object.entries(WINDOW_LABELS)) push(id, label, source[id])
  for (const row of Array.isArray(source.model_scoped) ? source.model_scoped : []) {
    const name = typeof row?.display_name === 'string' ? row.display_name.slice(0, 80) : ''
    if (!name) continue
    const utilization = percent(row.utilization)
    const resetsAt = isoTime(row.resets_at)
    if (utilization === null && !resetsAt) continue
    windows.push({ id: `model:${name}`, label: `${name} 模型专属`, utilization, resetsAt })
  }
  const extra = source.extra_usage && typeof source.extra_usage === 'object' ? source.extra_usage : null
  return {
    available: windows.length > 0,
    subscriptionType: typeof raw.subscription_type === 'string' ? raw.subscription_type.slice(0, 40) : null,
    windows,
    extraUsage: extra ? {
      enabled: extra.is_enabled === true,
      currency: typeof extra.currency === 'string' ? extra.currency.slice(0, 8) : null,
      monthlyLimit: finite(extra.monthly_limit) ?? null,
      usedCredits: finite(extra.used_credits) ?? null,
    } : null,
  }
}

// Lifetime is this Host activation. Cumulative CLI costs are differenced by run,
// so successive result messages cannot count the same cost twice.
export class UsageLedger {
  constructor({ maxSessions = 500, file } = {}) {
    this.rows = new Map()
    this.maxSessions = maxSessions
    this.file = file
    this.#load()
  }

  #load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const row of Array.isArray(saved?.sessions) ? saved.sessions : []) {
        if (!row || typeof row.sessionId !== 'string') continue
        this.rows.set(row.sessionId, { ...row, runs: new Map(Array.isArray(row.runs) ? row.runs : []) })
      }
    } catch {}
  }

  #save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const sessions = [...this.rows.values()].map(row => ({ ...row, runs: [...row.runs.entries()] }))
      writeFileSync(this.file, JSON.stringify({ version: 1, sessions }), { mode: 0o600 })
    } catch {}
  }
  record(sessionId, runId, event, purpose) {
    let row = this.rows.get(sessionId)
    if (!row) {
      row = { sessionId, turns: 0, auxiliaryTurns: 0, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: null, runs: new Map(), last: null, rateLimit: null, updatedAt: null }
      this.rows.set(sessionId, row)
      if (this.rows.size > this.maxSessions) this.rows.delete(this.rows.keys().next().value)
    }
    if (event.type === 'rate-limit') row.rateLimit = rateLimitSummary(event.info)
    if (event.type === 'statistics') {
      row.turns += purpose ? 0 : 1
      row.auxiliaryTurns += purpose ? 1 : 0
      for (const key of Object.keys(row.totals)) row.totals[key] += finite(event.usage?.[key]) ?? 0
      const cumulative = finite(event.costUsd)
      if (cumulative !== undefined) {
        const previous = row.runs.get(runId) ?? 0
        // Preserve the last high-water mark if an older result is replayed.
        row.costUsd = (row.costUsd ?? 0) + Math.max(0, cumulative - previous)
        row.runs.set(runId, Math.max(previous, cumulative))
      }
      row.last = { model: String(event.model || '').slice(0, 256), effort: event.effort || 'default', usage: event.usage ?? null,
        contextUsage: event.contextUsage ?? null, success: event.success === true, purpose: purpose || null, runCostUsd: cumulative ?? null }
    }
    row.updatedAt = new Date().toISOString()
    this.#save()
  }
  get(sessionId) {
    const row = this.rows.get(sessionId)
    if (!row) return null
    const { runs, ...view } = row
    return structuredClone(view)
  }
  // The most recent quota reading any remote session reported, so the settings
  // page can show limits without waiting for a discovery probe.
  latestRateLimit() {
    let found = null
    for (const row of this.rows.values()) {
      if (!row.rateLimit) continue
      if (!found || String(row.updatedAt) > String(found.updatedAt)) found = { ...row.rateLimit, updatedAt: row.updatedAt, sessionId: row.sessionId }
    }
    return found
  }
  // Session-independent totals across every Remote Claude session on this Host.
  aggregate() {
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    let costUsd = 0
    let turns = 0
    let sessions = 0
    for (const row of this.rows.values()) {
      sessions += 1
      turns += row.turns
      if (row.costUsd) costUsd += row.costUsd
      for (const key of Object.keys(totals)) totals[key] += row.totals[key]
    }
    return { sessions, turns, totals, costUsd: Math.round(costUsd * 1e6) / 1e6 }
  }
}
