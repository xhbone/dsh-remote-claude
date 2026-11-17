const SNAPSHOT_PATH = '/api/remote-claude/activity'
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/**
 * Local, zero-cost control surface for one DSH session: read what the remote
 * Claude session is doing right now, and pause or stop it. It never sends a
 * user message to the remote, so polling costs no quota.
 */
export function createActivityHandler(ctx, config, manager) {
  return async (request) => {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return json({ code: 'BAD_REQUEST' }, 400)
    }
    const queried = url.searchParams.get('sessionId')
    if (queried && (queried.length > 256 || !ctx.agents.get(queried))) return json({ code: 'SESSION_UNAVAILABLE' }, 404)
    if (!config.activityPanel && request.method === 'GET') return json({ available: false, reason: 'DISABLED' })
    if (request.method === 'GET') {
      if (!queried) return json({ code: 'SESSION_REQUIRED' }, 400)
      const activity = manager.activityFor(queried)
      if (!activity) return json({ available: false, sessionId: queried })
      return json({ available: true, sessionId: queried, activity: activity.snapshot(), usage: manager.ledger?.get(queried) ?? null })
    }
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405)
    let body
    try {
      body = await request.json()
    } catch {
      return json({ code: 'BAD_REQUEST' }, 400)
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (!sessionId || sessionId.length > 256 || !ctx.agents.get(sessionId)) return json({ code: 'SESSION_UNAVAILABLE' }, 404)
    const action = body?.action
    try {
      if (action === 'pause') return json({ available: true, sessionId, activity: await manager.pause(sessionId) })
      if (action === 'stop') return json({ available: true, sessionId, activity: await manager.stopSession(sessionId) })
      return json({ code: 'UNKNOWN_ACTION' }, 400)
    } catch (error) {
      if (error?.code === 'NOT_RUNNING') return json({ code: 'NOT_RUNNING' }, 409)
      return json({ code: 'CONTROL_FAILED' }, 500)
    }
  }
}

export { SNAPSHOT_PATH }
