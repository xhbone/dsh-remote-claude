import { randomUUID } from 'node:crypto'
import { ActivityLog, summarizeToolArgs } from './activity.js'
import { buildInterruptRequest, buildUserMessage, parseClaudeEvent } from './claude-protocol.js'
import { McpGateway } from './mcp-gateway.js'
import { NdjsonCursorParser } from './ndjson-cursor.js'
import { SshClient } from './ssh-client.js'
import { abortError, remoteBaseExpression, shellQuote, throwIfAborted } from './util.js'

const PAUSE_TIMEOUT_MS = 8000

export class RemoteClaudeSession {
  constructor(ctx, config, { dshSessionId, model, reasoningEffort, ledger, purpose, activity }, {
    ssh = new SshClient(config, {
      resolvePassword: async (ref) => (await ctx.get('credentials')?.resolve(ref))?.value,
    }),
    gateway = new McpGateway(ctx),
  } = {}) {
    this.ctx = ctx
    this.config = config
    this.dshSessionId = dshSessionId
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.ledger = ledger
    this.purpose = purpose ?? ''
    this.activity = activity ?? new ActivityLog()
    this.runId = randomUUID()
    this.claudeSessionId = randomUUID()
    this.offset = 0
    this.started = false
    this.hasTurn = false
    this.busy = false
    this.lastUsedAt = Date.now()
    this.remotePort = 0
    this.ssh = ssh
    this.gateway = gateway
    this.lifetime = new AbortController()
    this.disposing = undefined
    this.resolvedModel = undefined
    this.turnOpen = false
    this.pauseRequested = false
    this.paused = false
    this.stopRequested = false
    this.turnAbort = undefined
    this.pauseTimer = undefined
  }

  async *turn({ prompt, system, tools, agent, signal }) {
    if (this.busy) throw new Error('A Remote Claude turn is already active for this DSH session')
    signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    throwIfAborted(signal)
    this.busy = true
    this.lastUsedAt = Date.now()
    this.paused = false
    this.pauseRequested = false
    this.stopRequested = false
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
    try {
      await this.#ensureStarted(system, signal)
      const parser = new NdjsonCursorParser({ offset: this.offset })
      tail = await this.#attach(signal)
      signal.addEventListener('abort', closeTail, { once: true })
      throwIfAborted(signal)
      await this.#append(buildUserMessage(prompt, randomUUID()), signal)
      this.turnOpen = true
      this.activity.setState('thinking')
      let streamedText = false
      let assistantFallback = ''
      for await (const chunk of tail) {
        throwIfAborted(signal)
        for (const record of parser.push(chunk)) {
          // Commit only events consumed by this turn, not the rest of the chunk.
          this.offset = record.endOffset
          if (record.kind !== 'event') continue
          const raw = record.event
          if (raw.type === 'system' && raw.subtype === 'init') this.#trackInit(raw)
          if (raw.type === 'rate_limit_event') {
            this.ledger?.record(this.dshSessionId, this.runId, { type: 'rate-limit', info: raw.rate_limit_info }, this.purpose)
            this.activity.note('rate-limit', '额度窗口已更新')
          }
          if (raw.type === 'result') {
            this.ledger?.record(this.dshSessionId, this.runId, { type: 'statistics', usage: parseClaudeEvent(raw).usage, costUsd: raw.total_cost_usd,
              model: this.resolvedModel || this.model, effort: this.reasoningEffort, success: raw.is_error !== true }, this.purpose)
          }
          if (raw.type === 'control_request') {
            await this.#denyControlRequest(raw, signal)
            continue
          }
          const event = parseClaudeEvent(raw)
          if (event.kind === 'text-delta') {
            streamedText = true
            this.activity.setState('streaming')
            this.activity.noteText(event.text)
            if (event.text) yield { type: 'text', text: event.text }
          } else if (event.kind === 'thinking-start') {
            this.activity.setState('thinking')
          } else if (event.kind === 'thinking-delta') {
            this.activity.setState('thinking')
            this.activity.noteThinking(event.text)
            if (this.config.showThinking !== false && event.text) yield { type: 'reasoning', text: event.text }
          } else if (event.kind === 'tool-use') {
            this.activity.setState('tool', event.name)
            this.activity.touch()
          } else if (event.kind === 'compact') {
            this.activity.note('compact', '远端上下文已压缩')
          } else if (event.kind === 'assistant-thinking') {
            if (!streamedText) this.activity.noteThinking(event.text)
          } else if (event.kind === 'assistant-text' && !streamedText) {
            assistantFallback += event.text
          } else if (event.kind === 'error') {
            throw new Error(event.message)
          } else if (event.kind === 'result') {
            if (!this.turnOpen && !streamedText && !assistantFallback) continue
            this.turnOpen = false
            if (this.stopRequested) {
              this.activity.endTurn({ ok: false, costUsd: event.costUsd })
              this.activity.setState('stopped')
              yield { type: 'stopped' }
              return
            }
            if (this.pauseRequested || event.interrupted) {
              this.paused = true
              this.activity.endTurn({ paused: true, usage: event.usage, costUsd: event.costUsd })
              yield { type: 'paused' }
              return
            }
            if (!event.success) throw new Error(event.text || `Claude Code turn failed (${event.subtype ?? 'unknown'})`)
            if (!streamedText) {
              const fallback = assistantFallback || event.text
              if (fallback) yield { type: 'text', text: fallback }
            }
            if (event.usage) yield { type: 'usage', usage: event.usage }
            this.hasTurn = true
            this.lastUsedAt = Date.now()
            this.activity.endTurn({ ok: true, usage: event.usage, costUsd: event.costUsd })
            return
          } else if (raw.type === 'bridge_exit') {
            throw new Error(`Remote Claude process exited with code ${raw.code ?? 'unknown'}`)
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
        this.turnOpen = false
        this.activity.endTurn({ paused: true })
        yield { type: 'paused' }
        return
      }
      throwIfAborted(signal)
      throw new Error('Remote Claude output ended before a result event; no input was replayed')
    } catch (error) {
      if (signal.aborted) {
        if (this.config.cancelBehavior === 'pause') {
          // The consumer went away, so the result cannot be observed; interrupt and
          // recycle anyway, then let the next turn replay the DSH history.
          this.pauseRequested = true
          this.activity.setState('pausing')
          await this.#append(buildInterruptRequest(randomUUID())).catch(() => {})
          await this.#recycle().catch(() => {})
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
      await this.ssh.dispose().catch(() => {})
      await this.gateway.close().catch(() => {})
    })()
    return this.disposing
  }

  get processAlive() {
    return this.started
  }

  #trackInit(raw) {
    this.resolvedModel = raw.model
    this.activity.remote.model = raw.model ?? this.activity.remote.model
    this.activity.remote.version = raw.claude_code_version ?? this.activity.remote.version
    this.activity.remote.sessionId = this.claudeSessionId
    this.activity.setState('thinking')
  }

  async #recycle() {
    this.pauseRequested = true
    await this.#stopRemote().catch(() => {})
    // The remote process is gone: the next turn must start a fresh run and replay DSH history.
    this.runId = randomUUID()
    this.claudeSessionId = randomUUID()
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

  async #ensureStarted(system, signal) {
    await this.gateway.listen()
    await this.ssh.connect(signal)
    const forward = await this.ssh.reverseForward(this.gateway.address.port, this.remotePort)
    this.remotePort = forward.remotePort
    if (this.started) return
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
    const command = buildCreateRunCommand({
      remoteBaseDir: this.config.remoteBaseDir,
      runId: this.runId,
      mcpJson: JSON.stringify(mcp),
      systemPrompt: prompt,
      runScript: buildRunScript({
        claudePath: this.config.claudePath,
        claudeSessionId: this.claudeSessionId,
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        restrictedMode: this.config.restrictedMode,
      }),
    })
    const created = await this.ssh.exec('bash -s', { signal, input: command })
    if (created.code !== 0) throw new Error(`Failed to create remote Claude run: ${created.stderr.trim() || created.stdout.trim()}`)
    this.started = true
  }

  async #attach(signal) {
    // GNU tail stops if the detached host dies without writing bridge_exit.
    const command = `${runDirectoryPreamble(this.config.remoteBaseDir, this.runId)}; pid=$(cat "$run_dir/pid") || exit 1; exec tail --pid="$pid" -c +${this.offset + 1} -F "$run_dir/out.jsonl"`
    return this.ssh.openExec(command, { signal })
  }

  async #append(value, signal) {
    const line = `${JSON.stringify(value)}\n`
    const command = `${runDirectoryPreamble(this.config.remoteBaseDir, this.runId)}; if test -f "$run_dir/exit" || ! kill -0 "$(cat "$run_dir/pid")" 2>/dev/null; then tail -c 8192 "$run_dir/err.log" >&2; exit 42; fi; cat >> "$run_dir/in.jsonl"`
    const result = await this.ssh.exec(command, { signal, input: line })
    if (result.code !== 0) throw new Error(`Failed to send input to Claude Code: ${result.stderr.trim() || result.stdout.trim() || 'remote process is no longer running'}`)
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

  async #stopRemote() {
    if (!this.started || !this.ssh.ready) return
    const command = `${runDirectoryPreamble(this.config.remoteBaseDir, this.runId)}; if test ! -f "$run_dir/exit" && test -s "$run_dir/pid"; then pid=$(cat "$run_dir/pid"); case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; fi`
    await this.ssh.exec(command).catch(() => {})
    this.started = false
  }
}

export function buildRunScript({ claudePath, claudeSessionId, model, reasoningEffort, restrictedMode }) {
  const args = [
    shellQuote(claudePath), '-p',
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--session-id', shellQuote(claudeSessionId),
    '--tools', shellQuote(''), '--strict-mcp-config',
    '--mcp-config', '"$HERE/mcp.json"',
    '--allowedTools', shellQuote('mcp__local_dsh__*'),
    '--permission-prompts', 'none',
    '--append-system-prompt-file', '"$HERE/system.txt"',
    '--model', shellQuote(model),
  ]
  if (reasoningEffort && reasoningEffort !== 'default') args.push('--effort', shellQuote(reasoningEffort))
  if (restrictedMode) args.push('--restricted')
  return `#!/usr/bin/env bash
set -uo pipefail
umask 077
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
cd -- "$HERE"
touch in.jsonl out.jsonl err.log
export CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1
exec 3< <(exec tail -n +1 -F in.jsonl)
tailpid=$!
trap 'kill "$tailpid" 2>/dev/null || true' EXIT
${args.join(' ')} <&3 >>out.jsonl 2>>err.log
code=$?
printf '{"type":"bridge_exit","code":%d}\\n' "$code" >>out.jsonl
printf '%s\\n' "$code" >exit
exit "$code"
`
}

export function buildCreateRunCommand({ remoteBaseDir, runId, mcpJson, systemPrompt, runScript }) {
  const files = [
    ['mcp.json', mcpJson], ['system.txt', systemPrompt], ['run.sh', runScript],
  ].map(([name, content]) => `printf %s ${shellQuote(Buffer.from(content).toString('base64'))} | base64 -d > "$run_dir/${name}"`).join('; ')
  return `set -eu; ${runDirectoryPreamble(remoteBaseDir, runId)}; umask 077; mkdir -p -- "$run_dir"; ${files}; chmod 700 "$run_dir/run.sh"; touch "$run_dir/in.jsonl" "$run_dir/out.jsonl" "$run_dir/err.log"; if ! test -s "$run_dir/pid" || ! kill -0 "$(cat "$run_dir/pid")" 2>/dev/null; then (cd -- "$run_dir"; setsid nohup bash -l ./run.sh >/dev/null 2>&1 & echo $! >pid); fi`
}

function runDirectoryPreamble(remoteBaseDir, runId) {
  return `base_dir=${remoteBaseExpression(remoteBaseDir)}; run_dir="$base_dir/runs/${runId}"`
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}
