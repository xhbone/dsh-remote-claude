import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const MAX_TRANSCRIPT_CHARS = 60000
const MAX_TOOL_BLOCK_CHARS = 1200
const HINT_LINE = /^（已(?:暂停|停止)：.*$/u

export function shellQuote(value) {
  const text = String(value)
  if (text.includes('\0')) throw new Error('NUL is not allowed in a shell argument')
  return `'${text.replaceAll("'", `'"'"'`)}'`
}

export function expandLocalPath(value) {
  if (!value) return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(2))
  }
  return resolve(value)
}

export function remoteBaseExpression(value) {
  const input = String(value || '.dsh-remote-claude')
  if (input.startsWith('/')) return shellQuote(input)
  const relative = input.startsWith('~/') ? input.slice(2) : input
  if (!relative || relative === '.' || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('remoteBaseDir must be an absolute POSIX path or a safe path below $HOME')
  }
  return `"$HOME"/${shellQuote(relative)}`
}

export function abortError(signal, fallback = 'Operation aborted') {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException(reason ? String(reason) : fallback, 'AbortError')
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

export function contentBlocksToText(content) {
  if (typeof content === 'string') return stripHints(content)
  if (!Array.isArray(content)) return ''
  const lines = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      const text = stripHints(typeof block.text === 'string' ? block.text : '')
      if (text) lines.push(text)
    } else if (block.type === 'reasoning') {
      // Thinking is per-turn scratch work; replaying it as conversation text makes the
      // remote model treat old deliberation as facts it must build on.
      continue
    } else if (block.type === 'tool-call') {
      lines.push(`[tool call: ${block.name ?? 'unknown'} ${truncate(block.arguments ?? '', MAX_TOOL_BLOCK_CHARS)}]`)
    } else if (block.type === 'tool-result' || block.type === 'tool_result') {
      lines.push(`[tool result: ${truncate(toolResultText(block), MAX_TOOL_BLOCK_CHARS)}]`)
    } else if (block.type === 'file') {
      lines.push(`[file: ${block.attachment?.name ?? 'attachment'}]`)
    } else if (block.type === 'image') {
      lines.push(`[image: ${block.attachment?.name ?? block.attachment?.mediaType ?? 'attachment'}]`)
    }
  }
  return lines.join('\n')
}

function toolResultText(block) {
  if (typeof block.text === 'string') return block.text
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) return block.content.map((item) => (typeof item === 'string' ? item : item?.text ?? '')).join('\n')
  if (block.value !== undefined) return typeof block.value === 'string' ? block.value : JSON.stringify(block.value)
  return ''
}

function stripHints(text) {
  if (!text || !text.includes('（已')) return text
  return text.split('\n').filter((line) => !HINT_LINE.test(line.trim())).join('\n')
}

function truncate(text, max) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function messageToText(message) {
  if (!message || typeof message !== 'object') return ''
  return contentBlocksToText(message.content)
}

export function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messageToText(messages[index])
  }
  return ''
}

export function effectiveSystemText(messages, explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit
  for (const message of messages) {
    if (message?.role === 'system') {
      const text = messageToText(message)
      if (text) return text
    }
  }
  return ''
}

export function transcriptToText(messages, { maxChars = MAX_TRANSCRIPT_CHARS } = {}) {
  const rendered = []
  for (const message of messages) {
    const text = messageToText(message)
    if (!text) continue
    rendered.push(`[${String(message.role ?? 'message').toUpperCase()}]\n${text}`)
  }
  const full = rendered.join('\n\n')
  return full.length > maxChars ? `…${full.slice(-maxChars)}` : full
}

/** Stable digest of the conversation prefix DSH showed to the model. */
export function digestMessages(messages) {
  const normalized = (Array.isArray(messages) ? messages : []).map((message) => ({
    role: String(message?.role ?? ''),
    content: message?.content ?? null,
  }))
  return digestText(JSON.stringify(normalized))
}

export function digestText(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex')
}

export function unsupportedOption(name) {
  const error = new Error(`Remote Claude does not support GenerateOptions.${name}`)
  error.code = 'UNSUPPORTED_OPTION'
  return error
}

export function normalizeFingerprint(value) {
  return String(value || '').trim().replace(/=+$/, '')
}

/** Separator to insert before a new text block, given the last characters already emitted. */
export function textSeparator(tail) {
  const text = String(tail ?? '')
  if (!text || text.endsWith('\n\n')) return ''
  return text.endsWith('\n') ? '\n' : '\n\n'
}

/** Last lines of a remote log, safe to put in an error message: secrets removed, size bounded. */
export function sanitizeRemoteLog(text, secrets = [], maxChars = 1500) {
  let out = String(text ?? '').replaceAll('\0', '').trim()
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(String(secret), '***')
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer ***')
  return out.length > maxChars ? `…${out.slice(-maxChars)}` : out
}
