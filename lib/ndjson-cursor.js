const utf8 = new TextDecoder('utf-8', { fatal: true })

export class NdjsonCursorParser {
  constructor({ offset = 0, maxLineBytes = 16 * 1024 * 1024 } = {}) {
    this.offset = offset
    this.maxLineBytes = maxLineBytes
    this.pending = Buffer.alloc(0)
  }

  push(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.pending = this.pending.length ? Buffer.concat([this.pending, input]) : input
    const records = []
    while (true) {
      const newline = this.pending.indexOf(0x0a)
      if (newline < 0) break
      if (newline > this.maxLineBytes) throw new Error(`Claude output line exceeded ${this.maxLineBytes} bytes`)
      const startOffset = this.offset
      const endOffset = startOffset + newline + 1
      let line = this.pending.subarray(0, newline)
      this.pending = this.pending.subarray(newline + 1)
      this.offset = endOffset
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (!line.length) continue
      try {
        const text = utf8.decode(line)
        if (!text.trimStart().startsWith('{')) {
          records.push({ kind: 'diagnostic', reason: 'non-json-line', text, startOffset, endOffset })
          continue
        }
        try {
          records.push({ kind: 'event', event: JSON.parse(text), startOffset, endOffset })
        } catch (error) {
          records.push({ kind: 'diagnostic', reason: 'invalid-json', text, error, startOffset, endOffset })
        }
      } catch (error) {
        records.push({ kind: 'diagnostic', reason: 'invalid-utf8', error, startOffset, endOffset })
      }
    }
    if (this.pending.length > this.maxLineBytes) {
      throw new Error(`Claude output line exceeded ${this.maxLineBytes} bytes without a newline`)
    }
    return records
  }
}
