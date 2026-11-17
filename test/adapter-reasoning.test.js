import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteClaudeAdapter } from '../lib/adapter.js'

function adapterWith(events, config = {}) {
  const manager = { async *stream() { for (const event of events) yield event } }
  return new RemoteClaudeAdapter(manager, { showThinking: true, pauseHint: '', stopHint: '', ...config })
}
const collect = async (iterator) => { const result = []; for await (const item of iterator) result.push(item); return result }
const options = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }

test('reasoning streams as a second block and is closed with its text', async () => {
  const chunks = await collect(adapterWith([
    { type: 'reasoning', text: 'think ' },
    { type: 'reasoning', text: 'more' },
    { type: 'text', text: 'answer' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
  ]).stream(options))
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'block-start', 'reasoning-delta', 'reasoning-delta', 'text-delta', 'block-end', 'block-end', 'usage', 'finish',
  ])
  assert.equal(chunks[1].blockType, 'reasoning')
  assert.equal(chunks[1].index, 1)
  assert.equal(chunks[5].block.text, 'answer')
  assert.equal(chunks[6].block.text, 'think more')
  assert.deepEqual(chunks[7].usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 })
  assert.deepEqual(chunks[8].reason, { kind: 'stop' })
})

test('showThinking false keeps the reasoning out of the LLM stream', async () => {
  const chunks = await collect(adapterWith([{ type: 'reasoning', text: 'secret' }, { type: 'text', text: 'ok' }], { showThinking: false }).stream(options))
  assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), false)
  assert.equal(chunks.some(chunk => chunk.type === 'block-start' && chunk.index === 1), false)
  assert.equal(chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 0).block.text, 'ok')
})

test('paused and stopped turns append their configured hints', async () => {
  const paused = await collect(adapterWith([{ type: 'paused' }], { pauseHint: '（已暂停）' }).stream(options))
  assert.equal(paused.find(chunk => chunk.type === 'block-end').block.text, '（已暂停）')
  const stopped = await collect(adapterWith([{ type: 'stopped' }], { stopHint: '（已停止）' }).stream(options))
  assert.equal(stopped.find(chunk => chunk.type === 'block-end').block.text, '（已停止）')
})

test('rejects sampling options the remote CLI cannot honor', async () => {
  await assert.rejects(collect(adapterWith([]).stream({ ...options, temperature: 0.2 })), /temperature/)
  await assert.rejects(collect(adapterWith([]).stream({ ...options, maxTokens: 100 })), /maxTokens/)
  await assert.rejects(collect(adapterWith([]).stream({ ...options, stop: ['x'] })), /stop/)
})
