import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteClaudeAdapter } from '../lib/adapter.js'
import { effectiveSystemText, latestUserText, transcriptToText } from '../lib/util.js'

test('adapter emits canonical text, usage, and terminal finish ordering', async () => {
  const manager = {
    async *stream() {
      yield { type: 'text', text: 'hello' }
      yield { type: 'text', text: ' world' }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    },
  }
  const adapter = new RemoteClaudeAdapter(manager, { claudeModel: 'sonnet' })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'remote-claude', model: 'claude-code-agent', messages: [] })) chunks.push(chunk)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks[3].block, { type: 'text', text: 'hello world' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('adapter rejects unsupported sampling options', async () => {
  const adapter = new RemoteClaudeAdapter({ async *stream() {} }, { claudeModel: 'sonnet' })
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({ provider: 'remote-claude', model: 'sonnet', messages: [], temperature: 0 })) {}
  }, (error) => error.code === 'UNSUPPORTED_OPTION')
})

test('message projection separates effective system and latest user text', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'system rules' }] },
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'latest' }] },
  ]
  assert.equal(effectiveSystemText(messages), 'system rules')
  assert.equal(effectiveSystemText(messages, 'one-shot'), 'one-shot')
  assert.equal(latestUserText(messages), 'latest')
  assert.match(transcriptToText(messages), /\[ASSISTANT\]\nanswer/)
})
