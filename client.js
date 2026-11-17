// Client entry uses the same module-loader format as bundled Harness extensions.
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-claude',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const DEFAULT_REF = 'DSH_REMOTE_CLAUDE_SSH_PASSWORD'
    const connectionFields = [
      ['host', 'VPS 地址'], ['port', 'SSH 端口', 'number'], ['username', 'SSH 用户'],
      ['knownHostFingerprint', '已核对的 SHA256 主机指纹'],
      ['claudePath', '远端 Claude 路径'],
      ['passwordRef', '密码凭据引用名'], ['privateKeyPath', '本机私钥路径（可选）'],
      ['agent', 'SSH agent socket（可选）'],
    ]
    const defaults = { host: '', port: 22, username: '', knownHostFingerprint: '',
      claudePath: 'claude', claudeModel: 'sonnet', reasoningEffort: 'default', customModels: '',
      passwordRef: DEFAULT_REF, privateKeyPath: '', agent: '' }
    const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
    const EFFORT_LABELS = { default: '默认（交给远端）', low: '低 low', medium: '中 medium', high: '高 high', xhigh: '极高 xhigh', max: '最大 max' }
    const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid var(--color-border, #ccc)', borderRadius: 6, color: 'inherit', background: 'transparent' }
    const cardStyle = { border: '1px solid var(--color-border, #ddd)', borderRadius: 8, padding: 12, display: 'grid', gap: 10 }
    const hintStyle = { margin: 0, opacity: 0.72, fontSize: 12 }

    function createConnectionApi(fetcher = fetch) {
      async function request(method, body) {
        const response = await fetcher('/api/remote-claude/connection', {
          method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        })
        const value = await response.json()
        if (!response.ok || !value.available || !Number.isSafeInteger(value.revision)) throw new Error(value.code || 'Connection unavailable')
        return value
      }
      return { read: () => request('GET'), save: (patch, password, revision) => request('POST', { patch, password, revision }) }
    }

    function createRuntimeApi(fetcher = fetch) {
      async function request(method, sessionId, action) {
        const query = new URLSearchParams()
        if (sessionId) query.set('sessionId', sessionId)
        if (action) query.set('action', action)
        const suffix = query.toString() ? `?${query}` : ''
        const response = await fetcher('/api/remote-claude/runtime' + suffix, {
          method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        })
        const value = await response.json().catch(() => ({}))
        if (!response.ok) {
          const error = new Error(value.code || 'RuntimeUnavailable')
          error.code = value.code
          error.detail = value.message
          throw error
        }
        return value
      }
      return { read: (sessionId) => request('GET', sessionId), refresh: () => request('POST', undefined, 'refresh') }
    }

    function runtimeFailure(error) {
      if (error?.code === 'REMOTE_DISCOVERY_FAILED') return '无法读取远端模型目录与额度：请确认 VPS 可达、远端用户可运行 python3，且 Claude Code 2.x 正常；先在下方保存连接再刷新。'
      if (error?.code === 'CONNECTION_CHANGED') return '刷新期间连接配置发生变化，请重新刷新。'
      if (error?.code === 'REFRESH_IN_PROGRESS') return '上一次刷新还在进行，请稍候。'
      return '无法读取运行时信息，请确认 Host 插件已启用。'
    }

    function customModelTokens(value) {
      return String(value || '').split(',').join(' ').split(' ').filter(Boolean)
    }

    function percentText(value) {
      return typeof value === 'number' ? `${Math.round(value * 10) / 10}%` : '—'
    }

    function resetText(value) {
      if (!value) return ''
      const time = new Date(value)
      return Number.isNaN(time.getTime()) ? '' : ` · ${time.toLocaleString('zh-CN', { hour12: false })} 重置`
    }

    function tone(value) {
      if (typeof value !== 'number') return '#8a8a8a'
      if (value >= 90) return '#d33d3d'
      if (value >= 70) return '#d98600'
      return '#2f8f4e'
    }

    function quotaRows(account, rateLimit) {
      const windows = account?.windows?.length ? account.windows : rateLimit?.windows ?? []
      if (!windows.length) return null
      return windows.map(window => h('div', { key: window.id, style: { display: 'grid', gap: 4 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 } },
          h('span', null, window.label),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, percentText(window.utilization))),
        h('div', { style: { height: 6, borderRadius: 3, background: 'var(--color-border, #e2e2e2)', overflow: 'hidden' } },
          h('div', { style: { width: `${Math.min(100, Math.max(0, window.utilization ?? 0))}%`, height: '100%', background: tone(window.utilization) } })),
        window.resetsAt ? h('p', { style: { ...hintStyle, margin: 0 } }, resetText(window.resetsAt).replace(' · ', '')) : null))
    }

    function ConnectionForm({ ctx, view }) {
      const [config, setConfig] = useState(defaults)
      const [revision, setRevision] = useState()
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState(false)
      const [ready, setReady] = useState(false)
      const [message, setMessage] = useState('正在读取连接配置…')
      const [models, setModels] = useState([])
      const [version, setVersion] = useState(null)
      const [account, setAccount] = useState(null)
      const [rateLimit, setRateLimit] = useState(null)
      const [aggregate, setAggregate] = useState(null)
      const [runtimeBusy, setRuntimeBusy] = useState(false)
      const [runtimeMessage, setRuntimeMessage] = useState('正在读取远端模型目录与额度…')
      const [manualModel, setManualModel] = useState(false)

      useEffect(() => {
        let mounted = true
        Promise.resolve().then(() => createConnectionApi().read()).then((snapshot) => {
          if (!mounted) return
          const value = { ...defaults, ...snapshot.value, passwordRef: snapshot.value.passwordRef || DEFAULT_REF }
          setConfig(value)
          setRevision(snapshot.revision)
          setReady(snapshot.writable)
          setMessage(snapshot.writable ? '' : '当前配置只读。')
          setManualModel(!['sonnet', 'opus', 'haiku', 'fable'].includes(String(value.claudeModel || '')))
        }).catch(() => { if (mounted) setMessage('无法读取连接配置，请确认 Host 插件已启用后重试。') })
        Promise.resolve().then(() => createRuntimeApi().read()).then((snapshot) => {
          if (!mounted) return
          setModels(Array.isArray(snapshot.models) ? snapshot.models : [])
          setVersion(snapshot.version || null)
          setAccount(snapshot.account || null)
          setRateLimit(snapshot.rateLimit || null)
          setAggregate(snapshot.aggregate || null)
          setRuntimeMessage(snapshot.account?.available ? '' : '尚未刷新；点击「刷新模型与额度」从远端读取。')
        }).catch((error) => { if (mounted) setRuntimeMessage(runtimeFailure(error)) })
        return () => { mounted = false }
      }, [])

      if (view === 'summary') return '通过 SSH 连接 VPS Claude Code，支持模型目录、思考强度与账号额度。'

      const modelIds = models.map(row => row.id)
      const selected = models.find(row => row.id === config.claudeModel)
      const efforts = Array.isArray(selected?.efforts) ? selected.efforts : []
      const effortEnabled = efforts.length > 0
      const effortValue = EFFORTS.includes(config.reasoningEffort) ? config.reasoningEffort : 'default'
      const windows = quotaRows(account, rateLimit)

      function update(key, value) {
        setConfig(previous => ({ ...previous, [key]: value }))
      }

      async function refreshQuota() {
        if (runtimeBusy) return
        setRuntimeBusy(true)
        setRuntimeMessage('正在刷新远端模型目录与额度（不发送用户消息，不消耗额度）…')
        try {
          const snapshot = await createRuntimeApi().refresh()
          setModels(Array.isArray(snapshot.models) ? snapshot.models : [])
          setVersion(snapshot.version || null)
          setAccount(snapshot.account || null)
          setRateLimit(snapshot.rateLimit || null)
          setAggregate(snapshot.aggregate || null)
          setRuntimeMessage(`已刷新 · Claude Code ${snapshot.version || '未知版本'} · ${snapshot.models?.length ?? 0} 个模型`)
        } catch (error) {
          setRuntimeMessage(runtimeFailure(error))
        } finally { setRuntimeBusy(false) }
      }

      async function save(event) {
        event.preventDefault()
        if (busy || !ready) return
        const ref = String(config.passwordRef || '').trim()
        const port = Number(config.port)
        const claudeModel = String(config.claudeModel || '').trim()
        if (!config.host.trim() || !config.username.trim() || !Number.isInteger(port) || port < 1 || port > 65535 ||
            !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(config.knownHostFingerprint.trim())) {
          setMessage('请填写地址、用户、有效端口和已核对的 SHA256 主机指纹。'); return
        }
        if (ref && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
          setMessage('凭据引用名只能包含字母、数字和下划线，且不能以数字开头。'); return
        }
        if ((ref || password) && (config.privateKeyPath.trim() || config.agent.trim())) {
          setMessage('密码认证与私钥/SSH agent 互斥；使用密钥时请清空密码凭据引用名。'); return
        }
        if (password && !ref) { setMessage('请为密码填写凭据引用名。'); return }
        if (!claudeModel || /\s/.test(claudeModel)) { setMessage('请选择模型，或填写不含空白的完整模型 ID。'); return }
        if (!EFFORTS.includes(String(config.reasoningEffort || 'default'))) { setMessage('思考强度取值无效，请从列表中选择。'); return }
        const custom = customModelTokens(config.customModels)
        if (custom.length > 100) { setMessage('自定义模型 ID 最多 100 个。'); return }
        setBusy(true)
        setMessage('正在保存连接配置…')
        try {
          const patch = Object.fromEntries(connectionFields.map(([key]) => [key, key === 'port' ? port : String(config[key] ?? '').trim()]))
          Object.assign(patch, {
            claudeModel,
            reasoningEffort: effortEnabled ? effortValue : 'default',
            customModels: custom.join(' '),
          })
          const row = await createConnectionApi().save(patch, password, revision)
          setPassword('')
          setRevision(row.revision)
          setMessage('已保存。模型与思考强度在新建或重建远端会话时生效；额度可通过「刷新模型与额度」重新读取。')
        } catch {
          setMessage('保存失败：请检查凭据是否已填写、配置是否仍可写；若配置已被其他页面修改，请重新打开本页。')
        } finally { setPassword(''); setBusy(false) }
      }

      return h('form', { onSubmit: save, style: { maxWidth: 720, display: 'grid', gap: 14, padding: '16px 0' } },
        h('h3', { style: { margin: 0 } }, 'Remote Claude 连接设置'),
        h('p', { style: { margin: 0 } }, '密码只写入 DSH 凭据存储；此页面不会读取或显示已保存的密码。使用私钥时清空密码引用名。'),

        ...connectionFields.slice(0, 5).map(([key, label, type]) => h('label', { key, style: { display: 'grid', gap: 4 } }, label,
          h('input', { 'aria-label': label, type: type || 'text', value: config[key] ?? '', disabled: busy || !ready,
            autoComplete: 'off', style: inputStyle,
            onChange: (event) => update(key, event.target.value) }))),

        h('div', { style: cardStyle },
          h('strong', null, '模型与思考强度'),
          manualModel
            ? h('label', { style: { display: 'grid', gap: 4 } }, '模型 ID（完整 ID 或别名）',
              h('input', { 'aria-label': '模型 ID', value: config.claudeModel, disabled: busy || !ready, autoComplete: 'off', style: inputStyle,
                onChange: (event) => update('claudeModel', event.target.value) }))
            : h('label', { style: { display: 'grid', gap: 4 } }, '模型',
              h('select', { 'aria-label': '模型', value: config.claudeModel, disabled: busy || !ready || !models.length, style: inputStyle,
                onChange: (event) => update('claudeModel', event.target.value) },
                models.length === 0 ? [h('option', { key: 'none', value: '' }, '请先刷新模型目录')] : null,
                models.map(row => h('option', { key: row.id, value: row.id },
                  row.resolvedModel && row.resolvedModel !== row.id ? `${row.name} · ${row.resolvedModel}` : row.name)),
                modelIds.length && !modelIds.includes(config.claudeModel)
                  ? h('option', { key: 'current', value: config.claudeModel }, `当前值：${config.claudeModel}`) : null)),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 } },
            h('input', { type: 'checkbox', checked: manualModel, disabled: busy || !ready,
              onChange: (event) => setManualModel(event.target.checked) }),
            '手动输入模型 ID'),
          h('label', { style: { display: 'grid', gap: 4 } }, '思考强度（默认档位）',
            h('select', { 'aria-label': '思考强度', value: effortEnabled ? effortValue : 'default', disabled: busy || !ready || !effortEnabled, style: inputStyle,
              onChange: (event) => update('reasoningEffort', event.target.value) },
              ['default', ...efforts].filter((id, index, list) => list.indexOf(id) === index)
                .map(id => h('option', { key: id, value: id }, EFFORT_LABELS[id] || id)))),
          h('p', { style: hintStyle },
            effortEnabled
              ? '保存后以 --effort 传给远端 CLI；会话 composer 里的思考强度选择会覆盖此默认值。'
              : '该模型没有上报思考档位（可能是旧模型或尚未刷新目录）；保存时不会传 --effort。'),
          h('label', { style: { display: 'grid', gap: 4 } }, '额外模型 ID（可选，逗号或空格分隔）',
            h('input', { 'aria-label': '额外模型 ID', value: config.customModels ?? '', disabled: busy || !ready, autoComplete: 'off', style: inputStyle,
              onChange: (event) => update('customModels', event.target.value) }))),

        h('div', { style: cardStyle },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('strong', null, '账号额度'),
            h('span', { style: { ...hintStyle, fontSize: 12 } },
              [account?.subscriptionType ? `订阅 ${account.subscriptionType}` : null,
               version ? `Claude Code ${version}` : null,
               account?.updatedAt ? `读取于 ${new Date(account.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '未读取'].filter(Boolean).join(' · '))),
          windows ?? h('p', { style: hintStyle }, runtimeBusy ? '正在读取…' : '尚未读取账号额度。'),
          aggregate && aggregate.sessions
            ? h('p', { style: hintStyle }, `本次 Host 激活累计：${aggregate.sessions} 个远端会话 / ${aggregate.turns} 轮 / 输入 ${aggregate.totals.inputTokens} tokens / 输出 ${aggregate.totals.outputTokens} tokens / 成本 $${(aggregate.costUsd || 0).toFixed(4)}（含缓存读写）`)
            : null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { type: 'button', disabled: runtimeBusy || !ready, onClick: refreshQuota, style: { ...inputStyle, width: 'auto', cursor: 'pointer' } },
              runtimeBusy ? '正在刷新…' : '刷新模型与额度'),
            h('span', { style: hintStyle }, '刷新使用已保存的连接配置；只发只读控制请求，不发送用户消息。')),
          runtimeMessage ? h('p', { role: 'status', style: { margin: 0, overflowWrap: 'anywhere' } }, runtimeMessage) : null),

        ...connectionFields.slice(5).map(([key, label, type]) => h('label', { key, style: { display: 'grid', gap: 4 } }, label,
          h('input', { 'aria-label': label, type: type || 'text', value: config[key] ?? '', disabled: busy || !ready,
            autoComplete: 'off', style: inputStyle,
            onChange: (event) => update(key, event.target.value) }))),

        h('label', { style: { display: 'grid', gap: 4 } }, 'SSH 密码（留空保留已保存的凭据）',
          h('input', { 'aria-label': 'SSH 密码', type: 'password', autoComplete: 'new-password', value: password,
            disabled: busy || !ready, style: inputStyle, onChange: (event) => setPassword(event.target.value) })),
        h('button', { type: 'submit', disabled: busy || !ready, style: { ...inputStyle, cursor: 'pointer', width: 'auto', justifySelf: 'start' } }, busy ? '正在保存…' : '保存 Remote Claude 连接'),
        h('p', { role: 'status', style: { margin: 0, overflowWrap: 'anywhere' } }, message))
    }

    return {
      createConnectionApi,
      createRuntimeApi,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: '@local/dsh-remote-claude' },
          (props) => h(ConnectionForm, { ...props, ctx })))
      },
    }
  },
})
