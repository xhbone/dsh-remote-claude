import { connectionSettings } from './config-api.js'
import { EFFORTS, catalogModels, effortLabel } from './model-catalog.js'
import { accountLimits } from './statistics.js'
import { probeRemote } from './remote-probe.js'

export const RUNTIME_PATH = '/api/remote-claude/runtime'
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const emptyAccount = () => ({ available: false, windows: [], subscriptionType: null, extraUsage: null, updatedAt: null })

export function createRuntimeHandler(ctx, config, ledger, { probe = probeRemote } = {}) {
  let refreshing = false
  let account = emptyAccount()
  let version = null
  // Settings writes reach the live ConfigRef asynchronously, so keep the last
  // discovery result here to answer immediately after a refresh.
  let discovered
  const connection = () => JSON.stringify([config.host, config.port, config.username, config.claudePath, config.knownHostFingerprint])
  return async request => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId && (sessionId.length > 256 || !ctx.agents.get(sessionId))) return json({ code: 'SESSION_UNAVAILABLE' }, 404)
    const snapshot = () => ({
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
      scope: 'host-activation',
    })
    if (request.method === 'GET') return json(snapshot())
    if (request.method !== 'POST' || url.searchParams.get('action') !== 'refresh') return json({ code: 'METHOD_NOT_ALLOWED' }, 405)
    if (refreshing) return json({ code: 'REFRESH_IN_PROGRESS' }, 409)
    refreshing = true
    try {
      request.signal.throwIfAborted()
      const captured = connection()
      const result = await probe(ctx, config, request.signal)
      if (captured !== connection()) return json({ code: 'CONNECTION_CHANGED' }, 409)
      const row = connectionSettings(ctx.settings)
      discovered = result.models
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
      return json(snapshot())
    } catch {
      // SSH/auth provider diagnostics may include private data. Keep them local.
      return json({ code: 'REMOTE_DISCOVERY_FAILED', message: '无法读取远端模型目录与额度；请确认连接可用、远端 python3 与 Claude Code 2.x 正常。' }, 502)
    } finally { refreshing = false }
  }
}
