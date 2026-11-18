import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHandler } from '../lib/runtime-api.js'
import { UsageLedger } from '../lib/statistics.js'

const models = [
  { id: 'opus', name: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
]
const usage = {
  subscription_type: 'pro',
  rate_limits: {
    five_hour: { utilization: 12, resets_at: '2026-11-17T05:30:00+00:00' },
    seven_day: { utilization: 30, resets_at: '2026-11-19T19:00:00+00:00' },
  },
}

function fixture({ probe, createSsh, sessionExists = id => id === 'session-1' } = {}) {
  const updates = []
  let row = { ns: 'remote-claude-host', revision: 3, value: { claudeModel: 'sonnet', reasoningEffort: 'default' } }
  const config = { host: 'vps.test', port: 22, username: 'workspace', claudePath: 'claude', knownHostFingerprint: `SHA256:${'a'.repeat(43)}`, modelCatalog: '[]', customModels: '', activityPollMs: 1500 }
  const ctx = {
    agents: { get: id => sessionExists(id) ? { id } : undefined },
    settings: {
      describe: options => { assert.equal(options.redactSecrets, true); return [row] },
      async update(ns, value, revision) {
        updates.push([ns, value, revision])
        row = { ...row, revision: revision + 1, value: { ...row.value, ...value } }
      },
    },
  }
  const ledger = new UsageLedger()
  const manager = { ledger, cleanupRemoteRuns: async () => ({ reaped: 0, removed: 0 }) }
  const handler = createRuntimeHandler(ctx, config, manager, { ...(probe ? { probe } : {}), ...(createSsh ? { createSsh } : {}) })
  const call = (method, query = '') => handler(new Request(`http://127.0.0.1:20263/api/remote-claude/runtime${query}`, { method }))
  return { config, ctx, ledger, manager, handler, call, updates, row: () => row }
}

test('GET describes models, effort ids, scope, and an empty quota before any refresh', async () => {
  const f = fixture()
  const response = await f.call('GET')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.available, true)
  assert.equal(body.scope, 'host-activation')
  assert.deepEqual(body.efforts.map(row => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.ok(body.models.some(row => row.id === 'sonnet'))
  assert.equal(body.account.available, false)
  assert.deepEqual(body.account.windows, [])
  assert.equal(body.usage, null)
  assert.equal(body.pollMs, 1500)
})

test('session usage is returned only for an existing DSH session', async () => {
  const f = fixture()
  f.ledger.record('session-1', 'run-1', { type: 'statistics', usage: { inputTokens: 9, outputTokens: 3 }, costUsd: 0.02, model: 'opus', effort: 'high', success: true }, '')
  const body = await (await f.call('GET', '?sessionId=session-1')).json()
  assert.equal(body.usage.totals.inputTokens, 9)
  assert.equal(body.aggregate.sessions, 1)
  assert.equal((await f.call('GET', '?sessionId=missing')).status, 404)
  assert.equal((await f.call('GET', `?sessionId=${'x'.repeat(300)}`)).status, 404)
})

test('refresh persists the discovered catalog and account windows', async () => {
  let probed = 0
  const f = fixture({
    probe: async () => { probed += 1; return { models, version: '2.1.311', usage } },
  })
  const response = await f.call('POST', '?action=refresh')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(probed, 1)
  assert.equal(body.version, '2.1.311')
  assert.deepEqual(body.models.map(row => row.id), ['opus', 'claude-opus-5-5', 'sonnet', 'haiku', 'fable'])
  assert.equal(body.account.available, true)
  assert.deepEqual(body.account.windows.map(row => row.id), ['five_hour', 'seven_day'])
  assert.equal(body.account.windows[0].utilization, 12)
  assert.equal(f.updates.length, 1)
  assert.equal(f.updates[0][2], 3)
  assert.equal(JSON.parse(f.updates[0][1].modelCatalog)[0].id, 'opus')
})

test('refresh failures are classified and never echo the raw SSH error', async () => {
  const f = fixture({ probe: async () => { throw new Error('ssh auth failure for user workspace') } })
  const response = await f.call('POST', '?action=refresh')
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.equal(body.code, 'AUTH_FAILED')
  assert.ok(body.hint)
  assert.equal(JSON.stringify(body).includes('ssh auth failure'), false)
  assert.equal(f.updates.length, 0)
})

test('a connection edited during refresh is rejected instead of persisting a stale catalog', async () => {
  const f = fixture({
    probe: async () => { f.config.host = 'other.test'; return { models, version: '2.1.311', usage } },
  })
  const response = await f.call('POST', '?action=refresh')
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'CONNECTION_CHANGED')
  assert.equal(f.updates.length, 0)
})

test('concurrent refreshes are serialized', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture({ probe: async () => { await gate; return { models, version: '2.1.311', usage } } })
  const first = f.call('POST', '?action=refresh')
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = await f.call('POST', '?action=refresh')
  assert.equal(second.status, 409)
  assert.equal((await second.json()).code, 'REFRESH_IN_PROGRESS')
  release()
  assert.equal((await first).status, 200)
})

test('unsupported methods and actions are rejected', async () => {
  const f = fixture()
  assert.equal((await f.call('DELETE')).status, 405)
  const unknown = await f.call('POST', '?action=other')
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).code, 'UNKNOWN_ACTION')
})

test('test action reports prerequisites and the observed fingerprint', async () => {
  const health = [
    'bash=/bin/bash',
    'setsid=/usr/bin/setsid',
    'tail=/usr/bin/tail',
    'tailver=tail (GNU coreutils) 9.1',
    'claude=/usr/local/bin/claude',
  ].join('\n')
  const observed = `SHA256:${'b'.repeat(43)}`
  const createSsh = () => ({
    observedFingerprint: observed,
    async connect() {},
    async exec() { return { code: 0, stdout: health, stderr: '' } },
    async testForward() { return 52345 },
    async openExec() { throw new Error('probe unavailable in this fixture') },
    async dispose() {},
  })
  const f = fixture({ createSsh })
  const response = await f.call('POST', '?action=test')
  assert.equal(response.status, 200)
  const body = await response.json()
  const ids = body.checks.map(check => check.id)
  for (const id of ['ssh', 'bash', 'setsid', 'tail', 'claude', 'forward', 'claude_probe']) assert.ok(ids.includes(id), id)
  assert.equal(body.checks.find(check => check.id === 'forward').ok, true)
  assert.equal(body.checks.find(check => check.id === 'claude').ok, true)
  assert.equal(body.checks.find(check => check.id === 'claude_probe').ok, false)
  assert.equal(body.observedFingerprint, observed)
})

test('cleanup action forwards to the manager and reports removed run dirs', async () => {
  const f = fixture()
  let called = 0
  f.manager.cleanupRemoteRuns = async () => { called += 1; return { reaped: 0, removed: 2 } }
  const response = await f.call('POST', '?action=cleanup')
  assert.equal(response.status, 200)
  assert.equal(called, 1)
  assert.deepEqual(await response.json(), { available: true, ok: true, reaped: 0, removed: 2 })
})
