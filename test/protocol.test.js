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

test('normalizes top-level deltas and ignores subagent deltas', () => {
  const delta = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } }
  assert.deepEqual(parseClaudeEvent(delta), { kind: 'text-delta', text: 'ok' })
  assert.deepEqual(parseClaudeEvent({ ...delta, parent_tool_use_id: 'tool-1' }), { kind: 'ignore' })
})

test('normalizes result usage', () => {
  assert.deepEqual(parseClaudeEvent({
    type: 'result', subtype: 'success', is_error: false, result: 'done',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
  }), {
    kind: 'result', success: true, text: 'done', subtype: 'success', interrupted: false,
    usage: { inputTokens: 13, outputTokens: 4, totalTokens: 17, cacheReadTokens: 3 },
  })
})

test('marks an interrupted turn and keeps its cost', () => {
  const event = parseClaudeEvent({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: null,
    total_cost_usd: 0.0123, duration_ms: 4400, num_turns: 1,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
  assert.equal(event.kind, 'result')
  assert.equal(event.interrupted, true)
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
