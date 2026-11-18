import { parseClaudeEvent } from './claude-protocol.js'

// The CLI can send both partial SSE blocks and final assistant snapshots, or just
// the snapshots. Track emitted text per top-level message and content block.
export class MessageProjection {
  blocks = new Map()
  messageId = undefined
  lastIndex = 0

  events(raw) {
    if (raw.parent_tool_use_id != null) return [parseClaudeEvent(raw)]
    const sse = raw.type === 'stream_event' ? raw.event : undefined
    if (sse?.type === 'message_start') {
      this.reset(sse.message?.id)
      return []
    }
    if (sse?.type === 'content_block_start') {
      this.lastIndex = sse.index ?? 0
      this.blocks.set(this.lastIndex, { type: sse.content_block?.type, text: '' })
    }
    if (raw.type !== 'assistant') {
      const event = parseClaudeEvent(raw)
      if (event.kind === 'thinking-delta' || event.kind === 'text-delta') {
        const index = sse.index ?? this.lastIndex
        const type = event.kind === 'thinking-delta' ? 'thinking' : 'text'
        const block = this.blocks.get(index)
        this.blocks.set(index, { type, text: (block?.type === type ? block.text : '') + event.text })
      }
      return [event]
    }

    const message = raw.message ?? {}
    if (message.id && this.messageId && this.messageId !== message.id) this.reset(message.id)
    this.messageId ??= message.id
    const content = Array.isArray(message.content) ? message.content : []
    const events = []
    for (const [i, block] of content.entries()) {
      if (block?.type === 'tool_use') {
        events.push({ kind: 'tool-use', name: String(block.name ?? 'tool'), input: block.input })
        continue
      }
      if (block?.type !== 'thinking' && block?.type !== 'text') continue
      const text = block[block.type]
      if (typeof text !== 'string' || !text) continue
      // Claude Code may wrap the most recent SSE block in a one-element message.
      const index = content.length === 1 && this.blocks.get(this.lastIndex)?.type === block.type ? this.lastIndex : i
      const prior = this.blocks.get(index)
      const emitted = prior?.type === block.type ? prior.text : ''
      if (emitted && !text.startsWith(emitted)) {
        // A new, final-only single-block record can share a message id with the
        // previous record. A rewritten SSE summary, on the other hand, must not
        // duplicate the stream the user already saw.
        if (!prior?.snapshot || content.length !== 1) continue
      }
      const suffix = text.startsWith(emitted) ? text.slice(emitted.length) : text
      if (suffix) {
        if (block.type === 'text' && (!emitted || suffix === text)) events.push({ kind: 'text-start' })
        events.push({ kind: block.type === 'text' ? 'text-delta' : 'thinking-delta', text: suffix })
      }
      this.blocks.set(index, { type: block.type, text, snapshot: true })
    }
    // Records without an API message id have no cross-message identity. A new
    // snapshot must not inherit another message's block zero.
    if (!this.messageId) this.reset()
    return events
  }

  reset(id) {
    this.blocks.clear()
    this.messageId = id
    this.lastIndex = 0
  }
}
