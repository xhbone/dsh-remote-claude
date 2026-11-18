# DSH Remote Claude

在 VPS 上运行 Claude Code 的 Agent Loop，同时把文件、搜索、编辑、终端、审批和工具结果留在当前 DeepSeek Harness 工作区。

## 数据路径

```text
DSH 对话 / Remote Claude preset
        │
        ▼
remote-claude LLM adapter ──SSH──► VPS Claude Code 2.x
        ▲                              │
        │                              │ HTTP MCP over SSH reverse-forward
        └──── DSH tools/approval ◄─────┘
```

Claude Code 的内建 `Read/Edit/Bash` 被 `--tools ""` 关闭，只能看到当前 DSH turn 已经暴露的 `local_dsh` MCP 工具。MCP 调用再进入 `ctx.tools.execute()`，因此文件边界、sandbox、guard 和审批仍由 DSH 决定。VPS 不需要、也不应持有本机 SSH 私钥。

## 前置条件

npm 版 DSH 的远程工具若统一返回 `Cannot read properties of undefined (reading 'find')`，请升级到插件 0.3.5。网关通过单次 ToolRuntime 调用执行并记录工具事件，提供 `selectExecutor` 和 `resolve` 的桌面构建继续使用原生批量流程。

- DSH `>=0.2.1-rc.2`，Node.js `>=22.19.0`。插件会特性探测 `ctx.tools.execute` 与 `ctx.agents`，缺失时在加载阶段给出明确错误，而不是在首个 turn 才失败。
- Linux VPS 上有专用非 root 用户，并已安装、登录 Claude Code 2.x；需要 Bash、GNU tail（含 `--pid`）、base64、setsid 和 nohup。不再需要远端 `python3`：模型目录与额度刷新改为在 Node 侧通过 SSH 双工流发送只读 `control_request`。
- SSHD 允许仅绑定 VPS 回环地址的 remote forwarding。不要设置 `GatewayPorts yes`。
- 本机用私钥、SSH agent 或 DSH 凭据存储中的密码连接 VPS。密码认证填写 `passwordRef` 引用名，在每次建立 SSH 连接时重新解析；不要把密码写入插件 Config、命令、源码或远端运行文件。私钥内容不会发送到 VPS。
- 协议设计参考 Claude Code `2.1.296`；0.3.0 已在真实 VPS 的 Claude Code `2.1.311` 上验证文本、多轮、本地文件读取/创建/编辑、模型目录发现、`--effort`、额度读取，以及 `interrupt` 暂停后在同一远端会话继续；0.3.2 沿用相同的 exec/stream-json 路径，新增能力见 VALIDATION.md。stream-json/control 不是稳定公开 API，其他版本仍需回归验证。

## 配置

安装后，打开 DSH 左侧「插件」→ `@local/dsh-remote-claude` →「Remote Claude 连接设置」，填写 VPS 地址、SSH 用户、可信主机指纹和远端 Claude 路径，点击「保存 Remote Claude 连接」。密码填写在专用密码框，只写入 DSH Credentials；页面不会读取已保存的密码。使用私钥或 SSH agent 时不需要清空密码引用名——保存时只在密码模式下回填默认引用，私钥与密码引用不会互相阻塞。

保存前可用「测试连接」一次完成体检：SSH 认证、主机指纹、远端 bash、setsid、GNU tail、`claudePath` 是否存在，以及回环端口转发是否被允许。失败项会给出 `AUTH_FAILED`、`FINGERPRINT_MISMATCH`、`HOST_UNREACHABLE`、`FORWARD_DENIED`、`BASH_MISSING`、`SETSID_MISSING`、`TAIL_UNSUPPORTED`、`CLAUDE_NOT_FOUND` 等机器码与对应操作提示。指纹不匹配时按钮会显示本次实际观察到的指纹，可在核对后用「使用此指纹」显式确认，不会静默接受首次连接。

「模型与思考强度」卡片列出远端 `list_models` 返回的模型（显示名 + 实际模型 ID，含 `fable` 等别名），并可按模型给出的 `supportedEffortLevels` 选择思考强度；模型未声明档位时该选择器禁用，保存时不会传 `--effort`。「账号额度」卡片显示 5 小时窗口、7 天窗口与模型专属窗口的用量百分比和重置时间，以及本次 Host 激活的 token/成本累计；「刷新模型与额度」只发送只读控制请求，不需要用户消息，因此不消耗额度。

「活动面板与暂停」卡片控制会话 composer 下方的活动条。活动条由 Host 返回的 `pollMs` 驱动（默认 1.5 秒），页面隐藏时降到 ≥6 秒，空闲/已停止会话退避到 ≥10 秒；显示远端当前状态（准备/思考中/输出中/调用工具/等待确认）、已用与静默时间、token 与成本、5 小时窗口百分比，并提供暂停与停止按钮，不额外消耗额度。本地工具调用超过 3 秒未返回时会进入「等待确认」，工具结束后回到原状态。

可配置字段如下：

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
| `auxiliaryModel` | 标题生成、压缩等 purpose 请求使用的辅助模型，避免与主对话争用同一份额度 | `haiku` |
| `reasoningEffort` | 默认思考强度，取自 `low`/`medium`/`high`/`xhigh`/`max`；`default` 表示不传 `--effort` | `default` |
| `customModels` | 额外模型 ID，逗号或空格分隔；目录刷新后自动并入模型选择器 | 空 |
| `modelCatalog` | 最近一次从远端发现并校验过的模型目录（JSON），由「刷新模型与额度」按钮维护 | `[]` |
| `activityPanel` | 在会话 composer 下方显示远端活动条 | `true` |
| `showThinking` | 把远端 thinking 投影为 DSH 思考块，并计入思考字符数 | `true` |
| `cancelBehavior` | DSH 取消当前 turn 时的行为：`stop` 立即回收远端进程，`pause` 发 interrupt 并在 `pauseTimeoutMs` 内排空到 result，确认后保留进程与会话 | `stop` |
| `pauseTimeoutMs` | 暂停后等待 `interrupt` 确认的时长，超时回收远端进程 | `8000` |
| `activityPollMs` | 活动条基准轮询间隔，Host 会随快照下发 | `1500` |
| `pauseHint` | 暂停时追加到回复末尾的提示，空表示使用默认文案 | 空 |
| `stopHint` | 停止时追加到回复末尾的提示，空表示使用默认文案 | 空 |
| `connectTimeoutMs` | SSH 连接超时 | `20000` |
| `idleSessionMs` | 空闲多久后结束远端进程 | `1800000` |
| `turnIdleTimeoutMs` | 看门狗：多久没有远端事件且没有本地工具在跑就中断本轮；`0` 关闭 | `300000` |
| `turnReconnectAttempts` | 单个 turn 内 SSH 断线后的最大重连续读次数；`0` 表示不重连 | `5` |
| `restrictedMode` | 启用 Claude Code `--restricted` | `true` |
| `remoteBuiltinTools` | 远端内建工具模式：`none` 全关、`web` 只放行 `WebSearch`/`WebFetch`、`all` 放行 Claude Code 默认内建工具（Read/Edit/Bash/skills/hooks，安全边界最宽） | `none` |
| `allowRemoteWebTools` | 旧配置兼容项：`true` 等同 `remoteBuiltinTools=web` | `false` |
| `retentionDays` | 已结束 run 目录的保留天数；`0` 表示不按时间删除 | `7` |

主机指纹必须通过可信渠道核对。可以在另一条可信链路上运行：

```bash
ssh-keyscan -p 22 your-vps.example | ssh-keygen -lf - -E sha256
```

不要把第一次网络连接看到的指纹直接当作可信值；配置页的「测试连接」只负责显示本次观察到的指纹，是否确认由你决定。

安装到其他电脑的导出与安装步骤见 `INSTALL.md`。

## 使用

1. 选择 `Remote Claude` preset。
2. 在模型选择器或 `/model` 中选择 provider `remote-claude`、model `claude-code-agent`。Preset YAML 无法安全地自动改写会话模型，因此这一步是显式的。
3. 正常对话。Claude Code 在 VPS 推理，但工具调用会回到当前 DSH 会话。

也可以选择目录里的任意模型（别名或完整版本 ID，例如 `fable`、`claude-fable-5-2`、`claude-opus-5-5`），或手动输入 Claude Code 接受的模型 ID。`claude-code-agent` 使用 Host 配置里的 `claudeModel`。

等待远端输出时，composer 下方的活动条会显示当前阶段、已用时间和最近动作。点「暂停」会立刻向远端发 `interrupt`：Host 继续读取输出直到本次 `result`（最多 `pauseTimeoutMs`），确认后保留远端进程与会话。DSH 保存本轮回复且历史校验通过时，下一条消息在原进程中继续。若超时未确认，或 DSH 侧取消后未保存本轮回复，则从 DSH 历史重建。点「停止」立即回收远端进程。

思考强度有两层：Host 配置页的 `reasoningEffort` 是默认值，会话 composer 的原生思考强度选择优先；选中的档位会作为 `--effort <level>` 传给远端 Claude Code，档位不在该模型 `supportedEffortLevels` 内时请求直接失败（不会静默降级）。模型或档位变化会重建远端会话。

### 断线、重启与历史一致性

- 活动 turn 中 SSH 传输中断时，Host 会自动重连（默认最多 5 次，可用 `turnReconnectAttempts` 调整），重新建立同一远端端口的 reverse forward，并用 `tail -c +<已提交 offset>` 续读，不重放已发送的输入。
- 每个成功或已确认暂停的 turn 会把 `claudeSessionId`、runId、包含本轮回复的历史摘要和 system prompt 摘要写入本机 handoff 文件（`<tmpdir>/dsh-remote-claude/`）。Host 重启或空闲回收后，旧 run 已退出且历史吻合时，发送新消息前通过 `--resume` 续接原会话。每个会话和用途使用固定的远端项目目录，MCP 配置与日志仍按 run 分开。
- 每轮开始前都会校验 DSH 消息前缀与 system prompt 摘要。DSH 中重新生成、编辑、回退或压缩历史导致两侧分叉时，会显式重建远端会话，而不是静默沿用旧的远端上下文。

## 安全边界

- 首次连接不使用 TOFU；缺少或不匹配 `knownHostFingerprint` 时直接失败。「测试连接」显示的指纹只有在你点击确认后才会被保存。
- 本地 MCP 仅监听 `127.0.0.1`，使用每个 DSH session 独立的随机 Bearer token，并检查 Host header 和 10 MiB body 上限。
- SSH reverse forward 只绑定 VPS `127.0.0.1`。
- MCP `tools/list` 只返回当次 `GenerateOptions.tools` 的名称 allowlist；`tools/call` 再检查名称并绑定原 DSH Agent。只读工具（`readOnly`/`readOnlyHint`）可并行执行，其余工具仍串行。
- 工具结果中的图片以 MCP `{type:'image', data, mimeType}` 原样返回（支持内联 base64 或本机文件路径，单张上限 8 MiB），Claude 可以看到截图而不是 `[image: name]` 占位文本。
- 不使用 `--dangerously-skip-permissions`，不直接暴露 TerminalController，也不执行上游 `fs-tools.js` 的 PowerShell bypass。
- 未确认的写操作不会在连接层自动重放。

## 当前 MVP 限制

- `--resume` 要求历史、system prompt、模型、思考档位和远端环境一致。旧进程仍在运行、状态未知或 handoff 缺失时会重建。首次升级会使用这一重建路径。活动 turn 的 SSH 重连使用独立的重试预算（默认 5 次），只从确认的输出偏移续读。
- MCP 网关在原始 DSH 步骤内传递 `{turn, step}` 和按步骤解析的工具集合，由 DSH 记录 `tool/call` / `tool/result` 及工具提供的 diff 元数据。桌面版的卡片展示还需实机验证。
- 系统提示不再只在进程启动时快照：摘要变化会触发远端会话重建；重建后 Claude 会重新读取当前 preset，而不是继承旧进程的系统提示。
- Claude Code 子代理的文本会以引用块投影到主回复，`task_started`/`task_progress`/`task_notification` 只写入活动流，不伪造子代理的工具卡；嵌套子代理的图片与结构化结果仍不投影。
- 模型名或用途（例如标题生成、压缩）不同的请求使用独立远端会话；同一会话和用途不接受并发 turn。工具请求跨 HTTP 串行（只读工具除外），结束/取消 turn 会撤销其授权。
- 远端在私有 run 目录保存日志和 MCP 配置。清理只删除已确认退出的 run，或超过宽限期且可判定已失去进程的目录。手动清理可跳过保留天数，仍保留正在运行或状态未知的进程，避免影响共用远端目录的其他 Host。
- 额度与 token 统计写入本机 `~/.dsh-remote-claude/ledger.json`，Host 重启后保留按 DSH session 的累计值与成本高水位；5 小时窗口百分比来自远端 `rate_limit_event` 与刷新探针。跨机器、跨 VPS 的汇总仍不支持。

## 开发验证

```bash
pnpm install --ignore-scripts
pnpm test
pnpm run check
```

`npm run check` 自动发现 `index.js`、`client.js`、`lib/`、`test/`、`scripts/` 下的全部 JS 并逐文件语法检查，不再维护手写文件清单。本地自动化测试覆盖密码引用/轮换、配置表单到 Host 的真实协议契约、CAS 冲突、模型目录归一化、思考强度校验、额度归一化、context usage 与累计账本分离、运行时发现/体检/清理接口、活动日志状态机、暂停/停止控制接口与 drain 暂停、活动条轮询退避、工具活动打点、图片透传、只读工具并行、handoff 持久化、`--resume`/Web 工具参数、协议事件与思考块投影、子代理文本投影、协议版本下限、原生工具卡日志与条件工具集合、持久化账本、`remoteBuiltinTools` 参数、Client 端契约、工具授权与生命周期。tgz 现在包含 `test/`，可直接复现测试结果。真实 VPS 验证结果及未验证范围见 `VALIDATION.md`。

## 来源与授权

本包参考并改造了 [HEYD66/claude-bridge](https://github.com/HEYD66/claude-bridge) 的 SSH 常驻 run、stream-json、字节 offset 和反向 MCP 设计。用户已确认获得原作者授权。由于上游仓库在核查时未发布 LICENSE，本包保持私有并标记为 `UNLICENSED`；详情见 `THIRD_PARTY_NOTICES.md`。
