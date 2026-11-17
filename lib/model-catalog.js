export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT_NAMES = { default: '默认', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' }
export const EFFORT_DESCRIPTIONS = {
  default: '不传 --effort，使用远端 Claude Code 的模型默认档位。',
  low: '最快、最省额度，适合简单改动。',
  medium: '默认平衡档位。',
  high: '更多内部推理，适合多步修改。',
  xhigh: '更长的内部推理，适合复杂重构。',
  max: '最大推理预算，最慢也最耗额度。',
}
// Model ids reach the remote argv, so reject anything with whitespace or
// control characters. Scanned by code point to keep the source escape-free.
export function validModelId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f) return false
  }
  return true
}

export function splitModelList(value) {
  const items = []
  let current = ''
  for (const char of String(value || '')) {
    if (char === ',' || char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (current) items.push(current)
      current = ''
    } else current += char
  }
  if (current) items.push(current)
  return items
}

const EFFORT_ALIASES = { minimal: 'low', balanced: 'medium', extended: 'high' }

export function effortLabel(id) {
  return EFFORT_NAMES[id] || id
}

export function normalizeEfforts(values) {
  if (!Array.isArray(values)) return undefined
  const levels = [...new Set(values
    .map(level => EFFORT_ALIASES[level] ?? level)
    .filter(level => EFFORTS.includes(level)))]
  return levels.length ? levels : undefined
}

// The remote CLI owns the catalog; ids stay verbatim so the CLI remains the
// authority on aliases and version numbers. Each alias also contributes its
// resolved version id when the CLI reports one.
export function normalizeModels(values) {
  const items = new Map()
  for (const row of (Array.isArray(values) ? values : []).slice(0, 100)) {
    if (!row || !validModelId(row.value ?? row.id)) continue
    const id = row.value ?? row.id
    const resolvedModel = validModelId(row.resolvedModel) ? row.resolvedModel : undefined
    const efforts = normalizeEfforts(row.supportedEffortLevels ?? row.efforts)
    const model = {
      id,
      name: String(row.displayName ?? row.name ?? id).slice(0, 160),
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(typeof row.supportsEffort === 'boolean' ? { supportsEffort: row.supportsEffort } : {}),
      ...(efforts ? { efforts } : {}),
      ...(typeof row.description === 'string' ? { description: row.description.slice(0, 200) } : {}),
    }
    items.set(id, model)
    if (resolvedModel && resolvedModel !== id && !items.has(resolvedModel)) {
      items.set(resolvedModel, { ...model, id: resolvedModel, name: `${model.name} · ${resolvedModel}` })
    }
  }
  return [...items.values()].slice(0, 100)
}

export function catalogModels(config) {
  let discovered = []
  try { discovered = normalizeModels(JSON.parse(config.modelCatalog || '[]')) } catch {}
  const models = new Map(discovered.map(row => [row.id, row]))
  for (const id of ['sonnet', 'opus', 'haiku', 'fable']) {
    if (!models.has(id)) models.set(id, { id, name: `Claude ${id[0].toUpperCase()}${id.slice(1)}（别名）` })
  }
  for (const id of splitModelList(config.customModels)) {
    if (validModelId(id) && !models.has(id)) models.set(id, { id, name: id })
  }
  return [...models.values()].slice(0, 150)
}

// Only advertise thinking levels the remote CLI itself reported for this exact
// model. Models without a reported effort list (for example Haiku 4.5) get no
// selector, so the plugin never sends `--effort` where the CLI would reject it.
export function reasoningInfo(config, actualModel) {
  const model = catalogModels(config).find(row => row.id === actualModel)
  if (!model || model.supportsEffort === false || !model.efforts?.length) return undefined
  const requested = config.reasoningEffort
  const defaultEffort = model.efforts.includes(requested) ? requested : 'default'
  return {
    efforts: ['default', ...model.efforts].map(id => ({ id, name: effortLabel(id), description: EFFORT_DESCRIPTIONS[id] })),
    defaultEffort,
  }
}

export function selectedEffort(config, actualModel, requested) {
  const info = reasoningInfo(config, actualModel)
  const effort = requested ?? info?.defaultEffort ?? 'default'
  if (effort !== 'default' && !info?.efforts.some(row => row.id === effort)) {
    throw new Error(`The selected model does not advertise effort ${effort}`)
  }
  return effort === 'default' ? undefined : effort
}
