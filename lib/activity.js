export const STATES = [
  'idle', 'preparing', 'thinking', 'streaming', 'tool', 'waiting', 'pausing', 'paused', 'stopped', 'error',
]

const STATE_LABELS = {
  idle: '空闲',
  preparing: '连接远端',
  thinking: '思考中',
  streaming: '输出中',
  tool: '执行工具',
  waiting: '等待确认',
  pausing: '正在暂停',
  paused: '已暂停',
  stopped: '已停止',
  error: '出错',
}

const TEXT_FLUSH_MS = 2000
const DEDUPE_MS = 1500
const MAX_ENTRIES = 100

export function stateLabel(state) {
  return STATE_LABELS[state] ?? state
}

const ARG_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'command', 'query', 'pattern', 'url', 'prompt', 'name']

export function summarizeToolArgs(name, input, { max = 80 } = {}) {
  if (input === undefined || input === null) return ''
  let candidate
  if (typeof input === 'string') {
    candidate = input
  } else if (typeof input === 'object') {
    const preferred = ARG_KEYS.find((key) => typeof input[key] === 'string' && input[key].trim())
    if (preferred) {
      candidate = input[preferred]
    } else {
      const firstString = Object.values(input).find((value) => typeof value === 'string' && value.trim())
      candidate = firstString ?? JSON.stringify(input)
    }
  } else {
    candidate = String(input)
  }
  const flat = String(candidate ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export class ActivityLog {
  constructor({ capacity = MAX_ENTRIES, now = Date.now } = {}) {
    this.capacity = capacity
    this.now = now
    this.state = 'idle'
    this.stateSince = now()
    this.lastEventAt = now()
    this.turn = undefined
    this.tool = undefined
    this.waiting = undefined
    this.entries = []
    this.textBuffer = 0
    this.textFlushedAt = 0
    this.remote = {}
    this.updatedAt = now()
  }

  beginTurn({ model, effort, purpose, remoteSessionId, version } = {}) {
    const at = this.now()
    this.state = 'preparing'
    this.stateSince = at
    this.lastEventAt = at
    this.turn = { startedAt: at, tokensIn: 0, tokensOut: 0, costUsd: 0, chars: 0 }
    this.tool = undefined
    this.waiting = undefined
    this.textBuffer = 0
    this.textFlushedAt = 0
    if (model !== undefined) this.remote.model = model
    if (effort !== undefined) this.remote.effort = effort
    if (remoteSessionId !== undefined) this.remote.sessionId = remoteSessionId
    if (version !== undefined) this.remote.version = version
    this.remote.purpose = purpose ?? ''
    this.updatedAt = at
  }

  setState(state, detail) {
    if (!STATES.includes(state)) return
    const at = this.now()
    this.lastEventAt = at
    this.updatedAt = at
    if (this.state !== state) {
      this.state = state
      this.stateSince = at
    }
    if (detail) this.remote.detail = detail
  }

  touch() {
    this.lastEventAt = this.now()
    this.updatedAt = this.lastEventAt
  }

  noteText(delta) {
    const text = String(delta ?? '')
    if (!text) return
    this.touch()
    this.textBuffer += text.length
    if (this.turn) this.turn.chars += text.length
    const at = this.now()
    if (!this.textFlushedAt) this.textFlushedAt = at
    if (at - this.textFlushedAt >= TEXT_FLUSH_MS) {
      this.textFlushedAt = at
      this.#push({ kind: 'text', label: `已输出 ${formatChars(this.textBuffer)} 字符` })
      this.textBuffer = 0
      this.textFlushedAt = at
    }
  }

  noteThinking(delta) {
    if (delta) {
      this.touch()
      if (!this.remote.thinkingChars) this.remote.thinkingChars = 0
      this.remote.thinkingChars += String(delta).length
    }
  }

  toolStart(name, argsPreview) {
    const at = this.now()
    this.tool = { name, argsPreview: argsPreview ?? '', startedAt: at }
    this.setState('tool')
    this.updatedAt = at
  }

  toolEnd(ok, ms) {
    const name = this.tool?.name ?? 'tool'
    this.tool = undefined
    this.#push({ kind: 'tool', label: name, ok: ok !== false, ms: Number.isFinite(ms) ? ms : undefined })
    this.touch()
  }

  setWaiting(kind) {
    if (this.waiting?.kind === kind) return
    this.waiting = { kind, since: this.now() }
    this.setState('waiting')
    this.#push({ kind: 'note', label: '可能正在等待你确认权限（见上方审批卡片）', detail: '' })
  }

  clearWaiting() {
    this.waiting = undefined
    if (this.state === 'waiting') this.setState(this.tool ? 'tool' : 'streaming')
  }

  note(kind, label, detail, extra = {}) {
    this.#push({ kind, label, detail, ...extra })
    this.touch()
  }

  endTurn({ ok = true, usage, costUsd, paused = false } = {}) {
    if (this.textBuffer) {
      this.#push({ kind: 'text', label: `已输出 ${formatChars(this.textBuffer)} 字符` })
      this.textBuffer = 0
    }
    if (usage && this.turn) {
      this.turn.tokensIn = Number(usage.inputTokens ?? 0)
      this.turn.tokensOut = Number(usage.outputTokens ?? 0)
    }
    if (Number.isFinite(costUsd) && this.turn) this.turn.costUsd = Number(costUsd)
    this.tool = undefined
    this.waiting = undefined
    this.setState(paused ? 'paused' : ok ? 'idle' : 'error')
    this.turn = this.turn ? { ...this.turn, endedAt: this.now() } : undefined
  }

  snapshot() {
    const at = this.now()
    const elapsed = this.turn ? at - this.turn.startedAt : 0
    return structuredClone({
      state: this.state,
      stateLabel: stateLabel(this.state),
      stateSince: this.stateSince,
      elapsedMs: elapsed,
      silentMs: Math.max(0, at - this.lastEventAt),
      model: this.remote.model,
      effort: this.remote.effort,
      version: this.remote.version,
      purpose: this.remote.purpose ?? '',
      remoteSessionId: this.remote.sessionId,
      paused: this.state === 'paused',
      turn: this.turn,
      tool: this.tool,
      waiting: this.waiting,
      thinkingChars: this.remote.thinkingChars ?? 0,
      entries: this.entries.slice(),
      updatedAt: this.updatedAt,
    })
  }

  #push(entry) {
    const at = this.now()
    const full = {
      at,
      kind: entry.kind ?? 'note',
      label: String(entry.label ?? ''),
      detail: entry.detail === undefined ? '' : String(entry.detail),
      ...(entry.ok === undefined ? {} : { ok: entry.ok }),
      ...(entry.ms === undefined ? {} : { ms: entry.ms }),
      count: 1,
    }
    const last = this.entries[this.entries.length - 1]
    if (last && last.kind === full.kind && last.label === full.label && at - last.at < DEDUPE_MS && full.detail === '') {
      last.count += 1
      last.at = at
    } else {
      this.entries.push(full)
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    }
    this.updatedAt = at
  }
}

function formatChars(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}
