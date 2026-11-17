# DSH Remote Claude

在 VPS 上运行 Claude Code 的 Agent Loop，同时把文件、搜索、编辑、终端、审批和工具结果留在当前 DeepSeek Harness 工作区。

## 数据路径

```text
DSH 对话 / Remote Claude preset
        │
        ▼
remote-claude LLM adapter ──SSH──► VPS Claude Code 2.1.311
        ▲                              │
        │                              │ HTTP MCP over SSH reverse-forward
        └──── DSH tools/approval ◄─────┘
```

Claude Code 的内建 `Read/Edit/Bash` 被 `--tools ""` 关闭，只能看到当前 DSH turn 已经暴露的 `local_dsh` MCP 工具。MCP 调用再进入 `ctx.tools.execute()`，因此文件边界、sandbox、guard 和审批仍由 DSH 决定。VPS 不需要、也不应持有本机 SSH 私钥。

## 前置条件

- DSH `>=0.2.1-rc.2 <0.3.0-0`，Node.js `>=22.19.0`。
- Linux VPS 上有专用非 root 用户，并已安装、登录 Claude Code；需要 Bash、GNU tail（含 `--pid`）、base64、setsid 和 nohup。模型目录与额度刷新还需要 `python3`（只用于向 Claude Code 的 stream-json 发只读控制请求）。
- 协议设计参考 Claude Code `2.1.296`；本插件 `0.3.0` 已在真实 VPS 的 Claude Code `2.1.311` 上验证文本、多轮、本地文件读取/创建/编辑、模型目录发现、`--effort`、额度读取，以及 `interrupt` 暂停后在同一远端会话继续。stream-json/control 不是稳定公开 API，其他版本仍需回归验证。
- 本机用私钥、SSH agent 或 DSH 凭据存储中的密码连接 VPS。密码认证填写 `passwordRef` 引用名，在每次建立 SSH 连接时重新解析；不要把密码写入插件 Config、命令、源码或远端运行文件。私钥内容不会发送到 VPS。
- SSHD 允许仅绑定 VPS 回环地址的 remote forwarding。不要设置 `GatewayPorts yes`。

## 配置

安装后，打开 DSH 左侧「插件」→ `@local/dsh-remote-claude` →「Remote Claude 连接设置」，填写 VPS 地址、SSH 用户、可信主机指纹和远端 Claude 路径，点击「保存 Remote Claude 连接」。密码填写在专用密码框，只写入 DSH Credentials；页面不会读取已保存的密码。密码留空会保留已有凭据。

使用私钥或 SSH agent 时，清空密码凭据引用名，填写对应的认证字段。配置保存使用 DSH Settings，且会结束旧连接；下一条请求使用新配置。可配置字段如下：

「模型与思考强度」卡片列出远端 `list_models` 返回的模型（显示名 + 实际模型 ID，含 `fable` 等别名），并可按模型给出的 `supportedEffortLevels` 选择思考强度；模型未声明档位时该选择器禁用，保存时不会传 `--effort`。「账号额度」卡片显示 5 小时窗口、7 天窗口与模型专属窗口的用量百分比和重置时间，以及本次 Host 激活的 token/成本累计；「刷新模型与额度」只发送只读控制请求，不需要用户消息，因此不消耗额度。

「活动面板与暂停」卡片控制会话 composer 下方的活动条：它每 1.5 秒读取一次本机 HTTP 快照，显示远端当前状态（准备/思考中/输出中/调用工具/等待权限）、已用与静默时间、token 与成本，并提供暂停与停止按钮，不额外消耗额度。

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `host` | VPS 主机名或 IP | 空，必须填写 |
| `port` | SSH 端口 | `22` |
| `username` | VPS 专用非 root 用户 | 空，必须填写 |
| `privateKeyPath` | 本机私钥路径；支持 `~/...` | 空 |
| `agent` | ssh2 支持的 agent socket；与私钥二选一 | 空 |
| `passwordRef` | SSH 密码的 DSH 凭据引用名，例如 `DSH_REMOTE_CLAUDE_SSH_PASSWORD`；与私钥/agent 互斥 | 空 |
| `knownHostFingerprint` | 必填的 `SHA256:...` 主机指纹 | 空 |
| `remoteBaseDir` | VPS 用户 HOME 下的运行目录，或绝对 POSIX 路径 | `.dsh-remote-claude` |
| `claudePath` | VPS 上 Claude Code 可执行文件 | `claude` |
| `claudeModel` | DSH 模型 `claude-code-agent` 映射到的 Claude 模型，可填别名或完整 ID（如 `claude-opus-5-5`） | `sonnet` |
| `reasoningEffort` | 默认思考强度，取自 `low`/`medium`/`high`/`xhigh`/`max`；`default` 表示不传 `--effort` | `default` |
| `customModels` | 额外模型 ID，逗号或空格分隔；目录刷新后自动并入模型选择器 | 空 |
| `modelCatalog` | 最近一次从远端发现并校验过的模型目录（JSON），由「刷新模型与额度」按钮维护 | `[]` |
| `activityPanel` | 在会话 composer 下方显示远端活动条 | `true` |
| `showThinking` | 把远端 thinking 投影为 DSH 思考块，并计入思考字符数 | `true` |
| `cancelBehavior` | DSH 取消当前 turn 时的行为：`stop` 回收远端进程，`pause` 发 interrupt 并保留会话 | `stop` |
| `pauseTimeoutMs` | 暂停后等待 `interrupt` 确认的时长，超时回收远端进程 | `8000` |
| `activityPollMs` | 活动条轮询间隔 | `1500` |
| `pauseHint` | 暂停时追加到回复末尾的提示，空表示使用默认文案 | 空 |
| `stopHint` | 停止时追加到回复末尾的提示，空表示使用默认文案 | 空 |
| `connectTimeoutMs` | SSH 连接超时 | `20000` |
| `idleSessionMs` | 空闲多久后结束远端进程 | `1800000` |
| `restrictedMode` | 启用 Claude Code `--restricted` | `true` |

主机指纹必须通过可信渠道核对。可以在另一条可信链路上运行：

```bash
ssh-keyscan -p 22 your-vps.example | ssh-keygen -lf - -E sha256
```

不要把第一次网络连接看到的指纹直接当作可信值。

安装到其他电脑的导出与安装步骤见 `INSTALL.md`。

## 使用

1. 选择 `Remote Claude` preset。
2. 在模型选择器或 `/model` 中选择 provider `remote-claude`、model `claude-code-agent`。Preset YAML 无法安全地自动改写会话模型，因此这一步是显式的。
3. 正常对话。Claude Code 在 VPS 推理，但工具调用会回到当前 DSH 会话。

也可以选择目录里的任意模型（别名或完整版本 ID，例如 `fable`、`claude-fable-5-2`、`claude-opus-5-5`），或手动输入 Claude Code 接受的模型 ID。`claude-code-agent` 使用 Host 配置里的 `claudeModel`。

等待远端输出时，composer 下方的活动条会显示当前阶段、已用时间和最近动作。点「暂停」会立刻向远端发 `interrupt`：当前 turn 在约 1 秒内结束，远端进程与会话保留，再发任意消息即可从原上下文继续；点「停止」则回收远端进程，下一条消息从 DSH 压缩后的历史重建。需要你确认的本地工具调用会让活动条进入「等待权限」状态。

思考强度有两层：Host 配置页的 `reasoningEffort` 是默认值，会话 composer 的原生思考强度选择优先；选中的档位会作为 `--effort <level>` 传给远端 Claude Code，档位不在该模型 `supportedEffortLevels` 内时请求直接失败（不会静默降级）。模型或档位变化会重建远端会话。

## 安全边界

- 首次连接不使用 TOFU；缺少或不匹配 `knownHostFingerprint` 时直接失败。
- 本地 MCP 仅监听 `127.0.0.1`，使用每个 DSH session 独立的随机 Bearer token，并检查 Host header 和 10 MiB body 上限。
- SSH reverse forward 只绑定 VPS `127.0.0.1`。
- MCP `tools/list` 只返回当次 `GenerateOptions.tools` 的名称 allowlist；`tools/call` 再检查名称并绑定原 DSH Agent。
- 不使用 `--dangerously-skip-permissions`，不直接暴露 TerminalController，也不执行上游 `fs-tools.js` 的 PowerShell bypass。
- 未确认的写操作不会在连接层自动重放。

## 当前 MVP 限制

- 远端 run/字节 offset 只在当前 Host 进程内维护；同一进程内的正常多轮按已消费行的字节位置续读。活动 turn 断线会报错，不自动重连或重放输入。连接尚在时会尝试结束旧 run；连接已断时远端 run 可能残留，MCP 授权会被撤销。插件/Harness 重启后的持久 reattach、孤儿 run 回收尚未实现。
- 暂停（`interrupt`）保留远端进程和会话，继续时直接复用；停止或 `cancelBehavior: stop` 会回收进程，下一次 turn 用 DSH 压缩后的历史重建上下文。会话身份包含模型与思考档位，切换二者会重建远端会话。
- Adapter 无法取得外层 AgentLoop 的 `ResolvedToolSet`。它用 `options.tools` 做严格 allowlist，再以 `ctx.tools.execute({ agent })` 执行；条件注册工具可能返回 `UNKNOWN_TOOL`。无条件注册的文件、搜索、shell、job、ask-user 和 todo 工具可正常走 DSH 管线。
- 系统提示在远端 Claude 进程启动时快照；同一会话中途修改 preset 后，需要新建会话或等待远端 run 重建。
- 当前只把顶层文本流投影回 DSH；子代理文本不会混入主回复。MCP 返回工具内容给远端 Claude，但尚未接入外层 root tool/call 日志和原生工具卡、diff 卡；审批和执行仍走 DSH 工具管线。
- 模型名或用途（例如标题生成、压缩）不同的请求使用独立远端会话；同一会话和用途不接受并发 turn。工具请求跨 HTTP 串行，结束/取消 turn 会撤销其授权。
- 远端会保存对话、日志与含 MCP token 的配置到私有运行目录。请使用专用账号，并在不再需要时清理已结束的 runs；本版没有自动保留期限策略。

## 开发验证

```bash
pnpm install --ignore-scripts
pnpm test
pnpm run check
```

本地自动化测试为 91 项，包含密码引用/轮换、配置表单到 Host 的真实协议契约、CAS 冲突、模型目录归一化、思考强度校验、额度归一化、usage ledger、运行时发现接口、活动日志状态机、暂停/停止控制接口、思考块投影、Client 端契约、工具授权与生命周期。真实 VPS 验证结果及未验证范围见 `VALIDATION.md`。自动化测试不读取你的 SSH 配置或凭据。

## 来源与授权

本包参考并改造了 [HEYD66/claude-bridge](https://github.com/HEYD66/claude-bridge) 的 SSH 常驻 run、stream-json、字节 offset 和反向 MCP 设计。用户已确认获得原作者授权。由于上游仓库在核查时未发布 LICENSE，本包保持私有并标记为 `UNLICENSED`；详情见 `THIRD_PARTY_NOTICES.md`。
