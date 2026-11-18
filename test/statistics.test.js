import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageLedger, accountLimits, rateLimitSummary } from '../lib/statistics.js'

test('rate limit events are converted from fractions to percentages', () => {
  const summary = rateLimitSummary({
    status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1763362200,
    overageStatus: 'rejected', utilization: 0.06,
    unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: 1763362200 }, seven_day: { utilization: 0.05, resetsAt: 1763535000 } },
  })
  assert.equal(summary.utilization, 6)
  assert.deepEqual(summary.windows.map(row => row.id), ['five_hour', 'seven_day'])
  assert.equal(summary.windows[0].label, '5 小时窗口')
  assert.equal(summary.windows[1].utilization, 5)
  assert.match(summary.windows[0].resetsAt, /^2025-|^2026-/)
})

test('account limits read the nested rate_limits payload including model scoped rows', () => {
  const limits = accountLimits({
    subscription_type: 'pro',
    rate_limits: {
      five_hour: { utilization: 7, resets_at: '2026-11-17T05:30:00.047406+00:00' },
      seven_day: { utilization: 5, resets_at: '2026-11-19T19:00:00.047446+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false, currency: 'USD', monthly_limit: 2000, used_credits: 0 },
      model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-11-19T19:00:00+00:00' }],
    },
  })
  assert.equal(limits.available, true)
  assert.equal(limits.subscriptionType, 'pro')
  assert.deepEqual(limits.windows.map(row => row.id), ['five_hour', 'seven_day', 'model:Fable'])
  assert.equal(limits.windows[2].label, 'Fable 模型专属')
  assert.equal(limits.windows[0].utilization, 7)
  assert.equal(limits.extraUsage.enabled, false)
  assert.equal(limits.extraUsage.monthlyLimit, 2000)
  assert.equal(accountLimits(undefined), null)
  assert.equal(accountLimits({}).available, false)
})

test('ledger accumulates tokens, differences cumulative cost, and separates auxiliary turns', () => {
  const ledger = new UsageLedger()
  ledger.record('s1', 'run-1', { type: 'rate-limit', info: { utilization: 0.06, unifiedWindows: {} } }, '')
  ledger.record('s1', 'run-1', { type: 'statistics', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 }, costUsd: 0.01, model: 'claude-opus-5-5', effort: 'high', success: true }, '')
  ledger.record('s1', 'run-1', { type: 'statistics', usage: { inputTokens: 50, outputTokens: 5 }, costUsd: 0.03, model: 'claude-opus-5-5', effort: 'high', success: true }, '')
  ledger.record('s1', 'run-2', { type: 'statistics', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.005, model: 'claude-sonnet-5-5', effort: 'default', success: false }, 'title')
  const row = ledger.get('s1')
  assert.equal(row.turns, 2)
  assert.equal(row.auxiliaryTurns, 1)
  assert.equal(row.totals.inputTokens, 151)
  assert.equal(row.totals.outputTokens, 16)
  assert.equal(row.totals.cacheReadTokens, 5)
  assert.equal(Number(row.costUsd.toFixed(4)), 0.035)
  assert.equal(row.last.model, 'claude-sonnet-5-5')
  assert.equal(row.last.effort, 'default')
  assert.equal(row.last.success, false)
  assert.equal(row.runs, undefined)
})

test('ledger compacts old sessions and aggregates across them', () => {
  const ledger = new UsageLedger({ maxSessions: 2 })
  for (const id of ['a', 'b', 'c']) ledger.record(id, 'run', { type: 'statistics', usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.1, model: 'm', success: true }, '')
  assert.equal(ledger.get('a'), null)
  const aggregate = ledger.aggregate()
  assert.equal(aggregate.sessions, 2)
  assert.equal(aggregate.turns, 2)
  assert.equal(aggregate.totals.inputTokens, 2)
  assert.equal(aggregate.costUsd, 0.2)
})

test('latest rate limit reports the most recent session reading', () => {
  const ledger = new UsageLedger()
  assert.equal(ledger.latestRateLimit(), null)
  ledger.record('s1', 'run-1', { type: 'rate-limit', info: { utilization: 0.2, rateLimitType: 'five_hour', unifiedWindows: {} } }, '')
  const latest = ledger.latestRateLimit()
  assert.equal(latest.utilization, 20)
  assert.equal(latest.sessionId, 's1')
  assert.equal(typeof latest.updatedAt, 'string')
})

test('ledger persists totals across instances', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const file = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
  const first = new UsageLedger({ file })
  first.record('session-a', 'run-1', { type: 'statistics', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.25, model: 'sonnet', success: true }, undefined)
  const second = new UsageLedger({ file })
  assert.equal(second.get('session-a').totals.inputTokens, 10)
  assert.equal(second.get('session-a').costUsd, 0.25)
  assert.equal(second.aggregate().turns, 1)
})
