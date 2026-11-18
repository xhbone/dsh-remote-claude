import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [runtimeDir, target] = process.argv.slice(2)
if (!runtimeDir) throw new Error('Usage: node scripts/check-tool-runtime.mjs <npm-install-directory> [gateway.js]')
const requireRuntime = createRequire(resolve(runtimeDir, 'package.json'))
const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href)
const [{ Context }, { ToolRuntime }, { SystemPrompt }, { Session }, { McpGateway }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-session'),
  import(target ? pathToFileURL(resolve(target)).href : '../lib/mcp-gateway.js'),
])
assert.equal(requireRuntime('@deepseek-ai/dsh-tools/package.json').version, '0.2.1-rc.2')

const ctx = new Context()
new SystemPrompt(ctx, {})
const tools = new ToolRuntime(ctx)
const session = new Session('gateway-contract-check')
session.append('turn/start', { turn: 1 })
session.append('step/start', { turn: 1, step: 1 })
const agent = { session }
const name = 'contract_echo'
const parameters = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
let executions = 0
const disposeTool = tools.register({
  name, description: 'Echo a local contract-check string', parameters,
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
    presentationMeta: () => ({ diffs: [{ path: 'fixture.txt', before: '', after: 'probe' }] }),
  },
  execute(args, input) {
    assert.equal(input.agent, agent)
    assert.equal(input.callId, input.rootCallId)
    assert.ok(input.signal instanceof AbortSignal)
    executions++
    return args.text
  },
})
const disposeGuard = tools.guard(input => input.arguments.text === 'blocked' ? 'probe guard rejected the call' : undefined)
const gateway = new McpGateway({ tools })
try {
  const { host, port } = await gateway.listen()
  gateway.setTurnContext({ agent, tools: [{ name, parameters }] })
  async function call(id, text) {
    const response = await fetch(`http://${host}:${port}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { text } } }),
    })
    return response.json()
  }
  const success = await call(1, 'probe')
  assert.deepEqual(success, { jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: 'probe' }] } })
  const deny = await call(2, 'blocked')
  assert.equal(deny.result?.isError, true)
  assert.match(deny.result.content[0].text, /probe guard rejected/)
  assert.equal(executions, 1)
  const events = session.snapshotEvents()
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  for (const [i, result] of results.entries()) {
    assert.deepEqual(result.sourceEventSeqs, [calls[i].seq])
    assert.equal(result.surfaceOp, 'append')
    assert.equal(result.data.message.toolCallId, calls[i].data.callId)
  }
  assert.deepEqual(results[0].data.meta?.diffs, [{ path: 'fixture.txt', before: '', after: 'probe' }])
  assert.equal(results[1].data.message.isError, true)
  console.log('Published ToolRuntime and Session 0.2.1-rc.2: execution, guard, paired events and diff metadata passed')
} finally {
  await gateway.close()
  disposeGuard()
  disposeTool()
}
