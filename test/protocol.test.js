import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInterruptRequest, buildUserMessage, parseClaudeEvent } from '../lib/claude-protocol.js'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

test('builds Claude stream-json user input with replay correlation uuid', () => {
  assert.deepEqual(buildUserMessage('你好', UUID), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: UUID,
  })
})

test('builds fail-safe interrupt control request', () => {
  assert.deepEqual(buildInterruptRequest(UUID), {
    type: 'control_request',
    request_id: UUID,
    request: { subtype: 'interrupt', reason: 'interrupt' },
  })
})

test('surfaces subagent assistant text with its parent tool call', () => {
  const event = parseClaudeEvent({
    type: 'assistant',
    parent_tool_use_id: 'toolu_child',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'child result' }],
      usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 },
    },
  })
  assert.equal(event.kind, 'subagent-text')
  assert.equal(event.text, 'child result')
  assert.equal(event.parentToolUseId, 'toolu_child')
  assert.equal(event.usage.inputTokens, 2)
  assert.equal(event.usage.totalTokens, 9)
})

test('reports task lifecycle events as subagent activity', () => {
  const started = parseClaudeEvent({ type: 'system', subtype: 'task_started', description: 'scan repo', task_id: 'task-1' })
  assert.deepEqual(started, { kind: 'subagent-start', description: 'scan repo', taskId: 'task-1' })
  assert.deepEqual(
    parseClaudeEvent({ type: 'system', subtype: 'task_notification', status: 'completed', summary: 'done' }),
    { kind: 'subagent-done', status: 'completed', summary: 'done' },
  )
})

test('normalizes top-level deltas and ignores subagent deltas', () => {
  const delta = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }
  assert.deepEqual(parseClaudeEvent(delta), { kind: 'text-delta', text: 'ok' })
  assert.deepEqual(parseClaudeEvent({ ...delta, parent_tool_use_id: 'tool-1' }), { kind: 'ignore' })
})

test('normalizes disjoint usage buckets and preserves the write TTL breakdown', () => {
  const wireUsage = {
    input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 80,
    cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 },
  }
  for (const usage of [wireUsage, { ...wireUsage, cache_creation_input_tokens: 10 }]) {
    assert.deepEqual(parseClaudeEvent({ type: 'result', subtype: 'success', result: 'done', usage }), {
      kind: 'result', success: true, text: 'done', subtype: 'success',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 104, cacheReadTokens: 80, cacheWriteTokens: 10 },
      cacheCreation: { fiveMinuteTokens: 7, oneHourTokens: 3 },
    })
  }
})

test('keeps the cost and subtype of an unconfirmed execution error', () => {
  const event = parseClaudeEvent({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: null,
    total_cost_usd: 0.0123, duration_ms: 4400, num_turns: 1,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
  assert.equal(event.kind, 'result')
  // The session decides whether this is a pause (only when it sent the interrupt).
  assert.equal('interrupted' in event, false)
  assert.equal(event.success, false)
  assert.equal(event.subtype, 'error_during_execution')
  assert.equal(event.costUsd, 0.0123)
  assert.equal(event.durationMs, 4400)
  assert.equal(event.numTurns, 1)
})

test('parses thinking, tool-use and compaction events', () => {
  const thinking = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } }
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__local_dsh__read', input: {} }] } }
  const compact = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } }
  assert.deepEqual(parseClaudeEvent(thinking), { kind: 'thinking-delta', text: 'hmm' })
  assert.deepEqual(parseClaudeEvent(tool), { kind: 'tool-use', name: 'mcp__local_dsh__read', input: {} })
  assert.equal(parseClaudeEvent(compact).kind, 'compact')
})
