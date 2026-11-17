import assert from 'node:assert/strict'
import test from 'node:test'
import { ActivityLog, STATES, stateLabel, summarizeToolArgs } from '../lib/activity.js'

let clock = 1_000
const now = () => clock
const advance = (ms) => { clock += ms }

test('exposes the documented states with Chinese labels', () => {
  assert.deepEqual(STATES, ['idle', 'preparing', 'thinking', 'streaming', 'tool', 'waiting', 'pausing', 'paused', 'stopped', 'error'])
  assert.equal(stateLabel('thinking'), '思考中')
  assert.equal(stateLabel('paused'), '已暂停')
  assert.equal(stateLabel('custom'), 'custom')
})

test('summarizes tool arguments without leaking whole payloads', () => {
  assert.equal(summarizeToolArgs('read', { file_path: 'src/app.ts', offset: 10 }), 'src/app.ts')
  assert.equal(summarizeToolArgs('bash', { command: 'ls\n  -la\n' }), 'ls -la')
  assert.equal(summarizeToolArgs('mcp', { query: 'a'.repeat(120) }, { max: 20 }), `${'a'.repeat(19)}…`)
  assert.equal(summarizeToolArgs('x', { other: 'first string' }), 'first string')
  assert.equal(summarizeToolArgs('x', null), '')
})

test('beginTurn resets the turn and reports elapsed time', () => {
  clock = 1_000
  const log = new ActivityLog({ now })
  log.beginTurn({ model: 'claude-opus-5-5', effort: 'high', purpose: '', remoteSessionId: 'remote-1', version: '2.1.311' })
  advance(4_000)
  const snapshot = log.snapshot()
  assert.equal(snapshot.state, 'preparing')
  assert.equal(snapshot.elapsedMs, 4_000)
  assert.equal(snapshot.model, 'claude-opus-5-5')
  assert.equal(snapshot.effort, 'high')
  assert.equal(snapshot.version, '2.1.311')
  assert.equal(snapshot.remoteSessionId, 'remote-1')
  assert.equal(snapshot.paused, false)
})

test('streamed text is flushed into one summarized entry per window', () => {
  clock = 1_000
  const log = new ActivityLog({ now })
  log.beginTurn({})
  log.noteText('abc')
  log.noteText('de')
  assert.equal(log.entries.length, 0)
  advance(2_500)
  log.noteText('f')
  const entry = log.entries.at(-1)
  assert.equal(entry.kind, 'text')
  assert.equal(entry.label, '已输出 6 字符')
})

test('repeated notes within the dedupe window collapse into a count', () => {
  clock = 1_000
  const log = new ActivityLog({ now })
  log.note('rate-limit', '额度窗口已更新')
  advance(300)
  log.note('rate-limit', '额度窗口已更新')
  assert.equal(log.entries.length, 1)
  assert.equal(log.entries[0].count, 2)
  advance(2_000)
  log.note('rate-limit', '额度窗口已更新')
  assert.equal(log.entries.length, 2)
})

test('tool start and end are tracked on the snapshot', () => {
  clock = 1_000
  const log = new ActivityLog({ now })
  log.beginTurn({})
  log.toolStart('mcp__local_dsh__read', 'src/app.ts')
  assert.equal(log.snapshot().state, 'tool')
  assert.equal(log.snapshot().tool.argsPreview, 'src/app.ts')
  log.toolEnd(true, 120)
  assert.equal(log.snapshot().tool, undefined)
  assert.deepEqual(log.entries.at(-1), { at: 1_000, kind: 'tool', label: 'mcp__local_dsh__read', detail: '', ok: true, ms: 120, count: 1 })
})

test('endTurn records usage and can mark the turn paused', () => {
  clock = 1_000
  const log = new ActivityLog({ now })
  log.beginTurn({})
  log.endTurn({ ok: true, usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 })
  const done = log.snapshot()
  assert.equal(done.state, 'idle')
  assert.equal(done.turn.tokensIn, 12)
  assert.equal(done.turn.tokensOut, 5)
  assert.equal(done.turn.costUsd, 0.25)
  log.beginTurn({})
  log.endTurn({ paused: true })
  assert.equal(log.snapshot().state, 'paused')
  assert.equal(log.snapshot().paused, true)
})

test('the entry ring keeps only the newest capacity entries', () => {
  clock = 1_000
  const log = new ActivityLog({ now, capacity: 3 })
  for (let index = 0; index < 5; index += 1) {
    advance(2_000)
    log.note('note', `事件 ${index}`)
  }
  assert.deepEqual(log.entries.map(entry => entry.label), ['事件 2', '事件 3', '事件 4'])
})
