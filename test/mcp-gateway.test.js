import assert from 'node:assert/strict'
import test from 'node:test'
import { McpGateway } from '../lib/mcp-gateway.js'

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
