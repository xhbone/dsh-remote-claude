import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { RemoteClaudeManager } from '../lib/manager.js'
import { RemoteClaudeSession } from '../lib/remote-session.js'
import { SshClient } from '../lib/ssh-client.js'
import { NdjsonCursorParser } from '../lib/ndjson-cursor.js'

const config = { idleSessionMs: 1800000, claudeModel: 'sonnet', remoteBaseDir: '.dsh-remote-claude', claudePath: 'claude', restrictedMode: true }
const options = { sessionId: 'session-1', model: 'claude-code-agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
const collect = async (iterator) => { const result = []; for await (const item of iterator) result.push(item); return result }

function fakeManager() {
  const sessions = []
  const manager = new RemoteClaudeManager({ agents: { get: () => ({ id: 'session-1' }) } }, config, {
    createSession(identity) {
      const session = { ...identity, hasTurn: false, disposed: 0, lastUsedAt: Date.now(), async dispose() { this.disposed++ }, async *turn() { yield { type: 'text', text: 'hello' }; this.hasTurn = true } }
      sessions.push(session)
      return session
    },
  })
  return { manager, sessions }
}

test('a concurrent request cannot dispose another active turn', async (t) => {
  const { manager, sessions } = fakeManager()
  t.after(() => manager.dispose())
  const first = manager.stream(options)
  await first.next()
  await assert.rejects(() => manager.stream(options).next(), /already active/)
  assert.equal(sessions[0].disposed, 0)
  assert.equal((await first.next()).done, true)
  assert.equal(sessions[0].disposed, 0)
})

test('auxiliary purposes use independent remote conversations', async (t) => {
  const { manager, sessions } = fakeManager()
  t.after(() => manager.dispose())
  await collect(manager.stream({ ...options, purpose: 'main' }))
  await collect(manager.stream({ ...options, purpose: 'title' }))
  assert.equal(sessions.length, 2)
  await collect(manager.stream({ ...options, purpose: 'main' }))
  assert.equal(sessions.length, 2)
})

test('consumer return disposes an unfinished remote turn', async (t) => {
  const { manager, sessions } = fakeManager()
  t.after(() => manager.dispose())
  const stream = manager.stream(options)
  await stream.next()
  await stream.return()
  assert.equal(sessions[0].disposed, 1)
  assert.equal(manager.sessions.size, 0)
})

test('complete oversized NDJSON lines are rejected', () => {
  const parser = new NdjsonCursorParser({ maxLineBytes: 8 })
  assert.throws(() => parser.push(Buffer.from('{"long":12345}\n')), /exceeded/)
})

function fakeRemote(outputs) {
  const inputs = []
  const commands = []
  const ssh = {
    ready: true,
    async connect() {}, async reverseForward() { return { remotePort: 1234 } },
    async exec(command, details) { commands.push(command); if (details?.input) inputs.push(details.input); return { code: 0, stdout: '', stderr: '' } },
    async openExec(command) {
      commands.push(command)
      const stream = new PassThrough()
      stream.close = () => stream.destroy()
      stream.end(outputs.shift() ?? '')
      return stream
    },
    async dispose() {},
  }
  const gateway = { address: { port: 4321 }, token: 'test-token', async listen() {}, setTurnContext() {}, clearTurnContext() {}, async close() {} }
  const session = new RemoteClaudeSession({}, config, { dshSessionId: 'session-1', model: 'sonnet' }, { ssh, gateway })
  return { session, inputs, commands }
}

test('turn cursor commits only consumed result and stdin contains an actual LF', async (t) => {
  const result = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })}\n`
  const exit = `${JSON.stringify({ type: 'bridge_exit', code: 0 })}\n`
  const { session, inputs, commands } = fakeRemote([result + exit, exit])
  t.after(() => session.dispose())
  const turn = { prompt: '你好', system: 'test system', tools: [], agent: { id: 'session-1' } }
  assert.deepEqual(await collect(session.turn(turn)), [{ type: 'text', text: 'done' }])
  assert.equal(session.offset, Buffer.byteLength(result))
  assert.equal(inputs[1].at(-1), '\n')
  assert.equal(JSON.parse(inputs[1]).type, 'user')
  await assert.rejects(() => collect(session.turn(turn)), /exited/)
  assert.ok(commands.some((command) => command.includes(`-c +${Buffer.byteLength(result) + 1}`)))
})

test('projects subagent text into the main reply', async (t) => {
  const subagent = `${JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_child', message: { role: 'assistant', content: [{ type: 'text', text: 'child says hi' }] } })}\n`
  const result = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'final' })}\n`
  const exit = `${JSON.stringify({ type: 'bridge_exit', code: 0 })}\n`
  const { session } = fakeRemote([subagent + result + exit])
  t.after(() => session.dispose())
  const chunks = await collect(session.turn({ prompt: '你好', system: 'test system', tools: [], agent: { id: 'session-1' } }))
  const text = chunks.filter(chunk => chunk.type === 'text').map(chunk => chunk.text).join('')
  assert.match(text, /子代理输出/)
  assert.match(text, /> child says hi/)
})

test('rejects a remote protocol version below the verified minimum', async (t) => {
  const init = `${JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', claude_code_version: '2.0.9' })}\n`
  const result = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })}\n`
  const exit = `${JSON.stringify({ type: 'bridge_exit', code: 0 })}\n`
  const { session } = fakeRemote([init + result + exit])
  t.after(() => session.dispose())
  await assert.rejects(
    () => collect(session.turn({ prompt: '你好', system: 'test system', tools: [], agent: { id: 'session-1' } })),
    /2\.0\.9|CLAUDE_VERSION_UNSUPPORTED/,
  )
})

test('abort closes a blocked output stream and clears authorization', async (t) => {
  const { session } = fakeRemote([])
  let cleared = 0
  let attached
  const ready = new Promise((resolve) => { attached = resolve })
  session.gateway.clearTurnContext = () => { cleared++ }
  session.ssh.openExec = async () => {
    const stream = new PassThrough()
    stream.close = () => stream.destroy()
    attached()
    return stream
  }
  t.after(() => session.dispose())
  const controller = new AbortController()
  const pending = collect(session.turn({ prompt: 'test', tools: [], agent: {}, signal: controller.signal }))
  await ready
  controller.abort(new Error('stop test'))
  await assert.rejects(() => pending, /stop test/)
  assert.ok(cleared > 0)
  assert.equal(session.busy, false)
})

test('SSH exec never reports success without an exit status', async () => {
  const ssh = new SshClient({ connectTimeoutMs: 1000 })
  ssh.openExec = async () => {
    const channel = new PassThrough()
    channel.stderr = new PassThrough()
    channel.close = () => channel.destroy()
    setImmediate(() => channel.emit('close'))
    return channel
  }
  assert.equal((await ssh.exec('test')).code, -1)
})

test('a channel delivered after cancellation is closed', async () => {
  const ssh = new SshClient({})
  ssh.ready = true
  let callback
  ssh.client = { exec(command, done) { callback = done } }
  const controller = new AbortController()
  const pending = ssh.openExec('test', { signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await assert.rejects(() => pending, /cancelled/)
  let closed = false
  callback(null, { close() { closed = true } })
  assert.equal(closed, true)
})

test('reasoning effort is carried into the session and a change rebuilds it', async (t) => {
  const sessions = []
  const catalog = [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }]
  const manager = new RemoteClaudeManager({ agents: { get: () => ({ id: 'session-1' }) } },
    { ...config, modelCatalog: JSON.stringify(catalog), reasoningEffort: 'default' }, {
      createSession(identity) {
        const session = { ...identity, hasTurn: false, disposed: 0, lastUsedAt: Date.now(), async dispose() { this.disposed++ }, async *turn() { yield { type: 'text', text: 'hello' }; this.hasTurn = true } }
        sessions.push(session)
        return session
      },
    })
  t.after(() => manager.dispose())
  await collect(manager.stream({ ...options, reasoningEffort: 'high' }))
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].reasoningEffort, 'high')
  assert.equal(sessions[0].model, 'sonnet')
  await collect(manager.stream({ ...options, reasoningEffort: 'high' }))
  assert.equal(sessions.length, 1)
  await collect(manager.stream({ ...options, reasoningEffort: 'low' }))
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].disposed, 1)
  assert.equal(sessions[1].reasoningEffort, 'low')
  await assert.rejects(() => manager.stream({ ...options, reasoningEffort: 'ultracode' }).next(), /does not advertise effort/)
})
