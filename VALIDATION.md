# Remote Claude 0.3.3 验证记录

验证日期：2026-11-18。0.3.3 修复 0.3.2 在 DSH schemastery 下误用 `z.enum` 导致插件加载失败的问题；功能与 0.3.2 相同，包含原生工具卡/日志、条件工具集合、子代理文本、内建工具模式、协议版本下限、持久化账本与更强的清理能力。0.3.2 是 0.3.0 的缺陷修复与可运维性版本，重点在活动条/工具打点、错误与暂停语义、断线重连、`--resume`、运行目录清理、体检与错误分类，以及去 python3 依赖。

## 自动化测试

105 项测试全部通过，失败、取消、跳过均为 0。`node --test --test-isolation=none test/*.test.js`，`npm run check` 会先自动发现并逐文件 `node --check`，再跑同一套测试。

新增或更新的覆盖：

- `test/activity.test.js`：活动条目现在带稳定 `id`；工具结束后状态回到 `streaming`/`waiting`，不会卡在 `tool`。
- `test/mcp-gateway.test.js`：工具调用会写入活动日志；图片结果以 MCP `{type:'image', data, mimeType}` 透传；只读工具走并行路径。
- `test/protocol.test.js`：`result` 不再携带 `interrupted`；真实 `error_during_execution` 保留 `success:false` 与 subtype，由会话依据 `pauseRequested` 决定是否暂停；`assistant` 事件携带 `message.usage` 供上下文占用统计。
- `test/pause.test.js`：取消时先 interrupt、再排空到 `result`，确认后保留进程；超时或未确认才回收并换 runId。
- `test/remote-script.test.js`：`--resume` 与 `allowRemoteWebTools` 的 `--tools`/`--allowedTools` 参数；继续断言不含 `--dangerously-skip-permissions`、创建命令不泄漏 token。
- `test/runtime-api.test.js`：`pollMs` 下发；`test` 动作返回 ssh/bash/setsid/tail/claude/forward/claude_probe 逐项检查与 observedFingerprint；`cleanup` 动作转发到 manager；刷新失败按错误码分类且不回显原始 SSH 错误。
- `test/control-api.test.js`：快照随 `pollMs` 与 `rateLimit` 下发。
- `test/handoff.test.js`：handoff 文件跨 Host 重启保留，可删除，缺失文件视为空。
- `test/client-activity.test.js` / `test/client-runtime.test.js`：Client API 契约、`test()`/`cleanup()` 方法与错误 code/hint 透传。
- `test/protocol.test.js` / `test/lifecycle.test.js`：断线后仅对传输错误重连，事件处理错误（`bridge_exit`/`error`/失败 result）直接报错，不再被误当成断线而重连后报「未收到 result」。

本地测试使用 fake SSH transport，不包含真实密码或远端账号。

## 真实 VPS 验证（Claude Code 2.1.311，0.3.0 期间测得，0.3.2 沿用相同 exec/stream-json 路径）

| 验收项 | 实际结果 |
| --- | --- |
| `interrupt` 生效延迟 | 发出用户消息后 4.4 秒收到首个 delta，5.9 秒发 `control_request{interrupt}`，**0.1 秒内**返回 `result` |
| 暂停后的会话状态 | `result.subtype = error_during_execution`、`is_error = true`、`result = null`；远端进程存活 |
| 继续 | 同一进程再发用户消息，1.1 秒返回第二个 `result`（RESUMED），上下文连续 |
| thinking 事件 | `content_block_start/thinking`、`content_block_delta/thinking_delta`、`signature_delta`、`content_block_stop`；`assistant` 消息内出现 `thinking` 块 |
| `--effort` 与模型 | `--effort high --model claude-opus-5-5` 被接受，退出码 0 |
| system 事件 | `init` 携带 `model`、`claude_code_version`、`per_turn_effort_active:true`；另有 `status` |
| 成本 | 暂停/继续探针仅消耗极少量额度；活动条与本机 `/api/remote-claude/activity` 全程零额度 |

0.3.2 新增的 SSH 重连、`--resume`、看门狗与清理扫描没有在真实断网条件下重跑；它们由 fake transport 单元测试覆盖，发布前建议在 VPS 上补一次断网/重启演练。

## 安装与配置

- 活动条轮询由 Host 的 `pollMs` 驱动，页面隐藏 ≥6 秒、空闲/停止 ≥10 秒；显示状态、模型/档位、已用/静默时间、当前工具、token/成本、5 小时额度百分比、暂停/停止与最近活动。
- 配置页新增「远端运行环境」卡片：`remoteBaseDir`、`idleSessionMs`、`connectTimeoutMs`、`turnIdleTimeoutMs`、`auxiliaryModel`、`retentionDays`、`restrictedMode`、`allowRemoteWebTools`，以及「测试连接」「清理远端运行目录」两个按钮和 observedFingerprint 显式确认。
- 密码与私钥可以共存于表单：只有选择密码认证时才回填默认凭据引用，私钥用户不需要每次清空。
- 暂停只发 `interrupt`，不发用户消息、不额外计费；确认后下一条消息 `--resume`，超时才回收。停止立即回收。
- Client 与 Host 通过同源 Connection Fetch 路由通信；Client 不读取已保存的密码。

## 修正过的问题（0.3.2）

- 活动条 token 显示 `undefined`：改为读取 `usage.totals.inputTokens/outputTokens`。
- 工具/活动流未接通：`#callTool` 现在打 `toolStart`/`toolEnd` 与 3 秒「等待确认」，条目有 `id`，Client 按 `activity.tool.name + argsPreview` 渲染。
- 私钥用户保存被密码引用挡住：仅在密码模式回填默认引用。
- 真实执行错误被当成暂停：`parseClaudeEvent` 不再标记 `interrupted`，只有 `pauseRequested` 为真才算暂停，否则带 stderr 尾部抛错。
- `activityPollMs` 死配置：Host 通过快照和活动接口下发 `pollMs`，Client 按其轮询并退避。
- `cancelBehavior:'pause'` 名不副实：现在真正排空到 `result` 并保留进程；README、GUI、VALIDATION 三处文案一致。
- 历史分叉：每轮记录消息前缀摘要与 system prompt 摘要，不匹配即重建；handoff 文件支持 Host 重启后 `--resume`。
- 用量口径：上下文占用取最后一条 assistant message 的 usage；`result.usage` 累计值只进账本，避免多工具轮次把上下文估大数倍。
- 标题/压缩请求改用 `auxiliaryModel`（默认 haiku），不再占用主模型会话。
- 刷新/连接失败按机器码分类（AUTH_FAILED、FINGERPRINT_MISMATCH、HOST_UNREACHABLE、FORWARD_DENIED、BASH_MISSING、SETSID_MISSING、TAIL_UNSUPPORTED、CLAUDE_NOT_FOUND、CLAUDE_UNRESPONSIVE、SSH_CLOSED），并给出 hint；原始 SSH 错误不回显给 Client。
- `bridge_exit` 错误附带 `err.log` 尾部（sanitize 掉 token）；探针不再依赖远端 python3，改用 `openExec` 双工流发 `control_request`。
- 看门狗：`turnIdleTimeoutMs`（默认 5 分钟，`0` 关闭）在无远端事件且无本地工具运行时中断本轮，错误码 `TURN_IDLE_TIMEOUT`。
- 运行目录：dispose/stop/空闲回收删除自己的 run 目录；会话启动扫描并回收孤儿目录；`retentionDays` 控制已完成 run 的保留；「清理远端运行目录」按钮强制清理已完成 run。
- 图片结果不再降级为 `[image: name]`，按 MCP image content 下发（内联 base64 或本机路径，≤8 MiB）。
- 只读工具（`readOnly`/`annotations.readOnlyHint`）并行执行，写工具仍串行。
- 配置页补上 `remoteBaseDir`、`idleSessionMs`、`connectTimeoutMs`、`restrictedMode` 等字段；`package.json` 的 `check` 改为自动发现文件，tgz 包含 `test/`；DSH engines 放宽到 `>=0.2.1-rc.2`，运行时做特性探测。

## 尚未完成的实机覆盖与功能限制

- 断线重连、Host 重启后 reattach、看门狗与清理扫描尚未在真实 VPS 上演练；自动化覆盖的是状态机与假 transport。原生工具卡/root 日志也只在 fake AgentLoop 上验证过，需要在真实 DSH GUI 里确认一次。
- 活动条与「测试连接」「清理远端运行目录」按钮的 GUI 交互需重启桌面应用重建 Client 包后人工确认。
- Adapter 取不到外层 `ResolvedToolSet`，条件注册工具可能返回 `UNKNOWN_TOOL`。
- 额度与 token 统计只在当前 Host 进程内保留，重启清零。
- 远端运行目录保存对话及含临时 MCP token 的私有配置；清理按钮与保留期限只能删除**已结束**的 run，存活进程只会在超过 `max(2 × idleSessionMs, 1h)` 后被 TERM。

## 0.1.3 / 0.2.0 已完成的端到端结果（未回归）

远端纯文本、多轮、本地读取/创建/编辑、受控终端均通过；终端计算的 `output.txt` SHA256 与本机文件工具 revision 一致（`EA1C17282D61521571D80C72C01441D461E9CC52381EDB66868208BD5F76984D`）。模型目录 18 条、额度窗口与 `--effort` 接受度见 0.2.0 记录，未在本轮重跑。

结论：0.3.0 的可观测性与暂停-继续语义已在真实 VPS 验证；0.3.2 在此基础上修复了缺陷并补齐重连、`--resume`、体检、清理与错误分类，自动化测试 105 项全部通过，真实断网/重启演练留待发布前补做。

## 0.3.2 增量修复（第二轮 review）

- 工具调用会携带 DSH AgentLoop 的 `log: { turn, step }` 与按步骤解析的 `toolSet`，因此写入外层 `tool/call` / `tool/result` 会话事件，原生工具卡、diff 卡和 root 日志可见；条件注册工具不再返回 `UNKNOWN_TOOL`。
- 子代理输出：嵌套 assistant 文本投影为引用块（`showSubagentText`，默认开启），任务生命周期事件只进活动流。
- `remoteBuiltinTools`：`none` / `web` / `all` 三档；`all` 省略 `--tools` 并放行 Claude Code 默认内建工具，安全边界由用户显式选择。
- 协议版本下限：init 的 `claude_code_version` 低于 2.1.0 时报 `CLAUDE_VERSION_UNSUPPORTED`；主版本更高时在活动流提示。
- 断线重连默认上限提升到 5 次，并可通过 `turnReconnectAttempts` 调整。
- 「清理远端运行目录」按钮现在会 TERM 并删除无人认领的存活 run；后台扫描仍按 `max(2 × idleSessionMs, 1h)` 回收。
- 额度/token 账本写入 `~/.dsh-remote-claude/ledger.json`，Host 重启后保留按 session 的累计值与成本高水位。
