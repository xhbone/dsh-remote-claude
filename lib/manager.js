import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ActivityLog } from './activity.js'
import { RemoteClaudeSession } from './remote-session.js'
import { RunSweeper } from './run-cleanup.js'
import { SshClient } from './ssh-client.js'
import { digestMessages, digestText, effectiveSystemText, latestUserText, pauseHint, transcriptToText } from './util.js'
import { selectedEffort } from './model-catalog.js'

const MAX_ACTIVITY_LOGS = 50
const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_HANDOFFS = 64
const HISTORY_VERSION = 3
const GATEWAY_CALL_PREFIX = 'remote-claude-'
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export class RemoteClaudeManager {
  constructor(ctx, config, {
    createSession = (identity) => new RemoteClaudeSession(ctx, config, identity),
    sweeper = new RunSweeper(),
    handoffs,
  } = {}) {
    this.ctx = ctx
    this.config = config
    this.createSession = createSession
    this.sweeper = sweeper
    this.handoffs = handoffs ?? new HandoffStore(config)
    this.ledger = undefined
    this.sessions = new Map()
    this.active = new Set()
    this.activity = new Map()
    this.closed = false
    this.timer = setInterval(() => { void this.#reapIdle() }, Math.min(Math.max(config.idleSessionMs / 4, 15000), 60000))
    this.timer.unref?.()
  }

  actualModel(model) {
    return model === 'claude-code-agent' ? this.config.claudeModel : model
  }

  activityLog(sessionId) {
    let log = this.activity.get(sessionId)
    if (!log) {
      log = new ActivityLog()
      this.activity.set(sessionId, log)
      if (this.activity.size > MAX_ACTIVITY_LOGS) {
        const oldest = this.activity.keys().next().value
        if (oldest !== sessionId) this.activity.delete(oldest)
      }
    }
    return log
  }

  /** The most recently used remote session for a DSH session (main purpose first). */
  sessionFor(sessionId) {
    let found
    for (const [key, session] of this.sessions) {
      let parsed
      try {
        parsed = JSON.parse(key)
      } catch {
        continue
      }
      if (parsed[0] !== sessionId) continue
      if (!found || (parsed[1] === '' && found.purpose !== '')) found = session
    }
    return found
  }

  activityFor(sessionId) {
    const session = this.sessionFor(sessionId)
    return session?.activity ?? this.activity.get(sessionId)
  }

  async pause(sessionId) {
    const session = this.sessionFor(sessionId)
    if (!session) throw codedError('No Remote Claude session exists for this DSH session', 'NOT_RUNNING')
    await session.pause()
    return session.activity.snapshot()
  }

  async stopSession(sessionId) {
    const session = this.sessionFor(sessionId)
    if (!session) throw codedError('No Remote Claude session exists for this DSH session', 'NOT_RUNNING')
    await session.stop()
    return session.activity.snapshot()
  }

  async *stream(options) {
    if (this.closed) throw new Error('Remote Claude plugin is disposed')
    if (!options.sessionId) throw new Error('Remote Claude requires a DSH sessionId so local tools can be bound safely')
    const agent = this.ctx.agents.get(options.sessionId)
    if (!agent) throw new Error(`No active DSH agent exists for session ${options.sessionId}`)
    // Title/compaction requests must never enter the main Claude conversation.
    const auxiliary = Boolean(options.purpose)
    const key = JSON.stringify([options.sessionId, options.purpose ?? ''])
    if (this.active.has(key)) throw new Error('A Remote Claude turn is already active for this DSH session and purpose')
    const messages = Array.isArray(options.messages) ? options.messages : []
    const nativeHistory = auxiliary ? undefined : nativeHistoryFor(agent.session, messages)
    const history = nativeHistory ?? messages
    const current = latestUserText(messages)
    if (!current) throw new Error('Remote Claude received no user text')
    this.active.add(key)
    let session = this.sessions.get(key)
    let completed = false
    try {
      const actualModel = auxiliary
        ? (this.config.auxiliaryModel || this.actualModel(options.model))
        : this.actualModel(options.model)
      // Auxiliary purposes (title, compaction) never inherit the main reasoning effort.
      const reasoningEffort = auxiliary ? 'default' : selectedEffort(this.config, actualModel, options.reasoningEffort)
      const system = effectiveSystemText(messages, options.system)
      const systemDigest = digestText(system)
      const endpointDigest = digestText(JSON.stringify([
        this.config.host, this.config.port ?? 22, this.config.username, this.config.knownHostFingerprint,
        this.config.remoteBaseDir, this.config.claudePath, this.config.restrictedMode,
        this.config.remoteBuiltinTools, this.config.allowRemoteWebTools,
      ]))
      const replayPrompt = () => initialPrompt(messages, current)
      const saved = this.handoffs.get(key)
      const previous = session ?? saved
      const activity = session?.activity ?? (auxiliary ? new ActivityLog() : this.activityLog(options.sessionId))
      const previousModel = previous?.model ?? activity.remote.selectedModel
        ?? (auxiliary ? undefined : this.ledger?.get(options.sessionId)?.lastMain?.selectedModel)
      let cacheStart
      if (previousModel && previousModel !== actualModel) cacheStart = 'model'
      else if (previous && previous.endpointDigest !== endpointDigest) cacheStart = 'endpoint'
      else if (previous && (session ? session.reasoningEffort : saved.effort) !== reasoningEffort) cacheStart = 'effort'
      if (session && cacheStart) {
        await session.dispose()
        this.sessions.delete(key)
        session = undefined
      }
      if (session && session.hasTurn && !canContinue(session.historyConfirmed, history, systemDigest)) {
        // DSH edited, reverted or compacted history behind our back. The remote context is
        // no longer a prefix of what DSH has, so replay instead of silently diverging.
        cacheStart = 'history'
        await session.dispose()
        this.sessions.delete(key)
        session = undefined
      }
      if (!session) {
        const restored = saved?.model === actualModel && saved.effort === reasoningEffort && saved.endpointDigest === endpointDigest
          && UUID.test(saved.claudeSessionId ?? '') && UUID.test(saved.runId ?? '')
          && canContinue(saved, history, systemDigest) ? saved : undefined
        if (!restored) {
          cacheStart ??= saved && !canContinue(saved, history, systemDigest) ? 'history' : (previousModel ? 'replay' : 'new')
        }
        session = this.createSession({
          dshSessionId: options.sessionId,
          model: actualModel,
          reasoningEffort,
          ledger: this.ledger,
          purpose: options.purpose ?? '',
          activity,
          sweep: (ssh) => this.sweeper.run(ssh, this.config, this.liveRunIds()),
          ...(restored ? { restored } : {}),
        })
        session.endpointDigest = endpointDigest
        this.sessions.set(key, session)
      }
      // A failed, cancelled or interrupted adapter stream might have sent input to Claude
      // which DSH never commits. Invalidate the old handoff before any new input is sent.
      this.handoffs.delete(key)
      const reply = { role: 'assistant', content: [{ type: 'text', text: '' }] }
      let stopped = false
      const showThinking = this.config.showThinking !== false
      for await (const event of session.turn({
        prompt: session.hasTurn ? current : replayPrompt(),
        replayPrompt,
        system,
        cacheStart: cacheStart ?? (session.hasTurn ? undefined : 'replay'),
        previousModel,
        tools: options.tools ?? [],
        agent,
        signal: options.signal,
      })) {
        if (event.type === 'text') reply.content[0].text += event.text
        else if (event.type === 'reasoning' && showThinking) {
          reply.content[1] ??= { type: 'reasoning', text: '' }
          reply.content[1].text += event.text
        } else if (event.type === 'paused') reply.content[0].text += pauseHint(this.config)
        else if (event.type === 'stopped') stopped = true
        yield event
      }
      completed = true
      if (session.hasTurn && !stopped) {
        // Check the entire committed prefix next time, including this reply. A regenerated
        // turn or an edited reply must not be appended to the existing Claude transcript.
        const toolResults = nativeHistory ? appendedToolResults(agent.session, nativeHistory) : []
        if (!toolResults) {
          session.historyConfirmed = undefined
          return
        }
        const committed = [...history, ...toolResults, reply]
        const confirmed = { historyVersion: HISTORY_VERSION, count: committed.length, digest: digestMessages(committed), systemDigest }
        session.historyConfirmed = confirmed
        this.handoffs.set(key, {
          claudeSessionId: session.claudeSessionId,
          runId: session.runId,
          model: actualModel,
          effort: reasoningEffort,
          endpointDigest,
          hasTurn: true,
          ...confirmed,
        })
      }
    } finally {
      // Also clean up if the consumer stops iterating without an AbortSignal. A cancelled
      // turn whose interrupt was confirmed leaves a live, paused session worth keeping.
      if (!completed && session && session.reusable !== true) {
        await session.dispose().catch(() => {})
        if (this.sessions.get(key) === session) this.sessions.delete(key)
      } else if (!completed && session) {
        // A confirmed interrupt can leave the transport alive, but DSH might have
        // discarded the partial answer. The next turn must verify a fresh context.
        session.historyConfirmed = undefined
      }
      this.active.delete(key)
    }
  }

  /** Run ids of every session this Host owns; the sweeper must never touch them. */
  liveRunIds() {
    return [...this.sessions.values()].flatMap((session) => [session.runId, session.oldRunId]).filter(Boolean)
  }

  /** Remove finished run directories now instead of waiting for the retention window. */
  async cleanupRemoteRuns() {
    const ssh = new SshClient(this.config, {
      resolvePassword: async (ref) => (await this.ctx.credentials?.resolve(ref))?.value,
    })
    try {
      await ssh.connect(AbortSignal.timeout(Math.max(this.config.connectTimeoutMs ?? 20000, 5000)))
      return await this.sweeper.clean(ssh, this.config, this.liveRunIds())
    } finally {
      await ssh.dispose().catch(() => {})
    }
  }

  async dispose() {
    this.closed = true
    clearInterval(this.timer)
    await this.reset()
  }

  async reset() {
    const sessions = [...new Set(this.sessions.values())]
    this.sessions.clear()
    await Promise.allSettled(sessions.map((session) => session.dispose()))
  }

  async #reapIdle() {
    const now = Date.now()
    const expired = [...this.sessions.entries()].filter(([id, session]) => !this.active.has(id) && !session.busy && now - session.lastUsedAt >= this.config.idleSessionMs)
    for (const [id, session] of expired) {
      this.sessions.delete(id)
      await session.dispose().catch(() => {})
    }
  }
}

// Native tool results enter DSH's durable history before the streaming assistant
// reply. Read that same surface on consecutive turns, before adapter attachment
// projection changes the representation of a result (for example, an image).
function nativeHistoryFor(session, messages) {
  const current = session?.deriveMessages?.()?.filter((message) => message.role !== 'developer')
  if (!current || current.length !== messages.length) return undefined
  return current.every((message, index) => typeof message.id === 'string'
    && message.id === messages[index].id && message.role === messages[index].role) ? current : undefined
}

function appendedToolResults(session, before) {
  const after = session.deriveMessages().filter((message) => message.role !== 'developer')
  if (after.length < before.length || before.some((message, index) => message !== after[index])) return undefined
  const added = after.slice(before.length)
  return added.every((message) => message.role === 'tool' && message.toolCallId?.startsWith(GATEWAY_CALL_PREFIX)) ? added : undefined
}

function canContinue(confirmed, messages, systemDigest) {
  return confirmed?.historyVersion === HISTORY_VERSION
    && confirmed.systemDigest === systemDigest
    && confirmed.count === messages.length - 1
    && messages.at(-1)?.role === 'user'
    && digestMessages(messages.slice(0, -1)) === confirmed.digest
}

/** Best-effort local cache of Claude session ids so a Host restart can --resume. */
export class HandoffStore {
  constructor(config, { file } = {}) {
    this.file = file ?? join(tmpdir(), 'dsh-remote-claude', `${digestText(`${config.host}|${config.username}|${config.remoteBaseDir}`).slice(0, 12)}.json`)
    this.state = this.#load()
  }

  get(key) {
    const saved = this.state[key]
    if (!saved || typeof saved !== 'object') return undefined
    if (Date.now() - Number(saved.savedAt ?? 0) > HANDOFF_TTL_MS) {
      delete this.state[key]
      return undefined
    }
    return saved
  }

  set(key, value) {
    this.state[key] = { ...value, savedAt: Date.now() }
    this.#prune()
    this.#save()
  }

  delete(key) {
    if (!Object.hasOwn(this.state, key)) return
    delete this.state[key]
    this.#save()
  }

  #prune() {
    const rows = Object.entries(this.state).sort((a, b) => Number(b[1]?.savedAt ?? 0) - Number(a[1]?.savedAt ?? 0))
    if (rows.length > MAX_HANDOFFS) this.state = Object.fromEntries(rows.slice(0, MAX_HANDOFFS))
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  #save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state))
    } catch {
      // Losing the handoff cache only costs one text replay; it must never fail a turn.
    }
  }
}

function initialPrompt(messages, latest) {
  const transcript = transcriptToText(messages)
  if (!transcript) return latest
  return `The DSH conversation up to this turn is reproduced below. Continue from the latest user request.\n\n${transcript}`
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}
