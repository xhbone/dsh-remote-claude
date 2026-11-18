import assert from 'node:assert/strict'
import test from 'node:test'
import { McpGateway } from '../lib/mcp-gateway.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function setup(t, execute) {
  const gateway = new McpGateway({ agents: { withInitiator(agent, operation) { return operation() } }, tools: { execute } }, { token: 'test-token' })
  t.after(() => gateway.close())
  const { port } = await gateway.listen()
  const context = { tools: [{ name: 'read', parameters: { type: 'object' } }], agent: { id: 'test-session' } }
  gateway.setTurnContext(context)
  return {
    gateway, context,
    async rpc(method, params, id) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }),
      })
      return response.json()
    },
  }
}

function success(input) {
  assert.match(input.callId, /^remote-claude-/)
  return { isError: false, value: 'done', content: [{ type: 'text', text: 'done' }] }
}

test('notification tools/call cannot execute and errors preserve request ids', async (t) => {
  let executed = 0
  const { rpc } = await setup(t, async (input) => { executed++; return success(input) })
  assert.equal((await rpc('tools/call', { name: 'read' })).error.code, -32600)
  assert.equal(executed, 0)
  const rejected = await rpc('tools/call', { name: 'write' }, 'denied-id')
  assert.equal(rejected.id, 'denied-id')
  assert.equal(rejected.error.code, -32602)
})

test('independent HTTP calls execute serially', async (t) => {
  const firstStarted = deferred()
  const releaseFirst = deferred()
  let executing = 0
  let maxExecuting = 0
  let count = 0
  const { rpc } = await setup(t, async (input) => {
    count++
    executing++
    maxExecuting = Math.max(maxExecuting, executing)
    if (count === 1) { firstStarted.resolve(); await releaseFirst.promise }
    executing--
    return success(input)
  })
  const first = rpc('tools/call', { name: 'read' }, 1)
  await firstStarted.promise
  const second = rpc('tools/call', { name: 'read' }, 2)
  // A separate ping proves the HTTP server remains available while a tool waits.
  await rpc('ping', {}, 3)
  releaseFirst.resolve()
  const results = await Promise.all([first, second])
  assert.ok(results.every((result) => !result.error))
  assert.equal(count, 2)
  assert.equal(maxExecuting, 1)
})

test('revoking the turn aborts in-flight authorization and blocks queued calls', async (t) => {
  const firstStarted = deferred()
  const aborted = deferred()
  let executed = 0
  const { rpc, gateway, context } = await setup(t, async (input) => {
    executed++
    firstStarted.resolve()
    await new Promise((resolve) => input.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
    return success(input)
  })
  const first = rpc('tools/call', { name: 'read' }, 1)
  await firstStarted.promise
  const second = rpc('tools/call', { name: 'read' }, 2)
  await rpc('ping', {}, 3)
  gateway.clearTurnContext(context)
  await aborted.promise
  await first
  const denied = await second
  assert.equal(executed, 1)
  assert.ok(denied.error)
})
