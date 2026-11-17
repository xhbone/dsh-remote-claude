import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { SshClient, sha256Fingerprint } from '../lib/ssh-client.js'

const key = Buffer.from('mock SSH host key')
const config = {
  host: 'test.invalid', port: 22, username: 'test', connectTimeoutMs: 1000,
  passwordRef: 'DSH_REMOTE_CLAUDE_SSH_PASSWORD',
  knownHostFingerprint: sha256Fingerprint(key),
}

function makeTransport() {
  const clients = []
  const createClient = () => {
    const client = new EventEmitter()
    client.authenticated = false
    client.connect = (options) => {
      client.options = options
      queueMicrotask(() => {
        if (options.hostVerifier(key)) {
          client.authenticated = true
          client.emit('ready')
        } else client.emit('error', new Error('Host denied'))
      })
    }
    client.end = () => client.emit('close')
    clients.push(client)
    return client
  }
  return { clients, createClient }
}

test('password references are re-resolved for each SSH connection', async () => {
  const { clients, createClient } = makeTransport()
  let reads = 0
  const ssh = new SshClient(config, {
    createClient,
    resolvePassword: async (ref) => {
      assert.equal(ref, config.passwordRef)
      return `mock-rotated-value-${++reads}`
    },
  })
  try {
    await ssh.connect()
    await ssh.connect()
    assert.equal(reads, 1)
    assert.equal(clients[0].options.password, 'mock-rotated-value-1')
    assert.equal(Object.hasOwn(ssh.config, 'password'), false)
    await ssh.dispose()
    await ssh.connect()
    assert.equal(reads, 2)
    assert.equal(clients[1].options.password, 'mock-rotated-value-2')
  } finally {
    await ssh.dispose()
  }
})

test('an unset password fails before opening an SSH transport', async () => {
  const { clients, createClient } = makeTransport()
  const ssh = new SshClient(config, { createClient, resolvePassword: async () => undefined })
  await assert.rejects(() => ssh.connect(), /SSH password credential is not configured/)
  assert.equal(clients.length, 0)
})

test('password authentication still refuses an untrusted host key', async () => {
  const { clients, createClient } = makeTransport()
  const ssh = new SshClient({ ...config, knownHostFingerprint: sha256Fingerprint(Buffer.from('different key')) }, {
    createClient, resolvePassword: async () => 'mock-secret',
  })
  try {
    await assert.rejects(() => ssh.connect(), /SSH host fingerprint mismatch/)
    assert.equal(clients[0].authenticated, false)
  } finally {
    await ssh.dispose()
  }
})

test('invalid reference names and ambiguous authentication fail before resolution', async () => {
  let reads = 0
  const resolvePassword = async () => { reads++; return 'mock-secret' }
  for (const override of [{ passwordRef: 'not a reference' }, { privateKeyPath: 'unused-key' }, { agent: 'unused-agent' }, { knownHostFingerprint: '' }]) {
    const ssh = new SshClient({ ...config, ...override }, { resolvePassword })
    await assert.rejects(() => ssh.connect())
  }
  assert.equal(reads, 0)
})

test('cancelling a pending credential resolution never opens a connection', async () => {
  const { clients, createClient } = makeTransport()
  let provide
  const pendingCredential = new Promise((resolve) => { provide = resolve })
  const ssh = new SshClient(config, { createClient, resolvePassword: () => pendingCredential })
  const controller = new AbortController()
  const connecting = ssh.connect(controller.signal)
  controller.abort(new Error('password lookup cancelled'))
  provide('mock-secret')
  await assert.rejects(() => connecting, /password lookup cancelled/)
  assert.equal(clients.length, 0)
})
