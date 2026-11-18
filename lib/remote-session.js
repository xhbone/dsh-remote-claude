import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { MessageProjection } from './message-projection.js'
import { ActivityLog } from './activity.js'
import { buildInterruptRequest, buildUserMessage, normalizeUsage, parseClaudeEvent } from './claude-protocol.js'
import { McpGateway } from './mcp-gateway.js'
import { NdjsonCursorParser } from './ndjson-cursor.js'
import { SshClient } from './ssh-client.js'
import { abortError, digestText, remoteBaseExpression, sanitizeRemoteLog, shellQuote, textSeparator, throwIfAborted } from './util.js'

const PAUSE_TIMEOUT_MS = 8000
const ERROR_LOG_TIMEOUT_MS = 5000
const WATCHDOG_TICK_MS = 5000
const RECONNECT_ATTEMPTS = 5
const MIN_CLAUDE_VERSION = [2, 1, 0]
const TOOL_WAIT_MS = 3000
const RUN_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export class RemoteClaudeSession {
  constructor(ctx, config, { dshSessionId, model, reasoningEffort, ledger, purpose, activity, sweep, restored }, {
    ssh = new SshClient(config, {
      resolvePassword: async (ref) => (await ctx.get('credentials')?.resolve(ref))?.value,
    }),
    gateway,
  } = {}) {
    this.ctx = ctx
    this.config = config
    this.remoteBaseDir = config.remoteBaseDir
    this.dshSessionId = dshSessionId
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.ledger = ledger
    this.purpose = purpose ?? ''
    this.workspaceKey = digestText(JSON.stringify([dshSessionId, this.purpose]))
    this.activity = activity ?? new ActivityLog()
    this.sweep = sweep
    this.runId = randomUUID()
    this.oldRunId = restored?.runId
    this.claudeSessionId = restored?.claudeSessionId ?? randomUUID()
    this.resume = Boolean(restored)
    this.offset = 0
    this.started = false
    this.hasTurn = Boolean(restored?.hasTurn)
    this.busy = false
    this.lastUsedAt = Date.now()
    this.remotePort = 0
    this.ssh = ssh
    this.gateway = gateway ?? new McpGateway(ctx, { activity: this.activity, waitingAfterMs: TOOL_WAIT_MS })
    this.lifetime = new AbortController()
    this.disposing = undefined
    this.resolvedModel = restored?.model
    this.turnOpen = false
    this.pauseRequested = false
    this.paused = false
    this.stopRequested = false
    this.turnAbort = undefined
    this.pauseTimer = undefined
    this.idleTimer = undefined
    this.watchdogFired = false
    this.lastRemoteEventAt = Date.now()
  }

  async *turn({ prompt, replayPrompt, system, tools, agent, signal }) {
    if (this.busy) throw new Error('A Remote Claude turn is already active for this DSH session')
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    throwIfAborted(signal)
    this.busy = true
    this.lastUsedAt = Date.now()
    this.paused = false
    this.pauseRequested = false
    this.stopRequested = false
    this.watchdogFired = false
    this.lastRemoteEventAt = Date.now()
    this.turnAbort = new AbortController()
    const combined = AbortSignal.any([signal, this.turnAbort.signal])
    const turnContext = { tools: tools ?? [], agent, signal: combined }
    this.gateway.setTurnContext(turnContext)
    this.activity.beginTurn({
      model: this.resolvedModel ?? this.model,
      effort: this.reasoningEffort,
      purpose: this.purpose,
      remoteSessionId: this.claudeSessionId,
      version: this.activity.remote?.version,
    })
    let tail
    const closeTail = () => tail?.close?.()
    const watchdog = new AbortController()
    const readSignal = AbortSignal.any([signal, watchdog.signal])
    let lastAssistantUsage
    try {
      if (this.resume && !await this.#canResume(signal)) {
        if (typeof replayPrompt !== 'function') throw new Error('The previous Claude run has not been confirmed stopped')
        this.oldRunId = undefined
        this.resume = false
        this.hasTurn = false
        this.claudeSessionId = randomUUID()
        this.activity.remote.sessionId = this.claudeSessionId
        this.activity.note('note', '旧远端进程仍在运行或状态未知，将使用新会话重建上下文')
        prompt = replayPrompt()
      }
      await this.#ensureStarted(system, signal)
      tail = await this.#attach(signal)
      signal.addEventListener('abort', closeTail, { once: true })
      throwIfAborted(signal)
      await this.#append(buildUserMessage(prompt, randomUUID()), signal)
      this.turnOpen = true
      this.#armIdleWatchdog(() => watchdog.abort())
      this.activity.setState('thinking')
      const projection = new MessageProjection()
      let streamedText = false
      // Claude emits a fresh text block after every tool call; without a separator the
      // sentences before and after the call would run together in one DSH text block.
      let textTail = ''
      let breakBeforeText = false
      for await (const raw of this.#readTurnEvents(tail, readSignal)) {
        if (raw.type === 'system' && raw.subtype === 'init') this.#trackInit(raw)
        if (raw.type === 'assistant' && raw.parent_tool_use_id == null) {
          lastAssistantUsage = normalizeUsage(raw.message?.usage) ?? lastAssistantUsage
        }
        this.#recordLedger(raw, lastAssistantUsage)
        if (raw.type === 'control_request') {
          await this.#denyControlRequest(raw, signal)
          continue
        }
        for (const event of projection.events(raw)) {
          if (event.kind === 'text-start') {
            if (textTail) breakBeforeText = true
          } else if (event.kind === 'text-delta') {
            streamedText = true
            this.activity.setState('streaming')
            this.activity.noteText(event.text)
            if (event.text) {
              const text = breakBeforeText ? textSeparator(textTail) + event.text : event.text
              breakBeforeText = false
              textTail = (textTail + text).slice(-2)
              yield { type: 'text', text }
            }
          } else if (event.kind === 'thinking-start') {
            this.activity.setState('thinking')
          } else if (event.kind === 'thinking-delta') {
            this.activity.setState('thinking')
            this.activity.noteThinking(event.text)
            if (this.config.showThinking !== false && event.text) yield { type: 'reasoning', text: event.text }
          } else if (event.kind === 'subagent-text') {
            this.activity.note('subagent', '子代理输出', event.text.slice(0, 200))
            if (this.config.showSubagentText !== false && event.text.trim()) {
              const quoted = event.text.trim().split(/\r?\n/u).map((line) => `> ${line}`).join('\n')
              yield { type: 'text', text: `\n\n**子代理输出**\n\n${quoted}\n\n` }
            }
          } else if (event.kind === 'subagent-start') {
            this.activity.note('subagent', '子代理开始', event.description ?? '')
          } else if (event.kind === 'subagent-progress') {
            this.activity.note('subagent', '子代理进展', event.description ?? event.summary ?? '')
          } else if (event.kind === 'subagent-done') {
            this.activity.note('subagent', '子代理结束', event.summary ?? event.status ?? '')
          } else if (event.kind === 'tool-use') {
            this.activity.setState('tool', event.name)
            this.activity.touch()
          } else if (event.kind === 'compact') {
            this.activity.note('compact', '远端上下文已压缩')
          } else if (event.kind === 'error') {
            throw new Error(event.message)
          } else if (event.kind === 'result') {
            this.turnOpen = false
            if (this.stopRequested) {
              this.activity.endTurn({ ok: false, costUsd: event.costUsd })
              this.activity.setState('stopped')
              yield { type: 'stopped' }
              return
            }
            if (this.pauseRequested) {
              // Only an interrupt this session asked for counts as a pause. A real
              // error_during_execution without pauseRequested is a failure below.
              this.paused = true
              this.hasTurn = true
              this.activity.endTurn({ paused: true, usage: lastAssistantUsage, costUsd: event.costUsd })
              yield { type: 'paused' }
              return
            }
            if (!event.success) throw new Error(event.text || `Claude Code turn failed (${event.subtype ?? 'unknown'})`)
            if (!streamedText && event.text) yield { type: 'text', text: event.text }
            // result.usage is cumulative across every API call in the turn; the last
            // assistant message is the actual context occupancy DSH should bill/plan on.
            const usage = lastAssistantUsage
            if (usage) yield { type: 'usage', usage }
            this.hasTurn = true
            this.lastUsedAt = Date.now()
            this.activity.endTurn({ ok: true, usage, costUsd: event.costUsd })
            return
          } else if (raw.type === 'bridge_exit') {
            throw new Error(await this.#withErrorTail(`Remote Claude process exited with code ${raw.code ?? 'unknown'}`))
          }
        }
      }
      // The output stream ended without a result: pause/stop raced with the process, or it died.
      if (this.stopRequested) {
        this.turnOpen = false
        this.activity.endTurn({ ok: false })
        this.activity.setState('stopped')
        yield { type: 'stopped' }
        return
      }
      if (this.pauseRequested) {
        this.paused = true
        this.hasTurn = false
        this.turnOpen = false
        this.activity.endTurn({ paused: true })
        yield { type: 'paused' }
        return
      }
      throwIfAborted(signal)
      throw new Error(await this.#withErrorTail('Remote Claude output ended before a result event; no input was replayed'))
    } catch (error) {
      if (this.watchdogFired) {
        this.activity.endTurn({ ok: false })
        const minutes = Math.max(1, Math.round(Number(this.config.turnIdleTimeoutMs ?? 0) / 60000))
        throw codedError(`远端已有 ${minutes} 分钟没有任何输出或事件，已中断本轮（turnIdleTimeoutMs）`, 'TURN_IDLE_TIMEOUT')
      }
      if (signal.aborted) {
        if (this.config.cancelBehavior === 'pause') {
          // Interrupt, then read the output up to the interrupt's result so the byte
          // offset stays aligned and the remote process (and its context) survives.
          // Anything unconfirmed falls back to recycling the process.
          this.pauseRequested = true
          this.activity.setState('pausing')
          await this.#pauseAfterCancel(lastAssistantUsage)
        } else {
          await this.#interruptAndStop().catch(() => {})
        }
        throw abortError(signal)
      }
      this.activity.endTurn({ ok: false })
      throw error
    } finally {
      signal.removeEventListener('abort', closeTail)
      closeTail()
      this.#clearIdleWatchdog()
      this.gateway.clearTurnContext(turnContext)
      this.#clearPauseTimer()
      this.turnOpen = false
      this.turnAbort = undefined
      this.busy = false
    }
  }

  async pause() {
    if (this.disposing) throw codedError('The Remote Claude session was disposed', 'NOT_RUNNING')
    if (!this.busy || !this.turnOpen) throw codedError('No Remote Claude turn is running', 'NOT_RUNNING')
    if (this.pauseRequested) return
    this.pauseRequested = true
    this.activity.setState('pausing')
    // Stop local tool execution immediately; the remote process is interrupted next.
    this.turnAbort?.abort()
    this.pauseTimer = setTimeout(() => {
      void this.#recycle().catch(() => {})
    }, Number(this.config.pauseTimeoutMs ?? PAUSE_TIMEOUT_MS))
    this.pauseTimer.unref?.()
    await this.#append(buildInterruptRequest(randomUUID())).catch(() => {})
  }

  async stop() {
    if (!this.busy) throw codedError('No Remote Claude turn is running', 'NOT_RUNNING')
    this.stopRequested = true
    this.activity.setState('stopped')
    this.turnAbort?.abort()
    await this.#recycle()
  }

  async dispose() {
    if (this.disposing) return this.disposing
    this.lifetime.abort(new Error('Remote Claude session was disposed'))
    this.gateway.clearTurnContext()
    this.disposing = (async () => {
      await this.#stopRemote().catch(() => {})
      await this.#removeRunDir().catch(() => {})
      await this.ssh.dispose().catch(() => {})
      await this.gateway.close().catch(() => {})
    })()
    return this.disposing
  }

  get processAlive() {
    return this.started
  }

  /** True when a cancelled turn left the remote process alive and confirmed paused. */
  get reusable() {
    return this.started && this.paused && !this.disposing
  }

  #recordLedger(raw, contextUsage) {
    if (raw.parent_tool_use_id != null) return
    if (raw.type === 'rate_limit_event') {
      this.ledger?.record(this.dshSessionId, this.runId, { type: 'rate-limit', info: raw.rate_limit_info }, this.purpose)
      this.activity.note('rate-limit', '额度窗口已更新')
    } else if (raw.type === 'result') {
      this.ledger?.record(this.dshSessionId, this.runId, { type: 'statistics', usage: parseClaudeEvent(raw).usage,
        contextUsage, costUsd: raw.total_cost_usd, model: this.resolvedModel || this.model,
        effort: this.reasoningEffort, success: raw.is_error !== true && raw.subtype !== 'error' }, this.purpose)
    }
  }

  async #readErrorTail() {
    if (!this.started || !this.ssh.ready) return ''
    try {
      const command = `${runDirectoryPreamble(this.remoteBaseDir, this.runId)}; tail -c 4096 "$run_dir/err.log" 2>/dev/null || true`
      const result = await this.ssh.exec(command, { signal: AbortSignal.timeout(ERROR_LOG_TIMEOUT_MS) })
      return sanitizeRemoteLog(result.stdout, [this.gateway.token])
    } catch {
      return ''
    }
  }

  async #withErrorTail(message) {
    const tail = await this.#readErrorTail()
    return tail ? `${message}\n--- remote stderr (tail) ---\n${tail}` : message
  }

  async #pauseAfterCancel(contextUsage) {
    // Disposal tears the process down itself; there is nothing to preserve.
    if (this.disposing) return
    const confirmed = this.turnOpen && await this.#interruptAndDrain(contextUsage).catch(() => false)
    if (!confirmed) {
      await this.#recycle().catch(() => {})
      return
    }
    this.paused = true
    this.activity.endTurn({ paused: true })
    this.activity.setState('paused')
  }

  /** Sends interrupt and consumes output through its result; false when it could not be confirmed. */
  async #interruptAndDrain(contextUsage) {
    if (!this.started || !this.ssh.ready) return false
    const deadline = AbortSignal.timeout(Number(this.config.pauseTimeoutMs ?? PAUSE_TIMEOUT_MS))
    await this.#append(buildInterruptRequest(randomUUID()), deadline)
    const parser = new NdjsonCursorParser({ offset: this.offset })
    const tail = await this.#attach(deadline)
    const close = () => tail.close?.()
    deadline.addEventListener('abort', close, { once: true })
    try {
      for await (const chunk of tail) {
        for (const record of parser.push(chunk)) {
          this.offset = record.endOffset
          if (record.kind !== 'event') continue
          const raw = record.event
          if (raw.type === 'bridge_exit') return false
          if (raw.type === 'control_request') {
            await this.#denyControlRequest(raw, deadline)
            continue
          }
          if (raw.parent_tool_use_id != null) continue
          if (raw.type === 'assistant') contextUsage = normalizeUsage(raw.message?.usage) ?? contextUsage
          this.#recordLedger(raw, contextUsage)
          if (raw.type === 'result') return true
        }
      }
      return false
    } finally {
      deadline.removeEventListener('abort', close)
      close()
    }
  }

  #trackInit(raw) {
    this.resolvedModel = raw.model
    this.activity.remote.model = raw.model ?? this.activity.remote.model
    this.activity.remote.version = raw.claude_code_version ?? this.activity.remote.version
    this.#checkProtocolVersion(raw.claude_code_version)
    this.activity.remote.sessionId = this.claudeSessionId
    this.activity.setState('thinking')
  }

  #checkProtocolVersion(version) {
    const parsed = parseClaudeVersion(version)
    if (!parsed) return
    if (compareVersion(parsed, MIN_CLAUDE_VERSION) < 0) {
      throw codedError(`Claude Code ${version} 低于已验证的最低版本 ${MIN_CLAUDE_VERSION.join('.')}，stream-json 协议可能不兼容；请升级远端 Claude Code。`, 'CLAUDE_VERSION_UNSUPPORTED')
    }
    if (parsed[0] > MIN_CLAUDE_VERSION[0]) {
      this.activity.note('protocol', `Claude Code ${version} 高于已验证的主版本，若出现解析异常请先回退版本`, undefined)
    }
  }

  async #recycle() {
    this.pauseRequested = true
    const stoppedRun = this.runId
    await this.#stopRemote().catch(() => {})
    // The remote process is gone: the next turn must start a fresh run and replay DSH history.
    // Its run directory (including the MCP token file) must not outlive it.
    await this.#removeRunDir(stoppedRun).catch(() => {})
    this.runId = randomUUID()
    this.claudeSessionId = randomUUID()
    this.oldRunId = undefined
    this.resume = false
    this.offset = 0
    this.hasTurn = false
    this.started = false
    this.paused = true
    this.activity.note('note', '远端进程已回收，继续时将从 DSH 压缩历史重建')
    this.activity.setState('paused')
  }

  #clearPauseTimer() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.pauseTimer = undefined
  }

  #armIdleWatchdog(onTimeout) {
    const ms = Number(this.config.turnIdleTimeoutMs ?? 0)
    this.#clearIdleWatchdog()
    if (!(ms > 0)) return
    const tick = Math.max(1000, Math.min(WATCHDOG_TICK_MS, Math.floor(ms / 2)))
    this.idleTimer = setInterval(() => {
      if (!this.turnOpen) return
      // A tool that DSH is actively executing locally is not a stalled remote turn.
      if (this.gateway.activeCalls > 0) {
        this.lastRemoteEventAt = Date.now()
        return
      }
      if (Date.now() - this.lastRemoteEventAt < ms) return
      this.watchdogFired = true
      onTimeout()
      this.activity.note('note', `远端超过 ${Math.round(ms / 60000) || 1} 分钟无响应，正在中断`)
      void this.#append(buildInterruptRequest(randomUUID())).catch(() => {})
      this.turnAbort?.abort()
    }, tick)
    this.idleTimer.unref?.()
  }

  #clearIdleWatchdog() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = undefined
  }

  async #canResume(signal) {
    if (!RUN_ID.test(this.oldRunId ?? '')) return false
    await this.ssh.connect(signal)
    const command = `${runDirectoryPreamble(this.remoteBaseDir, this.oldRunId)}; ${exitedRunCheck(true)}`
    const status = await this.ssh.exec(command, { signal })
    // The handoff does not grant this Host ownership of the previous process.
    return status.code === 0
  }

  async #ensureStarted(system, signal) {
    await this.gateway.listen()
    await this.ssh.connect(signal)
    const forward = await this.ssh.reverseForward(this.gateway.address.port, this.remotePort)
    this.remotePort = forward.remotePort
    if (this.started) return
    this.oldRunId = undefined
    const mcp = {
      mcpServers: {
        local_dsh: {
          type: 'http',
          url: `http://127.0.0.1:${this.remotePort}/mcp`,
          headers: { Authorization: `Bearer ${this.gateway.token}` },
        },
      },
    }
    const prompt = [
      system || '',
      'All workspace file, search, editing, terminal, and user-interaction operations must use the local_dsh MCP tools.',
      'Do not claim that a local action succeeded unless its MCP tool result confirms success.',
    ].filter(Boolean).join('\n\n')
    const resume = this.resume && this.hasTurn
    const command = buildCreateRunCommand({
      remoteBaseDir: this.remoteBaseDir,
      runId: this.runId,
      workspaceKey: this.workspaceKey,
      mcpJson: JSON.stringify(mcp),
      systemPrompt: prompt,
      runScript: buildRunScript({
        claudePath: this.config.claudePath,
        claudeSessionId: this.claudeSessionId,
        resumeSessionId: resume ? this.claudeSessionId : undefined,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        restrictedMode: this.config.restrictedMode,
        allowRemoteWebTools: this.config.allowRemoteWebTools,
        remoteBuiltinTools: this.config.remoteBuiltinTools,
      }),
    })
    const created = await this.ssh.exec('bash -s', { signal, input: command })
    if (created.code !== 0) throw new Error(`Failed to create remote Claude run: ${created.stderr.trim() || created.stdout.trim()}`)
    this.started = true
    this.resume = false
    if (resume) this.activity.note('note', '已启动 Claude 会话续接（--resume）')
    // Housekeeping must never delay or fail the turn.
    if (this.sweep) void Promise.resolve().then(() => this.sweep(this.ssh)).catch(() => {})
  }

  async *#readTurnEvents(firstTail, signal) {
    const runId = this.runId
    const limit = this.config.turnReconnectAttempts ?? RECONNECT_ATTEMPTS
    let tail = firstTail
    let parser = new NdjsonCursorParser({ offset: this.offset })
    let iterator = tail[Symbol.asyncIterator]()
    let attempts = 0
    let cause
    const close = () => tail?.close?.()
    signal.addEventListener('abort', close, { once: true })
    try {
      for (;;) {
        throwIfAborted(signal)
        if (this.stopRequested || this.runId !== runId) return
        if (!tail) {
          if (attempts >= limit) {
            const error = new Error(await this.#withErrorTail(`Remote Claude output ended before a result event (${attempts} reconnect attempts); no input was replayed`), { cause })
            error.code = 'TURN_DISCONNECTED'
            throw error
          }
          attempts++
          this.activity.note('note', `与远端的连接中断，正在重连续读（${attempts}/${limit}）`)
          if (attempts > 1) await delay(Math.min(250 * (2 ** Math.min(attempts - 2, 4)), 3000), undefined, { signal })
          try {
            await this.ssh.connect(signal)
            await this.ssh.reverseForward(this.gateway.address.port, this.remotePort)
            if (this.runId !== runId || this.stopRequested) return
            tail = await this.#attach(signal)
            iterator = tail[Symbol.asyncIterator]()
            parser = new NdjsonCursorParser({ offset: this.offset })
          } catch (error) {
            cause = error
            close()
            tail = undefined
            continue
          }
        }
        let step
        try { step = await iterator.next() } catch (error) { cause = error }
        throwIfAborted(signal)
        if (!step || step.done) {
          close()
          tail = undefined
          continue
        }
        // Only channel failures are retried. Parsing, protocol and tool errors propagate.
        for (const record of parser.push(step.value)) {
          this.offset = record.endOffset
          this.lastRemoteEventAt = Date.now()
          if (record.kind === 'event') yield record.event
        }
      }
    } finally {
      signal.removeEventListener('abort', close)
      close()
    }
  }

  async #attach(signal) {
    // GNU tail stops if the detached host dies without writing bridge_exit.
    const command = `${runDirectoryPreamble(this.remoteBaseDir, this.runId)}; pid=$(cat "$run_dir/pid") || exit 1; exec tail --pid="$pid" -c +${this.offset + 1} -F "$run_dir/out.jsonl"`
    return this.ssh.openExec(command, { signal })
  }

  async #append(value, signal) {
    const line = `${JSON.stringify(value)}\n`
    const command = `${runDirectoryPreamble(this.remoteBaseDir, this.runId)}; if test -f "$run_dir/exit" || ! kill -0 "$(cat "$run_dir/pid")" 2>/dev/null; then tail -c 8192 "$run_dir/err.log" >&2; exit 42; fi; cat >> "$run_dir/in.jsonl"`
    const result = await this.ssh.exec(command, { signal, input: line })
    if (result.code !== 0) {
      const detail = sanitizeRemoteLog(result.stderr || result.stdout, [this.gateway.token])
      throw new Error(`Failed to send input to Claude Code: ${detail || 'remote process is no longer running'}`)
    }
  }

  async #denyControlRequest(record, signal) {
    if (!record.request_id) return
    const subtype = record.request?.subtype
    const response = subtype === 'can_use_tool'
      ? { behavior: 'deny', message: 'Use the local_dsh MCP tools so DSH can enforce its own approval policy.' }
      : undefined
    await this.#append({
      type: 'control_response',
      request_id: record.request_id,
      response: response
        ? { subtype: 'success', request_id: record.request_id, response }
        : { subtype: 'error', request_id: record.request_id, error: `Unsupported control request: ${subtype ?? 'unknown'}` },
    }, signal)
  }

  async #interruptAndStop() {
    if (this.started) await this.#append(buildInterruptRequest(randomUUID())).catch(() => {})
    await this.#stopRemote()
  }

  async #stopRunId(runId) {
    if (!RUN_ID.test(runId ?? '') || !this.ssh.ready) return
    const command = `${runDirectoryPreamble(this.remoteBaseDir, runId)}; test ! -L "$run_dir" && test ! -f "$run_dir/exit" || exit 0; pid=$(cat "$run_dir/pid" 2>/dev/null) || exit 0; case "$pid" in ''|0*|1|*[!0-9]*) exit 1;; esac; run_path=$(cd -- "$run_dir" && pwd -P) || exit 0; test "$(readlink -- "/proc/$pid/cwd" 2>/dev/null)" = "$run_path" || exit 0; tr '\\000' '\\n' <"/proc/$pid/cmdline" 2>/dev/null | grep -Fxq './run.sh' || exit 0; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true`
    await this.ssh.exec(command).catch(() => {})
  }

  async #stopRemote() {
    if (!this.started) return
    await this.#stopRunId(this.runId)
    this.started = false
  }

  async #removeRunDir(runId = this.runId) {
    if (!RUN_ID.test(runId ?? '') || !this.ssh.ready) return
    const command = `${runDirectoryPreamble(this.remoteBaseDir, runId)}; for attempt in 1 2 3 4 5; do (${exitedRunCheck(false)}) && { rm -rf -- "$run_dir"; exit; }; sleep 0.1; done`
    await this.ssh.exec(command).catch(() => {})
  }
}

export function buildRunScript({ claudePath, claudeSessionId, resumeSessionId, model, reasoningEffort, restrictedMode, allowRemoteWebTools, remoteBuiltinTools }) {
  const mode = remoteBuiltinTools && remoteBuiltinTools !== 'none' ? remoteBuiltinTools : allowRemoteWebTools ? 'web' : 'none'
  const allowed = mode === 'all'
    ? 'mcp__local_dsh__*,Read,Write,Edit,Glob,Grep,Bash,BashOutput,KillBash,WebSearch,WebFetch,NotebookEdit,TodoWrite,Task,AskUserQuestion'
    : mode === 'web' ? 'mcp__local_dsh__*,WebSearch,WebFetch' : 'mcp__local_dsh__*'
  const args = [
    shellQuote(claudePath), '-p',
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--replay-user-messages',
    ...(resumeSessionId ? ['--resume', shellQuote(resumeSessionId)] : ['--session-id', shellQuote(claudeSessionId)]),
    ...(mode === 'all' ? [] : ['--tools', shellQuote(mode === 'web' ? 'WebSearch,WebFetch' : '')]), '--strict-mcp-config',
    '--mcp-config', '"$HERE/mcp.json"',
    '--allowedTools', shellQuote(allowed),
    '--permission-prompts', 'none',
    '--append-system-prompt-file', '"$HERE/system.txt"',
    '--model', shellQuote(model),
  ]
  if (reasoningEffort && reasoningEffort !== 'default') args.push('--effort', shellQuote(reasoningEffort))
  if (restrictedMode) args.push('--restricted')
  return `#!/usr/bin/env bash
set -uo pipefail
umask 077
HERE=$(cd -- "$(dirname -- "$0")" && pwd) || exit 1
touch "$HERE/in.jsonl" "$HERE/out.jsonl" "$HERE/err.log"
export CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1
exec 3< <(exec tail -n +1 -F "$HERE/in.jsonl")
tailpid=$!
trap 'kill "$tailpid" 2>/dev/null || true' EXIT
# Keep the supervisor in the run directory. Only Claude uses the stable project path.
(cd -- "\${1:-$HERE}" && ${args.join(' ')}) <&3 >>"$HERE/out.jsonl" 2>>"$HERE/err.log"
code=$?
printf '{"type":"bridge_exit","code":%d}\\n' "$code" >>"$HERE/out.jsonl"
printf '%s\\n' "$code" >"$HERE/exit"
exit "$code"
`
}

export function buildCreateRunCommand({ remoteBaseDir, runId, workspaceKey, mcpJson, systemPrompt, runScript }) {
  const workspace = workspaceKey ? `"$base_dir/workspaces/"${shellQuote(workspaceKey)}` : '"$run_dir"'
  const files = [
    ['mcp.json', mcpJson], ['system.txt', systemPrompt], ['run.sh', runScript],
  ].map(([name, content]) => `printf %s ${shellQuote(Buffer.from(content).toString('base64'))} | base64 -d > "$run_dir/${name}"`).join('; ')
  return `set -eu; ${runDirectoryPreamble(remoteBaseDir, runId)}; work_dir=${workspace}; umask 077; mkdir -p -- "$run_dir" "$work_dir"; ${files}; chmod 700 "$run_dir/run.sh"; touch "$run_dir/in.jsonl" "$run_dir/out.jsonl" "$run_dir/err.log"; if ! test -s "$run_dir/pid" || ! kill -0 "$(cat "$run_dir/pid")" 2>/dev/null; then (cd -- "$run_dir"; setsid nohup bash -l ./run.sh "$work_dir" >/dev/null 2>&1 & echo $! >pid); fi`
}

function runDirectoryPreamble(remoteBaseDir, runId) {
  return `base_dir=${remoteBaseExpression(remoteBaseDir)}; run_dir="$base_dir/runs/${runId}"`
}

function exitedRunCheck(allowMissing) {
  return `if test -L "$run_dir"; then exit 1; fi; if test ! -d "$run_dir"; then exit ${allowMissing ? 0 : 1}; fi; if test -f "$run_dir/exit"; then exit 0; fi; pid=$(cat "$run_dir/pid" 2>/dev/null) || exit 1; case "$pid" in ''|0*|1|*[!0-9]*) exit 1;; esac; ! { kill -0 "$pid" 2>/dev/null || kill -0 -- "-$pid" 2>/dev/null; }`
}

function parseClaudeVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}
