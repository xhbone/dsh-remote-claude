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
        return { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'done' }] }
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
  assert.match(calls[0].callId, /^remote-claude-/)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(calls[0].arguments, { path: 'a.txt' })
  assert.equal('calls' in calls[0], false)
  assert.equal(calls[0].signal.aborted, false)

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
      selectExecutor() {},
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

test('shares pending admission across concurrent requests and rejects calls after the originating step closes', async (t) => {
  const admission = Promise.withResolvers()
  const pending = Promise.withResolvers()
  const executed = []
  let resolves = 0
  let disposed = 0
  const step = { turn: 2, step: 3 }
  const agent = { phase: { kind: 'running', ...step }, session: { log: [{ type: 'step/start', data: step }] } }
  const toolSet = { dispose() { disposed += 1 } }
  const gateway = new McpGateway({ tools: {
    selectExecutor() {},
    resolve() { resolves += 1; pending.resolve(); return admission.promise },
    async execute(input) {
      executed.push(input)
      return { results: [{ callId: input.calls[0].id, result: { content: [{ type: 'text', text: 'done' }] } }] }
    },
  } })
  t.after(() => { admission.resolve(toolSet); return gateway.close() })
  const address = await gateway.listen()
  const url = `http://${address.host}:${address.port}/mcp`
  gateway.setTurnContext({ agent, tools: [{ name: 'read', readOnly: true }] })
  const call = (id) => request(url, gateway.token, 'tools/call', { name: 'read' }, id).then(res => res.json())
  const responses = Promise.all([call(1), call(2)])
  await pending.promise
  const deadline = AbortSignal.timeout(2000)
  while (gateway.activeCalls < 2) {
    deadline.throwIfAborted()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(resolves, 1)
  agent.session.log.push({ type: 'step/end', data: step }, { type: 'step/start', data: { turn: 2, step: 4 } })
  admission.resolve(toolSet)
  for (const response of await responses) assert.equal(response.error.code, -32001)
  assert.equal((await call(3)).error.code, -32001)
  assert.deepEqual(executed, [])
  gateway.clearTurnContext()
  assert.equal(disposed, 1)
})

test('single calls log paired DSH events with raw content, error info and diff metadata', async (t) => {
  const step = { turn: 1, step: 2 }
  const events = [{ type: 'step/start', data: step }]
  const session = {
    log: events,
    append(type, data, options) {
      const event = { type, data, options, seq: events.length }
      events.push(event)
      return event
    },
  }
  const content = [{ type: 'image', attachment: { name: 'capture.png' } }]
  const meta = { diffs: [{ path: 'demo.txt', before: 'old', after: 'new' }] }
  const info = { name: 'ExampleError', message: 'failed' }
  const gateway = new McpGateway({ tools: {
    async execute(input) {
      assert.equal(events.at(-1).data.callId, input.callId)
      return { isError: true, content, meta, error: { message: 'failed', info } }
    },
  } })
  t.after(() => gateway.close())
  const { host, port } = await gateway.listen()
  gateway.setTurnContext({ agent: { session }, tools: [{ name: 'read' }] })
  const response = await (await request(`http://${host}:${port}/mcp`, gateway.token, 'tools/call', { name: 'read', arguments: { path: 'demo.txt' } })).json()
  assert.deepEqual(response.result, { isError: true, content: [{ type: 'text', text: '[image: capture.png]' }] })
  const [, call, result] = events
  assert.equal(events.length, 3)
  assert.equal(call.type, 'tool/call')
  assert.deepEqual(call.data, { ...step, callId: call.data.callId, name: 'read', arguments: '{"path":"demo.txt"}' })
  assert.equal(result.type, 'tool/result')
  assert.deepEqual(result.options, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  assert.equal(result.data.turn, step.turn)
  assert.equal(result.data.step, step.step)
  assert.equal(result.data.message.role, 'tool')
  assert.equal(result.data.message.toolCallId, call.data.callId)
  assert.deepEqual(result.data.message.content, content)
  assert.equal(result.data.message.isError, true)
  assert.deepEqual(result.data.meta, meta)
  assert.deepEqual(result.data.error, info)
})

test('single calls still execute exactly once when DSH cannot append either event', async (t) => {
  const step = { turn: 1, step: 2 }
  let executions = 0
  let failOn = 'tool/call'
  const attempted = []
  const agent = { session: {
    log: [{ type: 'step/start', data: step }],
    append(type) {
      attempted.push(type)
      if (type === failOn) throw new Error('storage unavailable')
      return { seq: 1 }
    },
  } }
  const gateway = new McpGateway({ tools: {
    async execute() {
      executions += 1
      return { isError: false, content: [{ type: 'text', text: 'done' }] }
    },
  } })
  t.after(() => gateway.close())
  const { host, port } = await gateway.listen()
  gateway.setTurnContext({ agent, tools: [{ name: 'read' }] })
  for (const event of ['tool/call', 'tool/result']) {
    failOn = event
    const response = await (await request(`http://${host}:${port}/mcp`, gateway.token, 'tools/call', { name: 'read' })).json()
    assert.deepEqual(response.result, { isError: false, content: [{ type: 'text', text: 'done' }] })
  }
  assert.deepEqual(attempted, ['tool/call', 'tool/call', 'tool/result'])
  assert.equal(executions, 2)
})

test('a malformed desktop batch response reports failure without replaying the call', async (t) => {
  const executions = []
  const gateway = new McpGateway({ tools: {
    selectExecutor() {},
    resolve() {},
    async execute(input) {
      executions.push(input)
      return { content: [] }
    },
  } })
  t.after(() => gateway.close())
  const { host, port } = await gateway.listen()
  gateway.setTurnContext({ tools: [{ name: 'write' }] })
  const response = await (await request(`http://${host}:${port}/mcp`, gateway.token, 'tools/call', { name: 'write' })).json()
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /no result/)
  assert.equal(executions.length, 1)
  assert.equal(executions[0].calls[0].name, 'write')
})

test('falls back to the last open step/start event when the agent phase is absent', () => {
  assert.deepEqual(toolLogOf({ session: { log: [
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'step/start', data: { turn: 4, step: 2 } },
  ] } }), { turn: 4, step: 2 })
  assert.equal(toolLogOf({}), undefined)
  const step = { turn: 4, step: 2 }
  assert.equal(toolLogOf({ phase: { kind: 'running', ...step }, session: { log: [
    { type: 'step/start', data: step }, { type: 'step/end', data: step },
  ] } }), undefined)
})

test('passes image blocks through and records tool activity', async (t) => {
  const log = new ActivityLog()
  log.beginTurn({})
  const ctx = {
    agents: { withInitiator: (bound, operation) => operation() },
    tools: {
      async execute() {
        return { isError: false, value: { ok: true }, content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
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
