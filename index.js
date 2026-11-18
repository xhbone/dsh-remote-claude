import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RemoteClaudeAdapter } from './lib/adapter.js'
import { RemoteClaudeManager } from './lib/manager.js'
import { CONNECTION_PATH, createConnectionHandler } from './lib/config-api.js'
import { UsageLedger } from './lib/statistics.js'
import { RUNTIME_PATH, createRuntimeHandler } from './lib/runtime-api.js'
import { SNAPSHOT_PATH, createActivityHandler } from './lib/control-api.js'

export const name = 'remote-claude'
export const inject = ['llm', 'agents', 'tools', 'connection', 'settings', 'credentials']

export const Config = z.object({
  host: z.string().default('').volatile().description('VPS 主机名或 IP。留空时不会建立连接。'),
  port: z.number().default(22).volatile().description('VPS SSH 端口。'),
  username: z.string().default('').volatile().description('VPS 上运行 Claude Code 的用户。'),
  privateKeyPath: z.string().default('').volatile().description('本机 SSH 私钥路径，支持 ~/；加密私钥请通过 SSH agent 使用。'),
  agent: z.string().default('').volatile().description('ssh2 支持的 SSH agent socket，与私钥路径二选一。'),
  passwordRef: z.string().default('').volatile().description('SSH 密码的 DSH 凭据引用名，例如 DSH_REMOTE_CLAUDE_SSH_PASSWORD；不填写密码本身。与私钥/agent 互斥。'),
  knownHostFingerprint: z.string().default('').volatile().description('通过可信渠道核对的 SHA256: 主机指纹，必填。'),
  remoteBaseDir: z.string().default('.dsh-remote-claude').volatile().description('VPS 用户 HOME 下的目录或绝对 POSIX 路径。'),
  claudePath: z.string().default('claude').volatile().description('VPS 上 Claude Code 可执行文件，建议填绝对路径。'),
  claudeModel: z.string().default('sonnet').volatile().description('claude-code-agent 路由使用的 Claude 模型。'),
  auxiliaryModel: z.string().default('haiku').volatile().description('标题、压缩等辅助请求使用的模型；留空则沿用主模型。'),
  reasoningEffort: z.string().default('default').volatile().description('默认思考强度；会话中的原生思考菜单可以覆盖此项。'),
  customModels: z.string().default('').volatile().description('自定义完整模型 ID，逗号或空格分隔。'),
  modelCatalog: z.string().default('[]').volatile().description('从远端初始化协议发现的模型目录，由刷新按钮维护。'),
  connectTimeoutMs: z.number().default(20000).volatile().description('SSH 连接及短控制命令超时，单位毫秒。'),
  idleSessionMs: z.number().default(1800000).volatile().description('空闲远端会话回收时间，单位毫秒，至少 30000。'),
  restrictedMode: z.boolean().default(true).volatile().description('启用 Claude Code --restricted；内建工具由 remoteBuiltinTools 单独控制。'),
  allowRemoteWebTools: z.boolean().default(false).volatile().description('兼容旧配置：等同 remoteBuiltinTools=web。'),
  remoteBuiltinTools: z.union([z.const('none'), z.const('web'), z.const('all')]).default('none').volatile().description('远端内建工具：none 全关、web 只放行 WebSearch/WebFetch、all 放行 Claude Code 默认内建工具（Read/Edit/Bash/skills/hooks 等，风险更高）。'),
  activityPanel: z.boolean().default(true).volatile().description('在对话输入框下方显示远端活动面板（状态、耗时、活动流、暂停/停止）。'),
  showThinking: z.boolean().default(true).volatile().description('把远端 Claude 的思考过程作为 reasoning 流式显示。'),
  showSubagentText: z.boolean().default(true).volatile().description('把 Claude Code 子代理的输出以引用块显示在主回复里。'),
  pauseHint: z.string().default('').volatile().description('暂停时追加到回复末尾的提示；留空使用默认文案。'),
  stopHint: z.string().default('').volatile().description('停止时追加到回复末尾的提示；留空使用默认文案。'),
  pauseTimeoutMs: z.number().default(8000).volatile().description('暂停等待远端确认的时间，单位毫秒；超时会回收远端进程。'),
  activityPollMs: z.number().default(1500).volatile().description('活动面板轮询间隔，单位毫秒，至少 500。'),
  cancelBehavior: z.string().default('stop').volatile().description('DSH 侧取消一次回复时的行为：stop（回收远端进程）或 pause（发送 interrupt 并保留进程与会话）。'),
  turnReconnectAttempts: z.number().default(5).volatile().description('单个 turn 内 SSH 断线后的最大重连续读次数，0 表示不重连。'),
  turnIdleTimeoutMs: z.number().default(300000).volatile().description('远端连续无输出的看门狗上限，单位毫秒；0 表示关闭。触发后中断本轮并报 TURN_IDLE_TIMEOUT。'),
  retentionDays: z.number().default(7).volatile().description('已结束的远端运行目录保留天数，超过后在新建远端会话时自动清理；0 表示不删除。无人认领且长时间静默的远端进程也会一并回收。'),
})

export function apply(ctx, refs) {
  // Consumers see live values while the Loader retains the VolatileRefs.
  const config = Object.defineProperties({}, Object.fromEntries(Object.keys(refs).map(key => [key, {
    enumerable: true, get: () => typeof refs[key]?.get === 'function' ? refs[key].get() : refs[key],
  }])))
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('SSH port must be between 1 and 65535')
  if (!Number.isSafeInteger(config.connectTimeoutMs) || config.connectTimeoutMs < 1000) throw new Error('connectTimeoutMs must be at least 1000')
  if (!Number.isSafeInteger(config.idleSessionMs) || config.idleSessionMs < 30000) throw new Error('idleSessionMs must be at least 30000')
  if (!Number.isSafeInteger(config.pauseTimeoutMs) || config.pauseTimeoutMs < 500 || config.pauseTimeoutMs > 60000) throw new Error('pauseTimeoutMs must be between 500 and 60000')
  if (!Number.isSafeInteger(config.activityPollMs) || config.activityPollMs < 500) throw new Error('activityPollMs must be at least 500')
  if (!['stop', 'pause'].includes(config.cancelBehavior)) throw new Error('cancelBehavior must be stop or pause')
  if (!Number.isInteger(config.turnIdleTimeoutMs) || config.turnIdleTimeoutMs < 0 || config.turnIdleTimeoutMs > 3600000) throw new Error('turnIdleTimeoutMs must be an integer between 0 and 3600000')
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 0 || config.retentionDays > 3650) throw new Error('retentionDays must be an integer between 0 and 3650')
  if (!['none', 'web', 'all'].includes(config.remoteBuiltinTools)) throw new Error('remoteBuiltinTools must be none, web or all')
  if (!Number.isInteger(config.turnReconnectAttempts) || config.turnReconnectAttempts < 0 || config.turnReconnectAttempts > 20) throw new Error('turnReconnectAttempts must be an integer between 0 and 20')
  // Feature detection instead of pinning the whole plugin to one DSH minor version.
  if (typeof ctx.tools?.execute !== 'function') {
    throw new Error('Remote Claude requires DSH ctx.tools.execute (DSH >= 0.2.1). Update DSH and reload the plugin.')
  }
  if (typeof ctx.agents?.get !== 'function') throw new Error('Remote Claude requires DSH ctx.agents.get (DSH >= 0.2.1).')
  const manager = new RemoteClaudeManager(ctx, config)
  manager.ledger = new UsageLedger({ file: join(homedir(), '.dsh-remote-claude', 'ledger.json') })
  const adapter = new RemoteClaudeAdapter(manager, config)
  ctx.connection.fetch.register({
    path: RUNTIME_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: createRuntimeHandler(ctx, config, manager),
  })
  ctx.connection.fetch.register({
    path: SNAPSHOT_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: createActivityHandler(ctx, config, manager),
  })
  ctx.llm.registerAdapter(['remote-claude'], adapter)
  ctx.connection.fetch.register({
    path: CONNECTION_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: createConnectionHandler(ctx, () => manager.reset()),
  })
  ctx.effect(() => async () => { await manager.dispose() })
}
