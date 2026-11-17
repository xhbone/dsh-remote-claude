import test from 'node:test'
import assert from 'node:assert/strict'
import { EFFORTS, catalogModels, normalizeModels, reasoningInfo, selectedEffort, splitModelList, validModelId } from '../lib/model-catalog.js'

const discovered = [
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'ultracode', 'minimal'] },
]
const config = (overrides = {}) => ({ modelCatalog: JSON.stringify(discovered), customModels: '', reasoningEffort: 'default', ...overrides })

test('effort ids stay inside what Claude Code 2.x actually accepts', () => {
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(EFFORTS.includes('ultracode'), false)
})

test('normalized catalog keeps aliases and adds resolved version ids', () => {
  const models = normalizeModels(discovered)
  assert.deepEqual(models.map(row => row.id), ['sonnet', 'claude-sonnet-5-5', 'haiku', 'claude-haiku-4-5', 'fable', 'claude-fable-5-1'])
  assert.equal(models.find(row => row.id === 'claude-sonnet-5-5').name, 'Sonnet 5.5 · claude-sonnet-5-5')
  assert.equal(models.find(row => row.id === 'haiku').efforts, undefined)
})

test('unknown effort levels are dropped and aliases mapped', () => {
  const fable = normalizeModels(discovered).find(row => row.id === 'fable')
  assert.deepEqual(fable.efforts, ['low', 'high'])
})

test('reasoning information exists only for models that advertise efforts', () => {
  const info = reasoningInfo(config({ reasoningEffort: 'high' }), 'claude-sonnet-5-5')
  assert.equal(info.efforts[0].id, 'default')
  assert.deepEqual(info.efforts.slice(1).map(row => row.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(info.defaultEffort, 'high')
  assert.equal(reasoningInfo(config(), 'claude-haiku-4-5'), undefined)
  assert.equal(reasoningInfo(config(), 'not-in-catalog'), undefined)
})

test('selected effort rejects unsupported levels and maps default to undefined', () => {
  assert.equal(selectedEffort(config(), 'claude-sonnet-5-5', 'xhigh'), 'xhigh')
  assert.equal(selectedEffort(config({ reasoningEffort: 'max' }), 'claude-sonnet-5-5'), 'max')
  assert.equal(selectedEffort(config(), 'claude-sonnet-5-5', 'default'), undefined)
  assert.equal(selectedEffort(config(), 'claude-haiku-4-5', undefined), undefined)
  assert.throws(() => selectedEffort(config(), 'claude-sonnet-5-5', 'ultracode'), /does not advertise effort/)
  assert.throws(() => selectedEffort(config(), 'claude-fable-5-1', 'max'), /does not advertise effort/)
})

test('catalog always offers the CLI aliases plus custom ids', () => {
  const models = catalogModels({ modelCatalog: '[]', customModels: 'my-model-1, claude-opus-4-6' })
  const ids = models.map(row => row.id)
  for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) assert.ok(ids.includes(alias))
  assert.ok(ids.includes('my-model-1'))
  assert.ok(ids.includes('claude-opus-4-6'))
  assert.equal(new Set(ids).size, ids.length)
})

test('model ids reject whitespace and control characters', () => {
  assert.equal(validModelId('claude-opus-5-5'), true)
  assert.equal(validModelId(''), false)
  assert.equal(validModelId('a b'), false)
  assert.equal(validModelId('a' + String.fromCharCode(10) + 'b'), false)
  assert.equal(validModelId(42), false)
})

test('custom model lists split on commas and whitespace', () => {
  assert.deepEqual(splitModelList('a, b  c' + String.fromCharCode(9) + 'd'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(splitModelList(''), [])
})
