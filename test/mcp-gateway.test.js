import assert from 'node:assert/strict'
import test from 'node:test'
import { McpGateway, toolLogOf } from '../lib/mcp-gateway.js'
import { ActivityLog } from '../lib/activity.js'

function request(url, token, method, params, id = 1) {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

test('exposes only the DSH turn allowlist and executes through the bound agent', async (t) => {
  const calls = []
  const agent = { id: 'session-1' }
  const ctx = {
    agents: { withInitiator(bound, operation) { assert.equal(bound, agent); return operation() } },
    tools: {
      async execute(input) {
        calls.push(input)
        return {
          results: [{ callId: input.calls[0].id, result: { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'done' }] } }],
          additionalContexts: [], concluded: false,
        }
      },
    },
  }
  const gateway = new McpGateway(ctx, { token: 'test-token' })
  t.after(() => gateway.close())
  const address = await gateway.listen()
  const url = `http://${address.host}:${address.port}/mcp`
  gateway.setTurnContext({
    agent,
    signal: new AbortController().signal,
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })

  const unauthorized = await fetch(url, { method: 'POST', body: '{}' })
  assert.equal(unauthorized.status, 401)

  const listed = await (await request(url, 'test-token', 'tools/list')).json()
  assert.deepEqual(listed.result.tools, [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }])

  const called = await (await request(url, 'test-token', 'tools/call', { name: 'read', arguments: { path: 'a.txt' } })).json()
  assert.deepEqual(called.result, { isError: false, content: [{ type: 'text', text: 'done' }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, agent)
  assert.equal(calls[0].calls[0].name, 'read')
  assert.equal(calls[0].calls[0].arguments, '{"path":"a.txt"}')

  const denied = await (await request(url, 'test-token', 'tools/call', { name: 'write', arguments: {} }, 2)).json()
  assert.equal(denied.error.code, -32602)
})

test('logs tool calls into the DSH session step and admits conditional tools', async (t) => {
  const seen = []
  let disposed = 0
  let resolved = 0
  const toolSet = { dispose() { disposed += 1 }, view: () => new Map() }
  const agent = {
    id: 'session-1',
    phase: { kind: 'running', turn: 2, step: 3 },
    model: { current: () => ({ provider: 'deepseek', model: 'chat' }) },
  }
  const ctx = {
    agents: { withInitiator: (bound, operation) => { assert.equal(bound, agent); return operation() } },
    tools: {
      async resolve(input) {
        resolved += 1
        assert.equal(input.agent, agent)
        assert.deepEqual(input.modelSelection, { provider: 'deepseek', model: 'chat' })
        return toolSet
      },
      async execute(input) {
        seen.push(input)
        return {
          results: [{ callId: input.calls[0].id, result: { isError: false, value: {}, content: [{ type: 'text', text: 'ok' }] } }],
          additionalContexts: [], concluded: false,
        }
      },
    },
  }
  const gateway = new McpGateway(ctx, { token: 'log-token' })
  t.after(() => gateway.close())
  const address = await gateway.listen()
  const url = `http://${address.host}:${address.port}/mcp`
  const turnContext = {
    agent,
    signal: new AbortController().signal,
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' }, readOnly: true }],
  }
  gateway.setTurnContext(turnContext)
  await request(url, 'log-token', 'tools/call', { name: 'read', arguments: { path: 'a' } })
  await request(url, 'log-token', 'tools/call', { name: 'read', arguments: { path: 'b' } }, 2)
  assert.equal(resolved, 1, 'the step admission is resolved once and reused')
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0].log, { turn: 2, step: 3 })
  assert.equal(seen[0].toolSet, toolSet)
  gateway.clearTurnContext(turnContext)
  assert.equal(disposed, 1)
})

test('falls back to the last step/start event when the agent phase is absent', () => {
  assert.deepEqual(toolLogOf({ session: { log: [
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'step/start', data: { turn: 4, step: 2 } },
  ] } }), { turn: 4, step: 2 })
  assert.equal(toolLogOf({}), undefined)
})

test('passes image blocks through and records tool activity', async (t) => {
  const log = new ActivityLog()
  log.beginTurn({})
  const ctx = {
    agents: { withInitiator: (bound, operation) => operation() },
    tools: {
      async execute(input) {
        return {
          results: [{
            callId: input.calls[0].id,
            result: { isError: false, value: { ok: true }, content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] },
          }],
          additionalContexts: [], concluded: false,
        }
      },
    },
  }
  const gateway = new McpGateway(ctx, { token: 'image-token', activity: log })
  t.after(() => gateway.close())
  const address = await gateway.listen()
  const url = `http://${address.host}:${address.port}/mcp`
  gateway.setTurnContext({
    agent: { id: 'session-1' },
    signal: new AbortController().signal,
    tools: [{ name: 'screenshot', description: 'Capture', parameters: { type: 'object' }, readOnly: true }],
  })
  const called = await (await request(url, 'image-token', 'tools/call', { name: 'screenshot', arguments: {} })).json()
  assert.deepEqual(called.result, { isError: false, content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] })
  assert.equal(log.entries.filter(entry => entry.kind === 'tool').length, 1)
  assert.equal(log.snapshot().tool, undefined)
})
