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

export function extractMessageBlocks(message) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && typeof block === 'object')
}

export function parseClaudeEvent(record) {
  if (!record || typeof record !== 'object') return { kind: 'ignore' }
  if (record.parent_tool_use_id != null) return { kind: 'ignore' }

  if (record.type === 'stream_event') {
    const event = record.event
    if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      return { kind: 'thinking-start' }
    }
    if (event?.type === 'content_block_delta') {
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta') return { kind: 'text-delta', text: String(delta.text ?? '') }
      if (delta.type === 'thinking_delta') return { kind: 'thinking-delta', text: String(delta.thinking ?? delta.text ?? '') }
      if (delta.type === 'signature_delta') return { kind: 'ignore' }
    }
    return { kind: 'ignore' }
  }

  if (record.type === 'assistant') {
    const blocks = extractMessageBlocks(record.message)
    const tool = blocks.find((block) => block.type === 'tool_use')
    if (tool) return { kind: 'tool-use', name: String(tool.name ?? 'tool'), input: tool.input }
    const thinking = blocks.find((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    if (thinking) return { kind: 'assistant-thinking', text: thinking.thinking }
    const text = extractMessageText(record.message)
    return text ? { kind: 'assistant-text', text } : { kind: 'ignore' }
  }

  if (record.type === 'system' && record.subtype === 'init') {
    return {
      kind: 'init',
      sessionId: record.session_id,
      tools: record.tools,
      model: record.model,
      version: record.claude_code_version,
    }
  }

  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    return { kind: 'compact' }
  }

  if (record.type === 'rate_limit_event') {
    return { kind: 'rate-limit', info: record.rate_limit_info }
  }

  if (record.type === 'result') {
    return {
      kind: 'result',
      success: record.is_error !== true && record.subtype !== 'error',
      interrupted: record.subtype === 'error_during_execution',
      text: typeof record.result === 'string' ? record.result : '',
      subtype: record.subtype,
      usage: normalizeUsage(record.usage),
      ...(numberOrUndefined(record.total_cost_usd) === undefined ? {} : { costUsd: numberOrUndefined(record.total_cost_usd) }),
      ...(numberOrUndefined(record.duration_ms) === undefined ? {} : { durationMs: numberOrUndefined(record.duration_ms) }),
      ...(numberOrUndefined(record.num_turns) === undefined ? {} : { numTurns: numberOrUndefined(record.num_turns) }),
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
