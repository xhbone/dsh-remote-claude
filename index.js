import z from '@deepseek-ai/schemastery'
import { RemoteClaudeAdapter } from './lib/adapter.js'
import { RemoteClaudeManager } from './lib/manager.js'
import { CONNECTION_PATH, createConnectionHandler } from './lib/config-api.js'
import { UsageLedger } from './lib/statistics.js'
import { RUNTIME_PATH, createRuntimeHandler } from './lib/runtime-api.js'

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
  reasoningEffort: z.string().default('default').volatile().description('默认思考强度；会话中的原生思考菜单可以覆盖此项。'),
  customModels: z.string().default('').volatile().description('自定义完整模型 ID，逗号或空格分隔。'),
  modelCatalog: z.string().default('[]').volatile().description('从远端初始化协议发现的模型目录，由刷新按钮维护。'),
  connectTimeoutMs: z.number().default(20000).volatile().description('SSH 连接及短控制命令超时，单位毫秒。'),
  idleSessionMs: z.number().default(1800000).volatile().description('空闲远端会话回收时间，单位毫秒，至少 30000。'),
  restrictedMode: z.boolean().default(true).volatile().description('启用 Claude Code --restricted；无论此项取值，内建工具始终关闭。'),
})

export function apply(ctx, refs) {
  // Consumers see live values while the Loader retains the VolatileRefs.
  const config = Object.defineProperties({}, Object.fromEntries(Object.keys(refs).map(key => [key, {
    enumerable: true, get: () => typeof refs[key]?.get === 'function' ? refs[key].get() : refs[key],
  }])))
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('SSH port must be between 1 and 65535')
  if (!Number.isSafeInteger(config.connectTimeoutMs) || config.connectTimeoutMs < 1000) throw new Error('connectTimeoutMs must be at least 1000')
  if (!Number.isSafeInteger(config.idleSessionMs) || config.idleSessionMs < 30000) throw new Error('idleSessionMs must be at least 30000')
  const manager = new RemoteClaudeManager(ctx, config)
  manager.ledger = new UsageLedger()
  const adapter = new RemoteClaudeAdapter(manager, config)
  ctx.connection.fetch.register({
    path: RUNTIME_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: createRuntimeHandler(ctx, config, manager.ledger),
  })
  ctx.llm.registerAdapter(['remote-claude'], adapter)
  ctx.connection.fetch.register({
    path: CONNECTION_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: createConnectionHandler(ctx, () => manager.reset()),
  })
  ctx.effect(() => async () => { await manager.dispose() })
}
