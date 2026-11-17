import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityLog } from '../lib/activity.js'
import { RemoteClaudeManager } from '../lib/manager.js'
import { RemoteClaudeSession } from '../lib/remote-session.js'

const config = {
  idleSessionMs: 1800000, claudeModel: 'sonnet', remoteBaseDir: '.dsh-remote-claude', claudePath: 'claude',
  restrictedMode: true, pauseTimeoutMs: 8000, cancelBehavior: 'stop', showThinking: true,
}
const identity = { dshSessionId: 'session-1', model: 'claude-opus-5-5', reasoningEffort: 'high', purpose: '', activity: new ActivityLog() }
const collect = async (iterator) => { const result = []; for await (const item of iterator) result.push(item); return result }

function sessionFixture(overrides = {}) {
  const writes = []
  const ssh = {
    ready: true,
    async exec(command, options) { writes.push({ command, input: options?.input }); return { code: 0, stdout: '', stderr: '' } },
    async dispose() {},
  }
  const gateway = { setTurnContext() {}, clearTurnContext() {}, async close() {} }
  const session = new RemoteClaudeSession({ get: () => undefined }, { ...config, ...overrides }, {
    ...identity, activity: new ActivityLog(),
  }, { ssh, gateway })
  session.busy = true
  session.turnOpen = true
  session.started = true
  session.turnAbort = new AbortController()
  return { session, writes }
}

test('pause sends an interrupt control frame and marks the session pausing', async () => {
  const { session, writes } = sessionFixture()
  await session.pause()
  assert.equal(session.pauseRequested, true)
  assert.equal(session.activity.snapshot().state, 'pausing')
  const frame = JSON.parse(writes.at(-1).input)
  assert.deepEqual(frame, { type: 'control_request', request_id: frame.request_id, request: { subtype: 'interrupt', reason: 'interrupt' } })
  await session.dispose()
})

test('pause refuses when no turn is running', async () => {
  const { session } = sessionFixture()
  session.busy = false
  await assert.rejects(session.pause(), error => error.code === 'NOT_RUNNING')
  await session.dispose()
})

test('a pause that is never confirmed recycles the remote process', async () => {
  const { session, writes } = sessionFixture({ pauseTimeoutMs: 5 })
  await session.pause()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(session.paused, true)
  assert.equal(session.hasTurn, false)
  assert.equal(session.offset, 0)
  assert.equal(session.activity.snapshot().state, 'paused')
  assert.ok(writes.length >= 2, 'interrupt and kill commands are sent')
  await session.dispose()
})

test('stop aborts local tools, recycles the process and keeps the session paused', async () => {
  const { session } = sessionFixture()
  let aborted = false
  session.turnAbort.signal.addEventListener('abort', () => { aborted = true })
  await session.stop()
  assert.equal(aborted, true)
  assert.equal(session.stopRequested, true)
  assert.equal(session.paused, true)
  assert.equal(session.activity.snapshot().state, 'paused')
  await session.dispose()
})

function managerFixture() {
  const sessions = []
  const manager = new RemoteClaudeManager({ agents: { get: () => ({ id: 'session-1' }) } }, config, {
    createSession(sessionIdentity) {
      const session = {
        ...sessionIdentity,
        hasTurn: false,
        paused: 0,
        stopped: 0,
        lastUsedAt: Date.now(),
        async pause() { this.paused += 1 },
        async stop() { this.stopped += 1 },
        async dispose() { this.paused += 100 },
        async *turn() { yield { type: 'text', text: 'hi' }; this.hasTurn = true },
      }
      sessions.push(session)
      return session
    },
  })
  return { manager, sessions }
}

const options = { sessionId: 'session-1', model: 'claude-code-agent', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }

test('the manager resolves the main remote session for pause and stop', async (t) => {
  const { manager, sessions } = managerFixture()
  t.after(() => manager.dispose())
  await collect(manager.stream(options))
  const snapshot = await manager.pause('session-1')
  assert.equal(sessions[0].paused, 1)
  assert.equal(typeof snapshot.state, 'string')
  await manager.stopSession('session-1')
  assert.equal(sessions[0].stopped, 1)
  assert.equal(manager.activityFor('session-1'), sessions[0].activity)
})

test('pausing without a remote session reports NOT_RUNNING', async (t) => {
  const { manager } = managerFixture()
  t.after(() => manager.dispose())
  await assert.rejects(manager.pause('session-1'), error => error.code === 'NOT_RUNNING')
  await assert.rejects(manager.stopSession('session-1'), error => error.code === 'NOT_RUNNING')
})
