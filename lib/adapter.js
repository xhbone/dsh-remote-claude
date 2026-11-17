import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { unsupportedOption } from './util.js'
import { catalogModels, reasoningInfo, validModelId } from './model-catalog.js'

const PROVIDER = 'remote-claude'

export class RemoteClaudeAdapter extends LlmAdapter {
  constructor(manager, config) {
    super()
    this.manager = manager
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: 'Remote Claude' }
  }

  async listModels() {
    const models = catalogModels(this.config)
    const configured = models.find(row => row.id === this.config.claudeModel)
    return [
      modelInfo('claude-code-agent', `Claude Code Agent (${configured?.resolvedModel || this.config.claudeModel})`, '使用插件默认模型；思考强度可在原生菜单切换。'),
      ...models.map(row => modelInfo(row.id, row.resolvedModel && row.id !== row.resolvedModel ? `${row.name} · ${row.resolvedModel}` : row.name, `模型 ID: ${row.id}${row.resolvedModel ? `; 实际模型: ${row.resolvedModel}` : '; 别名/自定义 ID，权限以远端为准'}`)),
    ]
  }

  async resolveModel(provider, model) {
    if (!validModelId(model)) throw new Error('A valid Remote Claude model id is required')
    const listed = (await this.listModels()).find((item) => item.id === model)
    const actual = model === 'claude-code-agent' ? this.config.claudeModel : model
    const reasoning = reasoningInfo(this.config, actual)
    return { ...(listed ?? modelInfo(model, model)), ...(reasoning ? { reasoning } : {}) }
  }

  async *stream(options) {
    for (const key of ['temperature', 'maxTokens', 'stop']) {
      if (options[key] !== undefined) throw unsupportedOption(key)
    }
    let text = ''
    let usage
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for await (const event of this.manager.stream(options)) {
      if (event.type === 'text') {
        text += event.text
        yield { type: 'text-delta', index: 0, text: event.text }
      } else if (event.type === 'usage') {
        usage = event.usage
      }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function modelInfo(id, name, description) {
  return {
    provider: PROVIDER,
    id,
    name,
    ...(description ? { description } : {}),
    inputModalities: ['text'],
  }
}
