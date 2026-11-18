import { SshClient } from './ssh-client.js'
import { shellQuote } from './util.js'
import { normalizeModels } from './model-catalog.js'

const PROBE_TIMEOUT_MS = 20000
const MAX_PROBE_BYTES = 2 * 1024 * 1024
const MAX_STDERR_CHARS = 8192

// No user prompt is sent: only read-only control requests run, so discovery
// costs no额度. Account identity and credentials are deliberately not returned.
// Control responses answer without a user message (verified on Claude Code
// 2.1.311), which is what keeps this probe free.
//
// The probe speaks NDJSON directly over the SSH exec channel. It deliberately
// does not depend on python3 (or any other remote interpreter).
const PROBE_REQUESTS = [
  ['probe-init', 'initialize'],
  ['probe-models', 'list_models'],
  ['probe-usage', 'get_usage', { skip_behaviors: true }],
  ['probe-version', 'get_binary_version'],
]

export function buildProbeCommand(config) {
  const args = [
    shellQuote(config.claudePath || 'claude'),
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', "''",
    '--strict-mcp-config',
    '--mcp-config', shellQuote('{"mcpServers":{}}'),
    '--permission-prompts', 'none',
    '--no-session-persistence',
  ]
  if (config.restrictedMode) args.push('--restricted')
  return `exec ${args.join(' ')}`
}

export function parseProbeLine(line, state) {
  let event
  try { event = JSON.parse(line) } catch { return false }
  if (event?.type !== 'control_response') return false
  const response = event.response ?? {}
  if (!state.pending.delete(response.request_id)) return false
  if (response.subtype !== 'success') return false
  const payload = response.response ?? {}
  if (response.request_id === 'probe-models') state.result.models = payload.models ?? []
  else if (response.request_id === 'probe-usage') state.result.usage = payload
  else if (response.request_id === 'probe-version') state.result.version = payload.version
  return true
}

function runProbe(stream, signal) {
  return new Promise((resolve, reject) => {
    const state = { pending: new Set(PROBE_REQUESTS.map(([id]) => id)), result: {} }
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try { stream.end() } catch {}
      try { stream.close?.() } catch {}
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('Remote probe aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_PROBE_BYTES) {
        finish(new Error('Remote probe produced too much output'))
        return
      }
      let index
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        if (parseProbeLine(line, state) && state.pending.size === 0) finish(undefined, state.result)
      }
    })
    stream.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS)
    })
    stream.on('error', (error) => finish(error))
    stream.on('close', () => {
      finish(new Error(`Remote model discovery failed: ${stderr.trim() || 'Claude exited before answering the probe'}`))
    })
    for (const [requestId, subtype, extra] of PROBE_REQUESTS) {
      stream.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })}\n`)
    }
  })
}

// Reuse an already-connected SshClient (health checks open the connection once).
export async function probeOverConnection(ssh, config, signal) {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`Remote probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
    PROBE_TIMEOUT_MS,
  )
  timer.unref?.()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const stream = await ssh.openExec(buildProbeCommand(config), { signal: combined })
    const raw = await runProbe(stream, combined)
    const models = normalizeModels(raw.models)
    if (!models.length) throw new Error('Claude list_models did not return a model catalog')
    return {
      models,
      version: typeof raw.version === 'string' ? raw.version.slice(0, 64) : undefined,
      usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : null,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeRemote(ctx, config, signal) {
  const ssh = new SshClient(config, { resolvePassword: async ref => (await ctx.credentials.resolve(ref))?.value })
  try {
    await ssh.connect(signal)
    return await probeOverConnection(ssh, config, signal)
  } finally { await ssh.dispose() }
}
