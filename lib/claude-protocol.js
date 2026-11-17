export function buildUserMessage(text, uuid) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: '',
    uuid,
  }
}

export function buildInterruptRequest(requestId) {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt', reason: 'interrupt' },
  }
}

export function extractMessageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export function parseClaudeEvent(record) {
  if (!record || typeof record !== 'object') return { kind: 'ignore' }
  if (record.parent_tool_use_id != null) return { kind: 'ignore' }

  if (record.type === 'stream_event') {
    const event = record.event
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return { kind: 'text-delta', text: String(event.delta.text ?? '') }
    }
    return { kind: 'ignore' }
  }

  if (record.type === 'assistant') {
    const text = extractMessageText(record.message)
    return text ? { kind: 'assistant-text', text } : { kind: 'ignore' }
  }

  if (record.type === 'system' && record.subtype === 'init') {
    return { kind: 'init', sessionId: record.session_id, tools: record.tools }
  }

  if (record.type === 'result') {
    return {
      kind: 'result',
      success: record.is_error !== true && record.subtype !== 'error',
      text: typeof record.result === 'string' ? record.result : '',
      subtype: record.subtype,
      usage: normalizeUsage(record.usage),
    }
  }

  if (record.type === 'error') {
    return { kind: 'error', message: String(record.error?.message ?? record.message ?? 'Claude Code error') }
  }

  return { kind: 'ignore' }
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const outputTokens = numberOrZero(usage.output_tokens)
  const cacheReadTokens = numberOrUndefined(usage.cache_read_input_tokens)
  const cacheWriteTokens = numberOrUndefined(usage.cache_creation_input_tokens)
  // Anthropic reports uncached input separately; DSH's input total includes it.
  const inputTokens = numberOrZero(usage.input_tokens) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (!inputTokens && !outputTokens && cacheReadTokens === undefined && cacheWriteTokens === undefined) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }
}

function numberOrZero(value) {
  return Number.isFinite(value) ? Number(value) : 0
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? Number(value) : undefined
}
