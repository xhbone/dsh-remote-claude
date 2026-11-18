import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { summarizeToolArgs } from './activity.js'

const MAX_BODY_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const SUPPORTED_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])

export class McpGateway {
  constructor(ctx, { token = randomBytes(32).toString('base64url'), activity, waitingAfterMs = 3000 } = {}) {
    this.ctx = ctx
    this.token = token
    this.activity = activity
    this.waitingAfterMs = waitingAfterMs
    this.server = undefined
    this.address = undefined
    this.sockets = new Set()
    this.turn = undefined
    this.activeCalls = 0
  }

  setTurnContext(context) {
    this.clearTurnContext()
    const controller = new AbortController()
    this.turn = {
      ...context,
      owner: context,
      controller,
      signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal,
      queue: Promise.resolve(),
      calls: 0,
      log: toolLogOf(context.agent),
      admission: undefined,
    }
  }

  clearTurnContext(context) {
    if (!context || this.turn?.owner === context) {
      const turn = this.turn
      this.turn = undefined
      if (turn) {
        turn.controller.abort(new Error('DSH tool authorization was revoked'))
        this.#disposeToolSet(turn)
      }
    }
  }

  async listen() {
    if (this.server) return this.address
    this.server = http.createServer((request, response) => {
      void this.#handle(request, response)
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('MCP gateway did not bind a TCP port')
    this.address = { host: '127.0.0.1', port: address.port }
    return this.address
  }

  async close() {
    this.clearTurnContext()
    const server = this.server
    this.server = undefined
    this.address = undefined
    if (!server) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  async #handle(request, response) {
    let id = null
    const turn = this.turn
    try {
      if (!isLoopbackHost(request.headers.host)) return sendHttp(response, 403, 'Forbidden')
      if (request.method !== 'POST' || request.url !== '/mcp') return sendHttp(response, 404, 'Not found')
      if (!hasBearerToken(request.headers.authorization, this.token)) return sendHttp(response, 401, 'Unauthorized')

      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
        throw rpcError(-32600, 'Invalid JSON-RPC request')
      }
      id = Object.hasOwn(body, 'id') ? body.id : undefined
      if (id === undefined) {
        if (!body.method.startsWith('notifications/')) throw rpcError(-32600, 'Requests require an id')
        response.writeHead(202)
        response.end()
        return
      }
      if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
        id = null
        throw rpcError(-32600, 'Invalid JSON-RPC id')
      }
      const result = await this.#dispatch(body.method, body.params, turn)
      sendJson(response, 200, { jsonrpc: '2.0', id, result })
    } catch (error) {
      const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603
      const status = Number.isInteger(error?.httpStatus) ? error.httpStatus : 200
      sendJson(response, status, {
        jsonrpc: '2.0',
        id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  async #dispatch(method, params, turn) {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-local-tools', version: '0.1.0' },
      }
    }
    if (method === 'notifications/initialized' || method === 'ping') return {}
    if (method === 'resources/list') return { resources: [] }
    if (method === 'prompts/list') return { prompts: [] }
    if (method === 'tools/list') return { tools: this.#tools() }
    if (method === 'tools/call') {
      if (!turn || turn !== this.turn) throw rpcError(-32001, 'No active DSH turn')
      const schema = (turn.tools ?? []).find((tool) => tool.name === params?.name)
      if (schema && isReadOnlyTool(schema)) return this.#callTool(params, turn)
      const result = turn.queue.then(() => this.#callTool(params, turn))
      turn.queue = result.catch(() => {})
      return result
    }
    throw rpcError(-32601, `Method not found: ${method}`)
  }

  #tools() {
    const schemas = this.turn?.tools ?? []
    return schemas.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.parameters ?? { type: 'object', properties: {} },
    }))
  }

  async #callTool(params, turn) {
    if (turn !== this.turn) throw rpcError(-32001, 'DSH tool authorization was revoked')
    if (turn.signal?.aborted) throw rpcError(-32002, 'The DSH turn was cancelled')
    const name = typeof params?.name === 'string' ? params.name : ''
    const schema = (turn.tools ?? []).find((tool) => tool.name === name)
    if (!schema) throw rpcError(-32602, `Tool is not available in this DSH turn: ${name}`)
    const tools = this.ctx.tools
    if (typeof tools?.execute !== 'function') throw rpcError(-32603, 'This DSH build does not expose ctx.tools.execute')
    const args = params?.arguments === undefined ? {} : params.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpcError(-32602, 'Tool arguments must be a JSON object')
    // Published ToolRuntime uses single calls. Desktop ToolsService has the
    // separate executor-selection and step-admission APIs for its batch pipeline.
    const usesBatch = typeof tools.selectExecutor === 'function' && typeof tools.resolve === 'function'
    const callId = `remote-claude-${randomUUID()}`
    const call = {
      type: 'tool-call',
      id: callId,
      name,
      arguments: JSON.stringify(args),
    }
    const startedAt = Date.now()
    this.activeCalls += 1
    turn.calls += 1
    this.activity?.toolStart(name, summarizeToolArgs(name, params?.arguments))
    const waitingTimer = this.waitingAfterMs > 0
      ? setTimeout(() => {
        if (this.turn === turn && turn.calls > 0) this.activity?.setWaiting('tool')
      }, this.waitingAfterMs)
      : undefined
    waitingTimer?.unref?.()
    let failed = false
    try {
      const log = turn.log
      const start = toolLogOf(turn.agent)
      if (log && (start?.turn !== log.turn || start?.step !== log.step)) {
        throw rpcError(-32001, 'The originating DSH step has closed')
      }
      const toolSet = usesBatch ? await this.#toolSetFor(turn, log) : undefined
      if (turn !== this.turn || turn.signal.aborted) throw rpcError(-32001, 'DSH tool authorization was revoked')
      const current = toolLogOf(turn.agent)
      if (log && (current?.turn !== log.turn || current?.step !== log.step)) {
        throw rpcError(-32001, 'The originating DSH step has closed')
      }
      const execute = usesBatch
        ? () => executeBatch(tools, turn, call, toolSet)
        : () => executeSingle(tools, turn, call, args)
      const outcome = await (turn.agent && typeof this.ctx.agents?.withInitiator === 'function'
        ? this.ctx.agents.withInitiator(turn.agent, execute)
        : execute())
      failed = outcome.isError === true
      return {
        isError: outcome.isError === true,
        content: await toolContent(outcome),
      }
    } catch (error) {
      failed = true
      throw error
    } finally {
      clearTimeout(waitingTimer)
      this.activeCalls -= 1
      turn.calls -= 1
      this.#disposeToolSet(turn)
      if (this.activity && this.turn === turn) {
        if (turn.calls === 0) this.activity.clearWaiting()
        this.activity.toolEnd(!failed, Date.now() - startedAt)
      }
    }
  }

  /** Share one admission resolution across all calls in the originating step. */
  async #toolSetFor(turn, log) {
    if (!log || typeof this.ctx.tools?.resolve !== 'function' || !turn.agent) return undefined
    if (!turn.admission) {
      const admission = { ...log, resolved: undefined }
      turn.admission = admission
      admission.pending = Promise.resolve().then(async () => {
        const selection = turn.agent.model?.current?.()
        admission.resolved = await this.ctx.tools.resolve({ agent: turn.agent, modelSelection: selection, signal: turn.signal })
        return admission.resolved
      })
    }
    if (turn.admission.turn !== log.turn || turn.admission.step !== log.step) {
      throw rpcError(-32001, 'The originating DSH step has changed')
    }
    try {
      return await turn.admission.pending
    } catch {
      throw rpcError(-32603, 'DSH could not resolve the tools admitted for this step')
    }
  }

  #disposeToolSet(turn) {
    if (turn === this.turn || turn.calls !== 0 || !turn.admission) return
    const { resolved } = turn.admission
    turn.admission = undefined
    try {
      resolved?.dispose?.()
    } catch {
      // Teardown must not fail the turn.
    }
  }
}

async function executeBatch(tools, { signal, agent, log }, call, toolSet) {
  const batch = await tools.execute({
    calls: [call], signal, agent, ...(log ? { log } : {}), ...(toolSet ? { toolSet } : {}), maxParallelToolCalls: 1,
  })
  const outcome = Array.isArray(batch?.results) && batch.results.find(item => item.callId === call.id)?.result
  return outcome || missingToolResult()
}

async function executeSingle(tools, { signal, agent, log }, call, args) {
  const session = agent?.session
  let callSeq
  if (log) {
    try {
      callSeq = session?.append?.('tool/call', { ...log, callId: call.id, name: call.name, arguments: call.arguments })?.seq
    } catch {
      // Session logging is best-effort. The runtime still owns approval and dispatch.
    }
  }
  let outcome
  try {
    outcome = await tools.execute({ callId: call.id, name: call.name, arguments: args, signal, ...(agent ? { agent } : {}) })
    if (!Array.isArray(outcome?.content)) outcome = missingToolResult()
  } catch (error) {
    outcome = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    throw error
  } finally {
    if (Number.isInteger(callSeq)) {
      try {
        const current = toolLogOf(agent)
        if (current?.turn === log.turn && current?.step === log.step) {
          session.append('tool/result', {
            ...log,
            message: createToolResultMessage({ callId: call.id, content: outcome.content, isError: outcome.isError === true }),
            ...(outcome.error?.info ? { error: outcome.error.info } : {}),
            ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}),
          }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
        }
      } catch {
        // Preserve the authoritative tool outcome if the session cannot log it.
      }
    }
  }
  return outcome
}

function missingToolResult() {
  return { isError: true, content: [{ type: 'text', text: 'DSH returned no result for the tool call.' }] }
}

/**
 * Read the live DSH step coordinates for tool-call logging. The agent loop
 * exposes its running phase as { kind: 'running', turn, step }. The latest
 * session boundary prevents a closed step from receiving a late tool event.
 */
export function toolLogOf(agent) {
  const phase = agent?.phase
  if (phase && phase.kind !== 'running') return undefined
  const events = agent?.session?.log
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'step/end' || event?.type === 'turn/end' || event?.type === 'turn/start') return undefined
      if (event?.type !== 'step/start') continue
      const turn = event.data?.turn
      const step = event.data?.step
      if (Number.isInteger(turn) && Number.isInteger(step)) return { turn, step }
      return undefined
    }
  }
  if (phase?.kind === 'running' && Number.isInteger(phase.turn) && Number.isInteger(phase.step)) {
    return { turn: phase.turn, step: phase.step }
  }
  return undefined
}

export function isReadOnlyTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  return tool.readOnly === true
    || tool.readonly === true
    || tool.annotations?.readOnlyHint === true
    || tool.annotations?.readOnly === true
}

async function toolContent(outcome) {
  const content = Array.isArray(outcome.content) ? outcome.content : []
  const mapped = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      mapped.push({ type: 'text', text: block.text })
      continue
    }
    if (block?.type === 'image') {
      const image = await imageContent(block)
      if (image) mapped.push(image)
      else if (block.attachment?.name) mapped.push({ type: 'text', text: `[image: ${block.attachment.name}]` })
    }
  }
  if (mapped.length) return mapped
  if (outcome.isError) return [{ type: 'text', text: String(outcome.error?.message ?? 'DSH tool execution failed') }]
  return [{ type: 'text', text: safeJson(outcome.value) }]
}

async function imageContent(block) {
  const direct = typeof block.data === 'string' && typeof block.mimeType === 'string' ? block : undefined
  const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : undefined
  const inline = direct ?? (typeof attachment?.data === 'string' && typeof attachment?.mimeType === 'string' ? attachment : undefined)
  if (inline) {
    const mimeType = String(inline.mimeType)
    if (!mimeType.startsWith('image/')) return undefined
    return { type: 'image', data: inline.data, mimeType }
  }
  const path = block.path ?? attachment?.path ?? attachment?.filePath
  if (typeof path !== 'string' || !path) return undefined
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return undefined
    const data = (await readFile(path)).toString('base64')
    const mimeType = attachment?.mimeType ?? block.mimeType ?? mimeTypeFromPath(path)
    if (!mimeType?.startsWith('image/')) return undefined
    return { type: 'image', data, mimeType }
  } catch {
    return undefined
  }
}

function mimeTypeFromPath(path) {
  const extension = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
  }[extension]
}

function safeJson(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? null, null, 2) } catch { return String(value) }
}

function isLoopbackHost(value) {
  if (!value) return false
  const host = String(value).toLowerCase()
  return host === 'localhost' || host.startsWith('localhost:') || host === '127.0.0.1' || host.startsWith('127.0.0.1:') || host === '[::1]' || host.startsWith('[::1]:')
}

function hasBearerToken(value, expected) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const actual = Buffer.from(value.slice(7))
  const target = Buffer.from(expected)
  return actual.length === target.length && timingSafeEqual(actual, target)
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      const error = rpcError(-32600, 'Request body is too large')
      error.httpStatus = 413
      throw error
    }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw rpcError(-32700, 'Invalid JSON') }
}

function rpcError(code, message) {
  const error = new Error(message)
  error.rpcCode = code
  return error
}

function sendJson(response, status, value) {
  if (response.headersSent) return
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length })
  response.end(body)
}

function sendHttp(response, status, text) {
  if (response.headersSent) return
  const body = Buffer.from(text)
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length })
  response.end(body)
}
