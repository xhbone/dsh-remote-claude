import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { ActivityLog } from '../lib/activity.js'
import { createActivityHandler } from '../lib/control-api.js'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let entry
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value } } }, URLSearchParams })
const client = entry.factory(() => ({}))

function fixture() {
  const log = new ActivityLog()
  log.beginTurn({ model: 'claude-opus-5-5', effort: 'high' })
  const ctx = { agents: { get: id => (id === 'session-1' ? { id } : undefined) } }
  const manager = {
    activityFor: () => log,
    async pause() { log.setState('paused'); return log.snapshot() },
    async stopSession() { log.setState('stopped'); return log.snapshot() },
    ledger: { get: () => null },
  }
  const handler = createActivityHandler(ctx, { activityPanel: true }, manager)
  const seen = []
  const fetcher = async (path, options) => {
    seen.push([path, options.method, options.credentials, options.cache, options.body])
    return handler(new Request(`http://127.0.0.1:20263${path}`, {
      method: options.method,
      credentials: options.credentials,
      cache: options.cache,
      ...(options.body ? { headers: { 'content-type': 'application/json' }, body: options.body } : {}),
    }))
  }
  return { api: client.createActivityApi(fetcher), seen }
}

test('activity Client API reads the snapshot for the given session', async () => {
  const f = fixture()
  const snapshot = await f.api.read('session-1')
  assert.equal(f.seen[0][0], '/api/remote-claude/activity?sessionId=session-1')
  assert.equal(f.seen[0][1], 'GET')
  assert.equal(f.seen[0][2], 'same-origin')
  assert.equal(f.seen[0][3], 'no-store')
  assert.equal(snapshot.activity.state, 'preparing')
})

test('activity Client API posts pause and stop with the session id', async () => {
  const f = fixture()
  const paused = await f.api.pause('session-1')
  assert.equal(f.seen[0][0], '/api/remote-claude/activity')
  assert.equal(f.seen[0][1], 'POST')
  assert.deepEqual(JSON.parse(f.seen[0][4]), { sessionId: 'session-1', action: 'pause' })
  assert.equal(paused.activity.state, 'paused')
  const stopped = await f.api.stop('session-1')
  assert.deepEqual(JSON.parse(f.seen[1][4]), { sessionId: 'session-1', action: 'stop' })
  assert.equal(stopped.activity.state, 'stopped')
})

test('activity errors keep their machine code', async () => {
  const f = fixture()
  await assert.rejects(f.api.pause('missing'), error => error.code === 'SESSION_UNAVAILABLE')
})

test('the client registers the composer status strip next to the shipped entries', () => {
  const registrations = []
  const ctx = {
    slots: {
      inject(name, register) { registrations.push([name, register()]) },
      register(options) { return options },
    },
  }
  client.apply(ctx)
  const config = registrations.find(([name]) => name === 'plugins.bundle.config')
  const strip = registrations.find(([name]) => name === 'conversation.composer.dock')
  assert.equal(config[1].key, '@local/dsh-remote-claude')
  assert.equal(strip[1].id, 'remote-claude-activity')
  assert.equal(strip[1].order, 5)
})
