export const CONNECTION_PATH = '/api/remote-claude/connection'
import { EFFORTS, validModelId } from './model-catalog.js'
export const CONNECTION_FIELDS = ['host', 'port', 'username', 'knownHostFingerprint', 'claudePath', 'claudeModel', 'passwordRef', 'privateKeyPath', 'agent', 'reasoningEffort', 'customModels', 'activityPanel', 'showThinking', 'showSubagentText', 'pauseHint', 'stopHint', 'pauseTimeoutMs', 'activityPollMs', 'cancelBehavior', 'remoteBaseDir', 'idleSessionMs', 'connectTimeoutMs', 'restrictedMode', 'auxiliaryModel', 'turnIdleTimeoutMs', 'turnReconnectAttempts', 'allowRemoteWebTools', 'remoteBuiltinTools', 'retentionDays']
const OPTIONAL_FIELDS = new Set(['reasoningEffort', 'customModels', 'activityPanel', 'showThinking', 'showSubagentText', 'pauseHint', 'stopHint', 'pauseTimeoutMs', 'activityPollMs', 'cancelBehavior', 'remoteBaseDir', 'idleSessionMs', 'connectTimeoutMs', 'restrictedMode', 'auxiliaryModel', 'turnIdleTimeoutMs', 'turnReconnectAttempts', 'allowRemoteWebTools', 'remoteBuiltinTools', 'retentionDays'])
const BOOLEAN_FIELDS = new Set(['activityPanel', 'showThinking', 'showSubagentText', 'restrictedMode', 'allowRemoteWebTools'])
const NUMBER_FIELDS = new Set(['port', 'pauseTimeoutMs', 'activityPollMs', 'idleSessionMs', 'connectTimeoutMs', 'turnIdleTimeoutMs', 'turnReconnectAttempts', 'retentionDays'])
const DEFAULT_VALUES = { reasoningEffort: 'default', customModels: '', activityPanel: true, showThinking: true, showSubagentText: true, pauseHint: '', stopHint: '', pauseTimeoutMs: 8000, activityPollMs: 1500, cancelBehavior: 'stop', remoteBaseDir: '.dsh-remote-claude', idleSessionMs: 1800000, connectTimeoutMs: 20000, restrictedMode: true, auxiliaryModel: 'haiku', turnIdleTimeoutMs: 300000, turnReconnectAttempts: 5, allowRemoteWebTools: false, remoteBuiltinTools: 'none', retentionDays: 7 }
const REF = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const RECONNECT_FIELDS = ['host', 'port', 'username', 'knownHostFingerprint', 'claudePath', 'passwordRef', 'privateKeyPath', 'agent', 'remoteBaseDir', 'restrictedMode', 'remoteBuiltinTools', 'allowRemoteWebTools']

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}

export function connectionSettings(settings) {
  const rows = settings.describe({ redactSecrets: true }).filter(row => String(row.ns).split(':').at(-1) === 'remote-claude-host')
  if (rows.length !== 1) throw new Error('Connection settings unavailable')
  return rows[0]
}

export function validateConnectionPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !CONNECTION_FIELDS.includes(key))) throw new Error('Invalid connection fields')
  for (const key of CONNECTION_FIELDS) {
    const value = patch[key]
    if (value === undefined && OPTIONAL_FIELDS.has(key)) continue
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== 'boolean') throw new Error('Invalid connection field')
      continue
    }
    if (NUMBER_FIELDS.has(key)) {
      if (!Number.isInteger(value)) throw new Error('Invalid connection field')
      continue
    }
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error('Invalid connection field')
  }
  if (!patch.host || !patch.username || !patch.claudePath || !patch.claudeModel || !Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535 || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(patch.knownHostFingerprint)) throw new Error('Invalid connection address or fingerprint')
  if (!validModelId(patch.claudeModel) || (patch.reasoningEffort !== undefined && !['default', ...EFFORTS].includes(patch.reasoningEffort))) throw new Error('Invalid model or effort')
  if (String(patch.customModels || '').split(/[\s,]+/u).filter(Boolean).some(id => !validModelId(id))) throw new Error('Invalid custom model IDs')
  if (patch.pauseTimeoutMs !== undefined && (patch.pauseTimeoutMs < 500 || patch.pauseTimeoutMs > 60000)) throw new Error('Invalid pause timeout')
  if (patch.activityPollMs !== undefined && (patch.activityPollMs < 500 || patch.activityPollMs > 60000)) throw new Error('Invalid activity poll interval')
  if (patch.idleSessionMs !== undefined && (patch.idleSessionMs < 30000 || patch.idleSessionMs > 86400000)) throw new Error('Invalid idle session timeout')
  if (patch.connectTimeoutMs !== undefined && (patch.connectTimeoutMs < 1000 || patch.connectTimeoutMs > 120000)) throw new Error('Invalid connect timeout')
  if (patch.turnIdleTimeoutMs !== undefined && (patch.turnIdleTimeoutMs < 0 || patch.turnIdleTimeoutMs > 3600000)) throw new Error('Invalid turn idle timeout')
  if (patch.cancelBehavior !== undefined && !['stop', 'pause'].includes(patch.cancelBehavior)) throw new Error('Invalid cancel behavior')
  if (patch.remoteBuiltinTools !== undefined && !['none', 'web', 'all'].includes(patch.remoteBuiltinTools)) throw new Error('Invalid remote builtin tools mode')
  if (patch.turnReconnectAttempts !== undefined && (patch.turnReconnectAttempts < 0 || patch.turnReconnectAttempts > 20)) throw new Error('Invalid reconnect attempts')
  if (patch.remoteBaseDir !== undefined) {
    const dir = String(patch.remoteBaseDir)
    if (!dir || dir.length > 1024 || /\0|\r|\n/u.test(dir) || dir.split('/').some((part) => part === '..') || /^-/u.test(dir)) throw new Error('Invalid remote base directory')
  }
  if (patch.auxiliaryModel !== undefined && patch.auxiliaryModel !== '' && !validModelId(patch.auxiliaryModel)) throw new Error('Invalid auxiliary model')
  if (patch.retentionDays !== undefined && (patch.retentionDays < 0 || patch.retentionDays > 3650)) throw new Error('Invalid retention days')
  if (patch.passwordRef && !REF.test(patch.passwordRef)) throw new Error('Invalid credential reference')
  if (patch.passwordRef && (patch.privateKeyPath || patch.agent) || patch.privateKeyPath && patch.agent) throw new Error('Mixed SSH authentication')
  if (!patch.passwordRef && !patch.privateKeyPath && !patch.agent) throw new Error('SSH authentication is required')
}

// Registered on Connection.fetch: authentication and Host/Origin admission are
// owned by the existing DSH carrier, including Desktop's native transport.
export function createConnectionHandler(ctx, afterSave = async () => {}) {
  let saving = false
  const read = async () => {
    const row = connectionSettings(ctx.settings)
    const value = Object.fromEntries(CONNECTION_FIELDS.map(key => [key, row.value[key] === undefined ? DEFAULT_VALUES[key] : row.value[key]]))
    const credentialConfigured = value.passwordRef ? Boolean(await ctx.credentials.resolve(value.passwordRef)) : false
    return { available: true, writable: true, revision: row.revision, value, credentialConfigured }
  }
  return async request => {
    request.signal.throwIfAborted()
    if (request.method === 'GET') {
      try { return json(await read()) } catch { return json({ code: 'SETTINGS_UNAVAILABLE' }, 503) }
    }
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405)
    if (saving) return json({ code: 'SAVE_IN_PROGRESS' }, 409)
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return json({ code: 'INVALID_CONTENT_TYPE' }, 415)
    let body
    try {
      const text = await request.text()
      request.signal.throwIfAborted()
      if (Buffer.byteLength(text) > 32768) return json({ code: 'BODY_TOO_LARGE' }, 413)
      body = JSON.parse(text)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['patch', 'password', 'revision'].includes(key)) || typeof body.password !== 'string' || body.password.length > 16384 || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Invalid save')
      validateConnectionPatch(body.patch)
      if (body.password && !body.patch.passwordRef) throw new Error('Missing credential reference')
    } catch { return json({ code: 'INVALID_CONNECTION' }, 400) }
    saving = true
    try {
      const row = connectionSettings(ctx.settings)
      if (row.revision !== body.revision) return json({ code: 'SETTINGS_CONFLICT' }, 409)
      request.signal.throwIfAborted()
      if (body.password) await ctx.credentials.set(body.patch.passwordRef, body.password)
      if (body.patch.passwordRef && !await ctx.credentials.resolve(body.patch.passwordRef)) return json({ code: 'CREDENTIAL_NOT_CONFIGURED' }, 400)
      request.signal.throwIfAborted()
      const reconnect = Boolean(body.password) || RECONNECT_FIELDS.some(key =>
        Object.hasOwn(body.patch, key) && body.patch[key] !== (row.value[key] ?? DEFAULT_VALUES[key] ?? ''))
      await ctx.settings.update(row.ns, body.patch, body.revision)
      await afterSave({ reconnect })
      return json(await read())
    } catch {
      // Provider errors can contain sensitive diagnostics; never reflect them.
      return json({ code: 'CONNECTION_SAVE_FAILED' }, 409)
    } finally {
      body.password = ''
      saving = false
    }
  }
}
