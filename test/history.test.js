import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { HandoffStore, RemoteClaudeManager } from '../lib/manager.js'
import { RemoteClaudeSession } from '../lib/remote-session.js'

const config = { host: 'vps.test', username: 'test', idleSessionMs: 1800000, claudeModel: 'sonnet', claudePath: 'claude', remoteBaseDir: '.dsh-remote-claude', restrictedMode: true }
const ctx = { agents: { get: () => ({}) } }
const options = { sessionId: 'dsh-test', model: 'claude-code-agent', system: 'unchanged system' }
const key = JSON.stringify([options.sessionId, ''])
const message = (role, text) => ({ role, content: [{ type: 'text', text }] })
const first = message('user', 'first request')
const reply = message('assistant', 'a reply')
const second = message('user', 'second request')

async function run(manager, messages, overrides = {}) {
  for await (const _ of manager.stream({ ...options, messages, ...overrides })) { /* drain */ }
}

function fixture(t, { oldRunStatus = 0, agents = ctx.agents, beforeResult } = {}) {
  const host = { agents }
  const dir = mkdtempSync(join(tmpdir(), 'remote-claude-history-'))
  const file = join(dir, 'handoff.json')
  const launched = []
  const statusChecks = []
  const sent = []
  const managers = []
  t.after(async () => {
    await Promise.all(managers.map(manager => manager.dispose()))
    rmSync(dir, { recursive: true, force: true })
  })
  function manager() {
    const handoffs = new HandoffStore(config, { file })
    const m = new RemoteClaudeManager(host, config, {
      handoffs,
      sweeper: { async run() {} },
      createSession(identity) {
        const ssh = {
          ready: true,
          async connect() {},
          async reverseForward() { return { remotePort: 1234 } },
          async exec(command, { input } = {}) {
            if (command === 'bash -s') {
              const encoded = input.match(/printf %s '([^']+)' \| base64 -d > "\$run_dir\/run.sh"/)[1]
              launched.push({ command: input, script: Buffer.from(encoded, 'base64').toString('utf8') })
            } else if (input) {
              const event = JSON.parse(input)
              if (event.type === 'user') sent.push(event.message.content[0].text)
            } else if (command.includes('if test -L') && !command.includes('for attempt')) {
              statusChecks.push(command)
              return { code: oldRunStatus, stdout: '', stderr: '' }
            }
            return { code: 0, stdout: '', stderr: '' }
          },
          async openExec() {
            beforeResult?.()
            const output = new PassThrough()
            output.close = () => output.destroy()
            output.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'a reply' })}\n`)
            return output
          },
          async dispose() {},
        }
        const gateway = { address: { port: 4321 }, token: 'local-test-token', async listen() {}, setTurnContext() {}, clearTurnContext() {}, async close() {} }
        return new RemoteClaudeSession(host, config, identity, { ssh, gateway })
      },
    })
    managers.push(m)
    return m
  }
  return { manager, launched, statusChecks, sent }
}

test('ordinary append submits only the latest user text on the existing process', async t => {
  const f = fixture(t)
  const manager = f.manager()
  await run(manager, [first])
  await run(manager, [first, reply, second])
  assert.equal(f.launched.length, 1)
  assert.equal(f.sent[1], 'second request')
})

test('native tool results survive adapter attachment projection and continue in the same Claude session', async t => {
  const firstUser = { ...first, id: 'first-user' }
  const firstReply = { ...reply, id: 'first-reply' }
  const secondUser = { ...second, id: 'second-user' }
  const thirdUser = { ...second, id: 'third-user' }
  const nativeTool = { role: 'tool', id: 'native-result', toolCallId: 'remote-claude-test',
    content: [{ type: 'image', attachment: { name: 'result.png' } }] }
  const projectedTool = { ...nativeTool, content: [{ type: 'text', text: '[image: result.png]' }] }
  let surface = [firstUser]
  const agents = { get: () => ({ session: { deriveMessages: () => [...surface] } }) }
  const f = fixture(t, { agents, beforeResult: () => { if (surface.length === 1) surface.push(nativeTool) } })
  const manager = f.manager()
  await run(manager, [firstUser])
  surface.push(firstReply, secondUser)
  await run(manager, [firstUser, projectedTool, firstReply, secondUser])
  assert.equal(f.launched.length, 1)
  assert.equal(f.sent[1], 'second request')
  const editedTool = { ...nativeTool, content: [{ type: 'text', text: 'edited result' }] }
  const secondReply = { ...reply, id: 'second-reply' }
  surface = [firstUser, editedTool, firstReply, secondUser, secondReply, thirdUser]
  await run(manager, surface)
  assert.equal(f.launched.length, 2)
})

test('a new Host restores the saved Claude UUID and uses the same remote project path', async t => {
  const f = fixture(t)
  const before = f.manager()
  await run(before, [first])
  const saved = before.handoffs.get(key)
  await before.dispose()
  await run(f.manager(), [first, reply, second])
  assert.equal(f.statusChecks.length, 1)
  assert.ok(f.statusChecks[0].includes(saved.runId))
  assert.ok(f.launched[1].script.includes(`--resume '${saved.claudeSessionId}'`))
  assert.doesNotMatch(f.launched[1].script, /--session-id/)
  assert.equal(f.sent[1], 'second request')
  const workDir = launch => launch.command.match(/work_dir=([^;]+);/)[1]
  assert.match(workDir(f.launched[0]), /workspaces\//)
  assert.equal(workDir(f.launched[0]), workDir(f.launched[1]))
})

test('a live or uncertain previous run causes a fresh session and full replay before sending input', async t => {
  const f = fixture(t, { oldRunStatus: 1 })
  await run(f.manager(), [first])
  await run(f.manager(), [first, reply, second])
  assert.equal(f.statusChecks.length, 1)
  assert.doesNotMatch(f.statusChecks[0], /kill -TERM/)
  assert.doesNotMatch(f.launched[1].script, /--resume/)
  assert.match(f.sent[1], /first request[\s\S]*a reply[\s\S]*second request/)
})

test('regenerating the same last user message never appends to a completed remote turn', async t => {
  const f = fixture(t)
  const manager = f.manager()
  await run(manager, [first])
  await run(manager, [first])
  assert.equal(f.launched.length, 2)
  assert.doesNotMatch(f.launched[1].script, /--resume/)
})

test('an edited last reply or changed system prompt invalidates the saved handoff', async t => {
  for (const [messages, overrides] of [
    [[first, message('assistant', 'edited reply'), second], {}],
    [[first, reply, second], { system: 'different system' }],
  ]) {
    const f = fixture(t)
    const before = f.manager()
    await run(before, [first])
    await before.dispose()
    await run(f.manager(), messages, overrides)
    assert.equal(f.statusChecks.length, 0)
    assert.doesNotMatch(f.launched[1].script, /--resume/)
  }
})

test('an unfinished adapter stream invalidates its previous handoff', async t => {
  const f = fixture(t)
  const manager = f.manager()
  await run(manager, [first])
  assert.ok(manager.handoffs.get(key))
  const stream = manager.stream({ ...options, messages: [first, reply, second] })
  assert.equal((await stream.next()).done, false)
  await stream.return()
  assert.equal(f.manager().handoffs.get(key), undefined)
})
