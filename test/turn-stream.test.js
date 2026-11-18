import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { RemoteClaudeSession } from '../lib/remote-session.js'

const line = event => JSON.stringify(event) + '\n'
const sse = event => ({ type: 'stream_event', event })
const start = (index, type) => sse({ type: 'content_block_start', index, content_block: { type } })
const delta = (index, type, value) => sse({ type: 'content_block_delta', index, delta: { type: `${type}_delta`, [type]: value } })
const assistant = (id, content, usage) => ({ type: 'assistant', message: { id, content, usage } })
const publicThought = thinking => ({ type: 'thinking', thinking })
const text = text => ({ type: 'text', text })
const tool = name => ({ type: 'tool_use', name, input: {} })
const result = { type: 'result', subtype: 'success', result: 'answer', usage: { input_tokens: 6100, output_tokens: 120 } }
const options = { prompt: 'test', tools: [], agent: {}, system: 'test' }
const join = (events, kind) => events.filter(e => e.type === kind).map(e => e.text).join('')

function fixture(t, tails, config = {}) {
  const writes = [], commands = [], bills = [], ports = []
  const ssh = {
    ready: true, async connect() {},
    async reverseForward(localPort, previous) { ports.push(previous); return { remotePort: 4545 } },
    async exec(command, opts) { if (opts?.input?.startsWith('{')) writes.push(JSON.parse(opts.input)); return { code: 0, stdout: '', stderr: '' } },
    async openExec(command) {
      commands.push(command)
      const data = tails.shift()
      if (data instanceof Error) throw data
      const stream = Readable.from(typeof data === 'function' ? data() : [Buffer.from(data ?? '')]); stream.close = () => stream.destroy()
      return stream
    }, async dispose() {},
  }
  const gateway = { token: 'test', address: { port: 6667 }, async listen() {}, setTurnContext() {}, clearTurnContext() {}, async close() {} }
  const session = new RemoteClaudeSession({}, { remoteBaseDir: '.dsh-remote-claude', claudePath: 'claude', ...config },
    { model: 'sonnet', dshSessionId: 'tests', ledger: { record(_sid, _rid, event) { bills.push(event) } } }, { ssh, gateway })
  t.after(() => session.dispose())
  return { session, ssh, writes, ports, commands, bills, collect: () => Array.fromAsync(session.turn(options)) }
}

test('public thinking from partial and snapshot-only blocks is displayed exactly once alongside the final reply', async t => {
  const final = assistant('m1', [publicThought('ABC'), publicThought('DEF'), { type: 'redacted_thinking', data: 'hidden' }, text('answer'), tool('read')])
  const source = [sse({ type: 'message_start', message: { id: 'm1' } }), start(0, 'thinking'), delta(0, 'thinking', 'AB'),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } }),
    start(3, 'text'), delta(3, 'text', 'ans'), final, final, result]
  const { collect, session } = fixture(t, [source.map(line).join('')])
  const chunks = await collect()
  assert.equal(join(chunks, 'reasoning'), 'ABCDEF')
  assert.equal(join(chunks, 'text'), 'answer')
  assert.equal(session.activity.snapshot().thinkingChars, 6)
})

test('snapshot-only thinking obeys showThinking, including snapshots containing tool_use and text', async t => {
  const source = [assistant('m1', [publicThought('brief'), tool('read'), text('ok')]), result].map(line).join('')
  for (const showThinking of [true, false]) {
    const chunks = await fixture(t, [source], { showThinking }).collect()
    assert.equal(join(chunks, 'reasoning'), showThinking ? 'brief' : '')
    assert.equal(join(chunks, 'text'), 'ok')
  }
})

test('three-tool turn reports last top-level assistant occupancy; only result totals enter billing', async t => {
  const source = ['read', 'list', 'stat'].map((name, i) => assistant('api-' + i, [tool(name)], { input_tokens: 100 + i }))
  source.push(assistant('final', [text('ok')], { input_tokens: 80, cache_read_input_tokens: 350, output_tokens: 7 }),
    { ...assistant('child', [text('child')], { input_tokens: 9000 }), parent_tool_use_id: 'child-call' }, result)
  const { collect, bills } = fixture(t, [source.map(line).join('')])
  const events = await collect()
  const usage = events.find(e => e.type === 'usage').usage
  assert.equal(usage.inputTokens, 430)
  assert.equal(usage.outputTokens, 7)
  assert.deepEqual(bills[0].contextUsage, usage)
  assert.equal(bills.length, 1)
  assert.equal(bills[0].usage.inputTokens, 6100)
})

test('result-only usage is billed but does not supply a fabricated occupancy measurement', async t => {
  const { collect, bills } = fixture(t, [line(result)])
  assert.ok(!(await collect()).some(e => e.type === 'usage'))
  assert.equal(bills[0].contextUsage, undefined)
  assert.equal(bills[0].usage.inputTokens, 6100)
})

test('partial UTF-8 line and EOF resume at the committed offset after failed connect and forward', async t => {
  const first = line(delta(0, 'text', '一'))
  const second = line(delta(0, 'text', '二'))
  const cut = Buffer.from(second).indexOf(Buffer.from('二')) + 1
  const { collect, writes, commands, ssh, ports } = fixture(t, [Buffer.concat([Buffer.from(first), Buffer.from(second).subarray(0, cut)]), second + line(result)], { turnReconnectAttempts: 3 })
  let connects = 0, forwards = 0
  ssh.connect = async () => { if (++connects === 2) throw Error('temporarily offline') }
  const forward = ssh.reverseForward
  ssh.reverseForward = async (...args) => { if (++forwards === 2) throw Error('port not ready'); return forward(...args) }
  const events = await collect()
  assert.equal(join(events, 'text'), '一二')
  assert.equal(writes.filter(entry => entry.type === 'user').length, 1)
  assert.equal(connects, 4)
  assert.equal(commands.length, 2)
  assert.match(commands[1], new RegExp(`-c \\+${Buffer.byteLength(first) + 1} `))
  assert.deepEqual(ports, [0, 4545])
})

test('channel error, attach failure and premature EOF share one reconnect budget', async t => {
  const { collect, commands, writes } = fixture(t, [async function *() { throw Error('channel reset') }, Error('tail unavailable'), ''], { turnReconnectAttempts: 2 })
  await assert.rejects(collect, { code: 'TURN_DISCONNECTED' })
  assert.equal(commands.length, 3)
  assert.equal(writes.filter(entry => entry.type === 'user').length, 1)
})

test('remote protocol failures propagate directly and do not reattach', async t => {
  const { collect, commands } = fixture(t, [line({ type: 'error', message: 'execution failed' })])
  await assert.rejects(collect, /execution failed/)
  assert.equal(commands.length, 1)
})
