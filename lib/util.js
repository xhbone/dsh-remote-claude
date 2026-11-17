import { homedir } from 'node:os'
import { resolve } from 'node:path'

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
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const lines = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') {
      if (typeof block.text === 'string') lines.push(block.text)
    } else if (block.type === 'tool-call') {
      lines.push(`[tool call: ${block.name ?? 'unknown'} ${block.arguments ?? ''}]`)
    } else if (block.type === 'file') {
      lines.push(`[file: ${block.attachment?.name ?? 'attachment'}]`)
    } else if (block.type === 'image') {
      lines.push(`[image: ${block.attachment?.name ?? block.attachment?.mediaType ?? 'attachment'}]`)
    }
  }
  return lines.join('\n')
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

export function transcriptToText(messages) {
  const rendered = []
  for (const message of messages) {
    const text = messageToText(message)
    if (!text) continue
    rendered.push(`[${String(message.role ?? 'message').toUpperCase()}]\n${text}`)
  }
  return rendered.join('\n\n')
}

export function unsupportedOption(name) {
  const error = new Error(`Remote Claude does not support GenerateOptions.${name}`)
  error.code = 'UNSUPPORTED_OPTION'
  return error
}

export function normalizeFingerprint(value) {
  return String(value || '').trim().replace(/=+$/, '')
}
