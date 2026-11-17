import { ActivityLog } from './activity.js'
import { RemoteClaudeSession } from './remote-session.js'
import { effectiveSystemText, latestUserText, transcriptToText } from './util.js'
import { selectedEffort } from './model-catalog.js'

const MAX_ACTIVITY_LOGS = 50

export class RemoteClaudeManager {
  constructor(ctx, config, { createSession = (identity) => new RemoteClaudeSession(ctx, config, identity) } = {}) {
    this.ctx = ctx
    this.config = config
    this.createSession = createSession
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
    const key = JSON.stringify([options.sessionId, options.purpose ?? ''])
    if (this.active.has(key)) throw new Error('A Remote Claude turn is already active for this DSH session and purpose')
    const current = latestUserText(options.messages)
    if (!current) throw new Error('Remote Claude received no user text')
    this.active.add(key)
    let session = this.sessions.get(key)
    let completed = false
    try {
      const actualModel = this.actualModel(options.model)
      const reasoningEffort = selectedEffort(this.config, actualModel, options.reasoningEffort)
      if (session && (session.model !== actualModel || session.reasoningEffort !== reasoningEffort)) {
        await session.dispose()
        this.sessions.delete(key)
        session = undefined
      }
      if (!session) {
        session = this.createSession({
          dshSessionId: options.sessionId,
          model: actualModel,
          reasoningEffort,
          ledger: this.ledger,
          purpose: options.purpose ?? '',
          activity: this.activityLog(options.sessionId),
        })
        this.sessions.set(key, session)
      }
      yield* session.turn({
        prompt: session.hasTurn ? current : initialPrompt(options.messages, current),
        system: effectiveSystemText(options.messages, options.system),
        tools: options.tools ?? [],
        agent,
        signal: options.signal,
      })
      completed = true
    } finally {
      // Also clean up if the consumer stops iterating without an AbortSignal.
      if (!completed && session) {
        await session.dispose().catch(() => {})
        if (this.sessions.get(key) === session) this.sessions.delete(key)
      }
      this.active.delete(key)
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
