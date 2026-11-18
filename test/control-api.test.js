import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivityHandler } from '../lib/control-api.js'
import { ActivityLog } from '../lib/activity.js'

function fixture({ activityPanel = true, exists = id => id === 'session-1', activity, pause, stopSession } = {}) {
  const config = { activityPanel, activityPollMs: 1500 }
  const ctx = { agents: { get: id => exists(id) ? { id } : undefined } }
  const log = activity ?? new ActivityLog()
  log.beginTurn({ model: 'claude-opus-5-5', effort: 'high' })
  const calls = []
  const manager = {
    activityFor: id => (id === 'session-1' ? log : undefined),
    async pause(id) { calls.push(['pause', id]); if (pause) return pause(); return log.snapshot() },
    async stopSession(id) { calls.push(['stop', id]); if (stopSession) return stopSession(); log.setState('stopped'); return log.snapshot() },
    ledger: { get: id => ({ sessionId: id, turns: 2, costUsd: 0.5, inputTokens: 40, outputTokens: 10 }), latestRateLimit: () => ({ id: 'five_hour', utilization: 42 }) },
  }
  const handler = createActivityHandler(ctx, config, manager)
  const call = (method, query = '', body) => handler(new Request(`http://127.0.0.1:20263/api/remote-claude/activity${query}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }))
  return { call, calls, log, manager }
}

test('GET returns the live snapshot and ledger usage for one DSH session', async () => {
  const f = fixture()
  const response = await f.call('GET', '?sessionId=session-1')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.available, true)
  assert.equal(body.activity.state, 'preparing')
  assert.equal(body.activity.model, 'claude-opus-5-5')
  assert.equal(body.usage.costUsd, 0.5)
  assert.equal(body.pollMs, 1500)
  assert.equal(body.rateLimit.utilization, 42)
})

test('GET without a session, for an unknown session, or for a session with no remote turn is explicit', async () => {
  const f = fixture()
  assert.equal((await f.call('GET')).status, 400)
  assert.equal((await f.call('GET', '?sessionId=other')).status, 404)
  assert.equal((await f.call('GET', `?sessionId=${'x'.repeat(300)}`)).status, 404)
  assert.deepEqual(await (await f.call('GET', '?sessionId=session-1')).json().then(body => body.available), true)
  f.manager = undefined
  const g = fixture()
  const body = await (await g.call('GET', '?sessionId=session-1')).json()
  assert.equal(body.available, true)
})

test('a session without an activity log answers available:false', async () => {
  const log = new ActivityLog()
  const f = fixture({ activity: log })
  f.manager.activityFor = () => undefined
  const body = await (await f.call('GET', '?sessionId=session-1')).json()
  assert.equal(body.available, false)
  assert.equal(body.sessionId, 'session-1')
})

test('POST pause and stop drive the manager and return the new snapshot', async () => {
  const f = fixture()
  const paused = await (await f.call('POST', '', { sessionId: 'session-1', action: 'pause' })).json()
  assert.equal(paused.available, true)
  assert.deepEqual(f.calls[0], ['pause', 'session-1'])
  const stopped = await (await f.call('POST', '', { sessionId: 'session-1', action: 'stop' })).json()
  assert.equal(stopped.activity.state, 'stopped')
  assert.deepEqual(f.calls[1], ['stop', 'session-1'])
})

test('control failures and bad input map to stable codes', async () => {
  const notRunning = () => { const error = new Error('nope'); error.code = 'NOT_RUNNING'; throw error }
  const f = fixture({ pause: notRunning })
  assert.equal((await f.call('POST', '', { sessionId: 'session-1', action: 'pause' })).status, 409)
  assert.equal((await f.call('POST', '', { sessionId: 'session-1', action: 'explode' })).status, 400)
  assert.equal((await f.call('POST', '', { sessionId: 'other', action: 'pause' })).status, 404)
  assert.equal((await f.call('POST', '', undefined)).status, 400)
  assert.equal((await f.call('DELETE', '?sessionId=session-1')).status, 405)
})

test('the panel can be switched off without breaking the route', async () => {
  const f = fixture({ activityPanel: false })
  const body = await (await f.call('GET', '?sessionId=session-1')).json()
  assert.deepEqual(body, { available: false, reason: 'DISABLED' })
})
