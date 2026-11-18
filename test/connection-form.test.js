import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createConnectionHandler } from '../lib/config-api.js'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let entry
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value } } } })
const { createConnectionApi } = entry.factory(() => ({}))
const patch = { host: 'example.test', port: 22, username: 'workspace', knownHostFingerprint: `SHA256:${'a'.repeat(43)}`, claudePath: '/home/workspace/.local/bin/claude', claudeModel: 'sonnet', passwordRef: 'DSH_REMOTE_CLAUDE_SSH_PASSWORD', privateKeyPath: '', agent: '' }

function fixture(configured = true) {
  const calls = []
  let secret = configured ? 'old-test-secret' : undefined
  let row = { ns: 'remote-claude-host', revision: 7, value: { ...patch } }
  const ctx = {
    settings: {
      describe(options) { assert.equal(options.redactSecrets, true); return [row] },
      async update(ns, value, revision) {
        calls.push(['update', ns, value, revision])
        assert.equal(ns, row.ns)
        assert.equal(revision, row.revision)
        row = { ...row, revision: revision + 1, value: { ...row.value, ...value } }
      },
    },
    credentials: {
      async set(ref, password) { calls.push(['set', ref]); secret = password },
      async resolve(ref) { calls.push(['resolve', ref]); return secret ? { value: secret, source: 'test' } : undefined },
    },
  }
  const handler = createConnectionHandler(ctx, async ({ reconnect }) => { calls.push(['afterSave', reconnect]) })
  const fetcher = async (path, options) => {
    assert.equal(path, '/api/remote-claude/connection')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.redirect, 'error')
    return handler(new Request(`http://127.0.0.1:20263${path}`, options))
  }
  return { ctx, calls, handler, api: createConnectionApi(fetcher), secret: () => secret }
}

test('real Client API and Host handler persist credentials separately with namespace and CAS', async () => {
  const f = fixture()
  const result = await f.api.save(patch, 'new-test-secret', 7)
  assert.equal(f.secret(), 'new-test-secret')
  assert.deepEqual(f.calls.map(call => call[0]), ['set', 'resolve', 'update', 'afterSave', 'resolve'])
  assert.deepEqual(f.calls.find(call => call[0] === 'afterSave'), ['afterSave', true])
  assert.equal(f.calls.find(call => call[0] === 'update')[3], 7)
  assert.equal(result.revision, 8)
  assert.equal(result.credentialConfigured, true)
  assert.equal(JSON.stringify(result).includes('new-test-secret'), false)
  assert.equal(JSON.stringify(f.calls).includes('new-test-secret'), false)
})

test('connection GET describes availability without returning the stored password', async () => {
  const f = fixture()
  const result = await f.api.read()
  assert.equal(result.revision, 7)
  assert.equal(result.value.host, patch.host)
  assert.equal(JSON.stringify(result).includes('old-test-secret'), false)
})

test('missing credentials prevent writing connection settings', async () => {
  const f = fixture(false)
  await assert.rejects(f.api.save(patch, '', 7), /CREDENTIAL_NOT_CONFIGURED/)
  assert.equal(f.calls.some(call => call[0] === 'update'), false)
})

test('mixed authentication is rejected before any credential mutation', async () => {
  const f = fixture()
  await assert.rejects(f.api.save({ ...patch, privateKeyPath: 'id_ed25519' }, 'new-test-secret', 7), /INVALID_CONNECTION/)
  assert.equal(f.calls.length, 0)
})

test('stale revision is rejected before rotating the password', async () => {
  const f = fixture()
  await assert.rejects(f.api.save(patch, 'new-test-secret', 6), /SETTINGS_CONFLICT/)
  assert.equal(f.secret(), 'old-test-secret')
  assert.equal(f.calls.length, 0)
})

test('key authentication does not access password credentials', async () => {
  const f = fixture()
  await f.api.save({ ...patch, passwordRef: '', privateKeyPath: 'id_ed25519' }, '', 7)
  assert.deepEqual(f.calls.map(call => call[0]), ['update', 'afterSave'])
  assert.deepEqual(f.calls.at(-1), ['afterSave', true])
})

test('saving display settings does not ask the manager to recycle warm sessions', async () => {
  const f = fixture()
  await f.api.save({ ...patch, showThinking: false, activityPollMs: 2500 }, '', 7)
  assert.deepEqual(f.calls.find(call => call[0] === 'afterSave'), ['afterSave', false])
})

test('unknown fields cannot mutate unrelated settings or credentials', async () => {
  const f = fixture()
  await assert.rejects(f.api.save({ ...patch, arbitrarySecret: 'test-only' }, '', 7), /INVALID_CONNECTION/)
  assert.equal(f.calls.length, 0)
})

test('provider error messages containing secrets never enter a response', async () => {
  const f = fixture()
  f.ctx.credentials.set = async () => { throw new Error('do not disclose test-only-secret') }
  await assert.rejects(f.api.save(patch, 'test-only-secret', 7), error => {
    assert.equal(error.message, 'CONNECTION_SAVE_FAILED')
    return true
  })
})
