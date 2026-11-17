# Remote Claude 0.3.0 验证记录

验证日期：2026-11-17。0.3.0 在 0.2.0 的模型目录、思考强度与额度读取之上，新增运行可观测性与暂停/停止，并在真实 VPS 的 Claude Code `2.1.311` 上核对 `interrupt` 语义。

## 自动化测试

91 项测试全部通过，失败、取消、跳过均为 0。0.2.0 的 61 项之外新增：

- `test/activity.test.js`：状态机与中文标签、`summarizeToolArgs` 的参数优选/换行压平/长度截断、turn 内 elapsed 与模型/档位/版本快照、文本窗口合并成「已输出 N 字符」、同标签 1.5 秒去重计数、工具开始/结束条目、结束时 usage/成本/暂停落账、容量环形裁剪。
- `test/control-api.test.js`：GET 快照与 usage ledger、缺失/未知 `sessionId`、活动面板关闭时 `available:false`、POST `pause`/`stop`、`NOT_RUNNING` 409、未知 action 400、非 GET/POST 405。
- `test/client-activity.test.js`：Client 活动 API 的 GET 路径与 `?sessionId=`、POST body `{sessionId, action}`、错误码透传，以及 `apply()` 同时注册配置页与会话活动条。
- `test/pause.test.js`：`pause()` 发出 `control_request{interrupt}` 并进入 `pausing`、无 turn 时 `NOT_RUNNING`、超时后回收远端进程（换 runId / `hasTurn=false` / offset 归零 / 状态 `paused`）、`stop()` 中止本地工具并保留暂停态、Manager 的主会话解析与转发。
- `test/adapter-reasoning.test.js`：thinking 作为第二个块投影、`showThinking=false` 时不进入 LLM 流、暂停/停止提示、采样参数拒绝。
- `test/protocol.test.js`：`result` 新增 `interrupted` 字段、暂停轮次的 `costUsd`/`durationMs`/`numTurns`、thinking/tool-use/compact 事件解析。

本地测试使用 fake SSH transport，不包含真实密码或远端账号。`npm run check` 同时覆盖 15 个 lib 文件的语法检查与全部测试。

## 真实 VPS 验证（Claude Code 2.1.311）

用与插件相同的 `exec` + stream-json 路径对真实 VPS 执行分阶段探针（脚本 `_pause_spike.py` / `_pause-spike.js` / `_think_spike*.py`）：

| 验收项 | 实际结果 |
| --- | --- |
| `interrupt` 生效延迟 | 发出用户消息后 4.4 秒收到首个 delta，5.9 秒发 `control_request{interrupt}`，**0.1 秒内**返回 `result` |
| 暂停后的会话状态 | `result.subtype = error_during_execution`、`is_error = true`、`result = null`；**远端进程存活** |
| 继续 | 同一进程再发用户消息，1.1 秒返回第二个 `result`（`RESUMED`），上下文连续 |
| thinking 事件 | `content_block_start/thinking`、`content_block_delta/thinking_delta`、`signature_delta`、`content_block_stop`；`assistant` 消息内出现 `thinking` 块 |
| `--effort` 与模型 | `--effort high --model claude-opus-5-5` 被接受，退出码 0 |
| system 事件 | `init` 携带 `model`、`claude_code_version`、`per_turn_effort_active:true`；另有 `status` |
| 成本 | 暂停/继续探针仅消耗极少量额度；活动条与本机 `/api/remote-claude/activity` 全程零额度 |

## 安装与配置

- 会话 composer 下方新增活动条：状态点、阶段名称、模型与思考档位、已用/静默时间、当前工具、token 与成本、暂停/继续/停止按钮、最近 6 条活动。轮询 1.5 秒，页面不可见时降频到 6 秒，读取的是本机 HTTP 快照。
- 配置页新增「活动面板与暂停」卡片：`activityPanel`、`showThinking`、`cancelBehavior`、`pauseTimeoutMs`、`activityPollMs`、`pauseHint`、`stopHint`。
- 暂停只发 `interrupt`，不发用户消息、不额外计费；继续即下一条普通消息。停止会回收远端进程，下一条消息从 DSH 压缩后的历史重建。
- Client 与 Host 通过同源 Connection Fetch 路由通信；Client 不读取已保存的密码。

## 修正过的问题

- `interrupt` 的 `error_during_execution` 曾被当成错误：现在识别为暂停，并以 `{type:'paused'}` 正常结束该 turn。
- 旧 `parseClaudeEvent` 丢弃 thinking/tool_use/compact：已补齐，`result` 同时携带 `interrupted`/`costUsd`/`durationMs`/`numTurns`。
- thinking 的 `block-end` 曾传空文本：现在累积 `reasoningText` 后关闭。
- 会话 catch 分支不区分取消意图：新增 `cancelBehavior`，`pause` 时保留会话。
- 探针上传曾用 `exec('cat > file')` 而挂死：改为 `sftp.writeFile`；上游 `python` 在本机是坏 stub，改写文件改用 Node 脚本。

## 尚未完成的实机覆盖与功能限制

- 活动条、暂停/停止按钮的 GUI 交互需重启桌面应用重建 Client 包后人工确认；自动化覆盖的是 Client API 与 Host handler 的契约。
- 本次没有对需要确认的本地工具调用做人工允许/拒绝（活动条会显示「等待权限」，但审批链路沿用 DSH 既有实现）。
- 活动 turn 断线不自动重连或重放；Host 重启后没有持久 reattach，远端孤儿 run 回收尚未实现。
- Adapter 取不到外层 `ResolvedToolSet`，条件注册工具可能返回 `UNKNOWN_TOOL`。
- 远端运行目录保存对话及含临时 MCP token 的私有配置；当前没有自动保留期限策略。

## 0.1.3 / 0.2.0 已完成的端到端结果（未回归）

远端纯文本、多轮、本地读取/创建/编辑、受控终端均通过；终端计算的 `output.txt` SHA256 与本机文件工具 revision 一致（`EA1C17282D61521571D80C72C01441D461E9CC52381EDB66868208BD5F76984D`）。模型目录 18 条、额度窗口与 `--effort` 接受度见 0.2.0 记录，未在本轮重跑。

结论：可观测性（状态/耗时/工具/token/成本）与暂停-继续在同一远端会话上的语义已在真实 VPS 验证；停止与取消行为由新配置控制；GUI 需重启应用后再人工复核。
