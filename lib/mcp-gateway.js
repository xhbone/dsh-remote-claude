import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

const MAX_BODY_BYTES = 10 * 1024 * 1024
const SUPPORTED_PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])

export class McpGateway {
  constructor(ctx, { token = randomBytes(32).toString('base64url') } = {}) {
    this.ctx = ctx
    this.token = token
    this.server = undefined
    this.address = undefined
    this.sockets = new Set()
    this.turn = undefined
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
    }
  }

  clearTurnContext(context) {
    if (!context || this.turn?.owner === context) {
      this.turn?.controller.abort(new Error('DSH tool authorization was revoked'))
      this.turn = undefined
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
    const schema = turn.tools.find((tool) => tool.name === name)
    if (!schema) throw rpcError(-32602, `Tool is not available in this DSH turn: ${name}`)
    const callId = `remote-claude-${randomUUID()}`
    const call = {
      type: 'tool-call',
      id: callId,
      name,
      arguments: JSON.stringify(params?.arguments ?? {}),
    }
    const execute = () => this.ctx.tools.execute({
      calls: [call],
      signal: turn.signal,
      agent: turn.agent,
      maxParallelToolCalls: 1,
    })
    const batch = this.ctx.agents.withInitiator(turn.agent, execute)
    const outcome = (await batch).results.find((item) => item.callId === callId)?.result
    if (!outcome) return { isError: true, content: [{ type: 'text', text: 'DSH returned no result for the tool call.' }] }
    return {
      isError: outcome.isError === true,
      content: toolContent(outcome),
    }
  }
}

function toolContent(outcome) {
  const content = Array.isArray(outcome.content) ? outcome.content : []
  const mapped = content.flatMap((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (block?.type === 'image' && block.attachment?.name) return [{ type: 'text', text: `[image: ${block.attachment.name}]` }]
    return []
  })
  if (mapped.length) return mapped
  if (outcome.isError) return [{ type: 'text', text: String(outcome.error?.message ?? 'DSH tool execution failed') }]
  return [{ type: 'text', text: safeJson(outcome.value) }]
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
