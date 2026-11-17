import assert from 'node:assert/strict'
import test from 'node:test'
import { NdjsonCursorParser } from '../lib/ndjson-cursor.js'

test('commits offsets only after complete LF-delimited records', () => {
  const parser = new NdjsonCursorParser({ offset: 7 })
  const bytes = Buffer.from('{"text":"中文"}\n{"n":2}\n')
  const split = bytes.indexOf(Buffer.from('中')) + 1
  assert.deepEqual(parser.push(bytes.subarray(0, split)), [])
  assert.equal(parser.offset, 7)
  const records = parser.push(bytes.subarray(split))
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((item) => item.event), [{ text: '中文' }, { n: 2 }])
  assert.equal(records[0].startOffset, 7)
  assert.equal(records[0].endOffset, 7 + Buffer.byteLength('{"text":"中文"}\n'))
  assert.equal(parser.offset, 7 + bytes.length)
})

test('advances over malformed complete lines without breaking later events', () => {
  const parser = new NdjsonCursorParser()
  const records = parser.push(Buffer.from('not-json\n{bad}\n{"ok":true}\npartial'))
  assert.deepEqual(records.map((item) => item.kind), ['diagnostic', 'diagnostic', 'event'])
  assert.deepEqual(records.at(-1).event, { ok: true })
  assert.equal(parser.offset, Buffer.byteLength('not-json\n{bad}\n{"ok":true}\n'))
})
