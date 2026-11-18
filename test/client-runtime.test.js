import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createRuntimeHandler } from '../lib/runtime-api.js'
import { UsageLedger } from '../lib/statistics.js'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let entry
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value } } }, URLSearchParams })
const { createRuntimeApi } = entry.factory(() => ({}))

const usage = {
  subscription_type: 'pro',
  rate_limits: { five_hour: { utilization: 11, resets_at: '2026-11-17T05:30:00+00:00' } },
}

function fixture({ probe } = {}) {
  let row = { ns: 'remote-claude-host', revision: 2, value: { claudeModel: 'sonnet' } }
  const config = { host: 'vps.test', port: 22, username: 'workspace', claudePath: 'claude', knownHostFingerprint: `SHA256:${'a'.repeat(43)}`, modelCatalog: '[]', customModels: '' }
  const ctx = {
    agents: { get: () => ({ id: 'session-1' }) },
    settings: { describe: () => [row], async update(ns, value, revision) { row = { ...row, revision: revision + 1, value: { ...row.value, ...value } } } },
  }
  const manager = { ledger: new UsageLedger(), cleanupRemoteRuns: async () => ({ reaped: 0, removed: 0 }) }
  const handler = createRuntimeHandler(ctx, config, manager, probe ? { probe } : {})
  const seen = []
  const fetcher = async (path, options) => {
    seen.push([path, options.method, options.credentials, options.cache])
    return handler(new Request(`http://127.0.0.1:20263${path}`, { method: options.method, credentials: options.credentials, cache: options.cache }))
  }
  return { api: createRuntimeApi(fetcher), seen }
}

test('runtime Client API reads the snapshot from the same-origin route', async () => {
  const f = fixture()
  const snapshot = await f.api.read()
  assert.equal(f.seen[0][0], '/api/remote-claude/runtime')
  assert.equal(f.seen[0][1], 'GET')
  assert.equal(f.seen[0][2], 'same-origin')
  assert.equal(f.seen[0][3], 'no-store')
  assert.equal(snapshot.available, true)
  assert.ok(snapshot.models.some(row => row.id === 'sonnet'))
  assert.deepEqual(snapshot.efforts.map(row => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(snapshot.account.available, false)
})

test('runtime Client API refreshes and exposes the discovered catalog', async () => {
  const f = fixture({ probe: async () => ({ models: [{ id: 'fable', name: 'Fable 5.1', resolvedModel: 'claude-fable-5-1', efforts: ['low', 'high'] }], version: '2.1.311', usage }) })
  const snapshot = await f.api.refresh()
  assert.equal(f.seen[0][0], '/api/remote-claude/runtime?action=refresh')
  assert.equal(f.seen[0][1], 'POST')
  assert.equal(snapshot.version, '2.1.311')
  assert.ok(snapshot.models.some(row => row.id === 'claude-fable-5-1'))
  assert.equal(snapshot.account.windows[0].utilization, 11)
})

test('runtime failures keep their machine code for the form to translate', async () => {
  const f = fixture({ probe: async () => { throw new Error('private ssh detail') } })
  await assert.rejects(f.api.refresh(), error => error.code === 'REFRESH_FAILED' && !error.message.includes('private ssh detail'))
})
