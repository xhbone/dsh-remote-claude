import { connectionSettings } from './config-api.js'
import { EFFORTS, catalogModels, effortLabel } from './model-catalog.js'
import { accountLimits } from './statistics.js'
import { probeRemote, probeOverConnection } from './remote-probe.js'
import { SshClient } from './ssh-client.js'
import { shellQuote } from './util.js'

export const RUNTIME_PATH = '/api/remote-claude/runtime'
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const emptyAccount = () => ({ available: false, windows: [], subscriptionType: null, extraUsage: null, updatedAt: null })

// Actionable hints for the connection diagnoses. Error text is never returned
// verbatim because SSH/auth failures can embed private material.
export const CONNECTION_HINTS = {
  AUTH_FAILED: '用户名、私钥或密码凭据不正确，或该用户不允许登录。确认后重新保存连接设置。',
  FINGERPRINT_MISMATCH: '远端主机指纹与已确认值不一致。核对下方公钥指纹后，用「确认此指纹」显式更新。',
  HOST_UNREACHABLE: '无法建立 TCP 连接。检查 host/port、远端 sshd 与网络/防火墙。',
  FORWARD_DENIED: 'sshd 禁止远程端口转发（AllowTcpForwarding 需为 yes，且 127.0.0.1 可绑定）。',
  BASH_MISSING: '远端缺少 bash。',
  SETSID_MISSING: '远端缺少 util-linux 的 setsid（Claude 进程需要独立进程组）。',
  TAIL_UNSUPPORTED: '远端 tail 不是 GNU coreutils，缺少 --pid 支持。',
  CLAUDE_NOT_FOUND: '远端 claudePath 不存在或不可执行。填写 claude 可执行文件的绝对路径。',
  CLAUDE_UNRESPONSIVE: 'claude 已启动但未回答控制请求。检查版本（需要 Claude Code 2.x）与登录状态。',
  SSH_CLOSED: 'SSH 连接在操作完成前断开。重试一次。',
  CONNECTION_FAILED: '连接检查失败。',
}

export function classifyConnectionError(error) {
  const message = String(error?.message ?? error ?? 'unknown error').slice(0, 500)
  let code = 'CONNECTION_FAILED'
  if (/fingerprint mismatch/i.test(message)) code = 'FINGERPRINT_MISMATCH'
  else if (/forward|administratively prohibited/i.test(message)) code = 'FORWARD_DENIED'
  else if (/authentication|auth failure|auth failed|all configured authentication methods failed|permission denied|bad password|no such identity|invalid user/i.test(message)) code = 'AUTH_FAILED'
  else if (/timed out|timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|getaddrinfo|ECONNRESET/i.test(message)) code = 'HOST_UNREACHABLE'
  else if (/not ready|closed/i.test(message)) code = 'SSH_CLOSED'
  return { code, message, hint: CONNECTION_HINTS[code] ?? CONNECTION_HINTS.CONNECTION_FAILED }
}

export function healthCommand(claudePath) {
  return [
    `printf 'bash=%s\\n' "$(command -v bash 2>/dev/null)"`,
    `printf 'setsid=%s\\n' "$(command -v setsid 2>/dev/null)"`,
    `printf 'tail=%s\\n' "$(command -v tail 2>/dev/null)"`,
    `printf 'tailver=%s\\n' "$(tail --version 2>/dev/null | head -n 1)"`,
    `printf 'claude=%s\\n' "$(command -v ${shellQuote(claudePath || 'claude')} 2>/dev/null)"`,
  ].join('; ')
}

export function parseHealthOutput(stdout) {
  const values = {}
  for (const line of String(stdout).split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    values[line.slice(0, index)] = line.slice(index + 1).trim()
  }
  const checks = []
  checks.push(values.bash
    ? { id: 'bash', ok: true, message: values.bash }
    : { id: 'bash', ok: false, code: 'BASH_MISSING', message: 'bash not found', hint: CONNECTION_HINTS.BASH_MISSING })
  checks.push(values.setsid
    ? { id: 'setsid', ok: true, message: values.setsid }
    : { id: 'setsid', ok: false, code: 'SETSID_MISSING', message: 'setsid not found', hint: CONNECTION_HINTS.SETSID_MISSING })
  const gnuTail = Boolean(values.tail) && /GNU coreutils/i.test(values.tailver ?? '')
  checks.push(gnuTail
    ? { id: 'tail', ok: true, message: values.tailver || values.tail }
    : { id: 'tail', ok: false, code: 'TAIL_UNSUPPORTED', message: values.tailver || values.tail || 'tail not found', hint: CONNECTION_HINTS.TAIL_UNSUPPORTED })
  checks.push(values.claude
    ? { id: 'claude', ok: true, message: values.claude }
    : { id: 'claude', ok: false, code: 'CLAUDE_NOT_FOUND', message: 'claude executable not found', hint: CONNECTION_HINTS.CLAUDE_NOT_FOUND })
  return checks
}

export function createRuntimeHandler(ctx, config, manager, { probe = probeRemote, createSsh } = {}) {
  const ledger = manager.ledger
  let busy = null
  let account = emptyAccount()
  let version = null
  // Settings writes reach the live ConfigRef asynchronously, so keep the last
  // discovery result here to answer immediately after a refresh.
  let discovered
  const connection = () => JSON.stringify([config.host, config.port, config.username, config.claudePath, config.knownHostFingerprint])
  const makeSsh = () => createSsh?.() ?? new SshClient(config, {
    resolvePassword: async ref => (await ctx.credentials.resolve(ref))?.value,
  })

  const snapshot = (sessionId) => ({
    available: true,
    models: catalogModels(discovered ? { ...config, modelCatalog: JSON.stringify(discovered) } : config),
    efforts: EFFORTS.map(id => ({ id, name: effortLabel(id) })),
    version,
    account,
    // A live remote session may already have reported limits this Host
    // activation, which is fresher than the last discovery probe.
    rateLimit: typeof ledger.latestRateLimit === 'function' ? ledger.latestRateLimit() : null,
    aggregate: typeof ledger.aggregate === 'function' ? ledger.aggregate() : null,
    usage: sessionId ? ledger.get(sessionId) : null,
    pollMs: config.activityPollMs,
    scope: 'host-activation',
  })

  const storeDiscovery = async (result) => {
    discovered = result.models
    const row = connectionSettings(ctx.settings)
    await ctx.settings.update(row.ns, { modelCatalog: JSON.stringify(result.models) }, row.revision)
    const limits = accountLimits(result.usage)
    account = {
      available: Boolean(limits?.available),
      windows: limits?.windows ?? [],
      subscriptionType: limits?.subscriptionType ?? null,
      extraUsage: limits?.extraUsage ?? null,
      updatedAt: new Date().toISOString(),
    }
    version = result.version || null
  }

  const refresh = async (signal) => {
    const captured = connection()
    const result = await probe(ctx, config, signal)
    if (captured !== connection()) return { status: 409, body: { code: 'CONNECTION_CHANGED' } }
    await storeDiscovery(result)
    return { status: 200, body: snapshot() }
  }

  const test = async (signal) => {
    const ssh = makeSsh()
    const checks = []
    let observedFingerprint
    let probeResult
    try {
      await ssh.connect(signal)
      observedFingerprint = ssh.observedFingerprint
      checks.push({ id: 'ssh', ok: true, message: 'SSH 连接成功' })
      const health = await ssh.exec(healthCommand(config.claudePath), { signal, maxBytes: 64 * 1024 })
      checks.push(...parseHealthOutput(health.stdout))
      if (health.code !== 0 && health.code !== 127) {
        checks.push({ id: 'shell', ok: false, code: 'CONNECTION_FAILED', message: health.stderr.trim().slice(0, 300) || `exit ${health.code}` })
      }
      try {
        await ssh.testForward()
        checks.push({ id: 'forward', ok: true, message: 'ssh 端口转发可用' })
      } catch (error) {
        checks.push({ id: 'forward', ok: false, ...safeDiagnosis(classifyConnectionError(error)) })
      }
      try {
        probeResult = await probeOverConnection(ssh, config, signal)
        checks.push({ id: 'claude_probe', ok: true, message: `Claude ${probeResult.version ?? '2.x'}` })
      } catch (error) {
        checkProbeFailure(checks, error)
      }
    } catch (error) {
      const classified = classifyConnectionError(error)
      checks.unshift({ id: 'ssh', ok: false, ...safeDiagnosis(classified) })
    } finally {
      await ssh.dispose().catch(() => {})
    }
    if (probeResult) {
      try { await storeDiscovery(probeResult) } catch {}
    }
    return {
      status: 200,
      body: {
        available: true,
        ok: checks.every(check => check.ok),
        checks,
        observedFingerprint: observedFingerprint ?? null,
        version: probeResult?.version ?? version,
        models: probeResult?.models ? probeResult.models : undefined,
        account,
      },
    }
  }

  return async request => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId && (sessionId.length > 256 || !ctx.agents.get(sessionId))) return json({ code: 'SESSION_UNAVAILABLE' }, 404)
    if (request.method === 'GET') return json(snapshot(sessionId))
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405)
    const action = url.searchParams.get('action')
    if (busy) return json({ code: `${busy.toUpperCase()}_IN_PROGRESS` }, 409)
    try {
      request.signal.throwIfAborted()
      if (action === 'refresh') {
        busy = 'refresh'
        return json(...wrap(await refresh(request.signal)))
      }
      if (action === 'test') {
        busy = 'test'
        return json(...wrap(await test(request.signal)))
      }
      if (action === 'cleanup') {
        busy = 'cleanup'
        const result = await manager.cleanupRemoteRuns()
        return json({ available: true, ok: true, ...result })
      }
      return json({ code: 'UNKNOWN_ACTION' }, 400)
    } catch (error) {
      if (error?.name === 'AbortError') return json({ code: 'ABORTED' }, 499)
      const classified = classifyConnectionError(error)
      return json({
        code: classified.code === 'CONNECTION_FAILED' ? `${action?.toUpperCase() ?? 'RUNTIME'}_FAILED` : classified.code,
        message: safeDiagnosis(classified).message,
        hint: classified.hint,
        ...(action === 'test' ? { checks: [{ id: 'ssh', ok: false, ...safeDiagnosis(classified) }] } : {}),
      }, 502)
    } finally { busy = null }
  }
}

// Never echo raw SSH/auth errors: they can embed usernames, paths or key material.
function safeDiagnosis(classified) {
  return {
    code: classified.code,
    message: CONNECTION_HINTS[classified.code] ?? '连接检查失败',
    hint: CONNECTION_HINTS[classified.code] ?? CONNECTION_HINTS.CONNECTION_FAILED,
  }
}

function wrap(result) {
  if (result.status === 200) return [result.body, 200]
  return [result.body, result.status]
}

function checkProbeFailure(checks, error) {
  const message = String(error?.message ?? error)
  const code = /timeout|timed out/i.test(message)
    ? 'CLAUDE_UNRESPONSIVE'
    : (/not ready|closed/i.test(message) ? 'SSH_CLOSED' : 'CLAUDE_UNRESPONSIVE')
  checks.push({
    id: 'claude_probe',
    ok: false,
    code,
    message: message.slice(0, 300),
    hint: code === 'SSH_CLOSED' ? CONNECTION_HINTS.SSH_CLOSED : CONNECTION_HINTS.CLAUDE_UNRESPONSIVE,
  })
}
