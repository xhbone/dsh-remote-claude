# Remote Claude 0.2.0 验证记录

验证日期：2026-11-17。0.2.0 在 0.1.3 的端到端验收之上，新增模型目录、思考强度与额度读取，并已在真实 VPS 的 Claude Code `2.1.311` 上核对。

## 自动化测试

61 项测试全部通过，失败、取消、跳过均为 0。0.1.3 的 37 项之外新增：

- `test/model-catalog.test.js`：effort 取值只含 `low/medium/high/xhigh/max`（远端不接受 `ultracode`）、`list_models` 归一化并为别名补 resolvedModel 条目、未声明档位的模型不产生思考选择器、不支持的档位请求直接失败、别名与自定义 ID 合并去重、模型 ID 拒绝空白与控制字符。
- `test/statistics.test.js`：`rate_limit_event` 的 0-1 小数转百分比、`get_usage.rate_limits` 嵌套结构（含 `model_scoped` 专属窗口）、usage ledger 的 token/成本累计与 run 差分、辅助会话（标题/压缩）单独计数、旧会话上限与 `latestRateLimit`。
- `test/runtime-api.test.js`：GET 快照结构、session 维度 404、refresh 持久化 `modelCatalog` 与额度、并发 refresh 409、连接变更 409、远端失败 502 且不泄漏诊断。
- `test/client-runtime.test.js`：Client 运行时 API 与 Host handler 的同源契约（GET 快照、refresh 路径、错误码透传）。
- `test/lifecycle.test.js`：思考档位写入 session 身份、档位变化重建会话、非法档位在进入 SSH 前失败。
- `test/remote-script.test.js` 与 `test/connection-form.test.js` 保留原有 SSH 参数、游标与凭据契约断言。

本地测试使用 fake SSH transport，不包含真实密码或远端账号。`npm run check` 同时覆盖 13 个 lib 文件的语法检查与全部测试。

## 真实 VPS 验证（Claude Code 2.1.311）

用与插件完全相同的 `createRuntimeHandler` + `probeRemote` 路径对真实 VPS 执行：

| 验收项 | 实际结果 |
| --- | --- |
| `POST /api/remote-claude/runtime?action=refresh` | 200，耗时 2.9–7.3 秒 |
| 模型目录 | 18 条（14 条远端目录 + 别名/resolvedModel），含 `fable → claude-fable-5-1`、`claude-fable-5-2`、`claude-opus-5-5` 等带版本号条目 |
| 思考档位 | 每条目录模型都带 `efforts`（`low,medium,high,xhigh,max`）；`claude-haiku-4-5-20251001` 无档位 |
| 版本 | `get_binary_version` → `2.1.311` |
| 额度 | 5 小时窗口 9%、7 天窗口 6%、`Fable` 模型专属 0%，均含 `resetsAt`；订阅 `pro` |
| 目录持久化 | 写入 Settings `modelCatalog`（1 次 CAS 更新），后续 GET 直接返回完整目录 |
| `--effort` 实机接受度 | `claude -p --effort high --model claude-opus-5-5` + 控制请求，退出码 0、stderr 为空、目录照常返回 |
| 成本 | 控制请求不需要用户消息，全程零额度消耗 |

`get_usage` 的 utilization 是 0-100 百分比；会话内 `rate_limit_event` 是 0-1 小数，插件分别归一化。

## 安装与配置

- 配置表单新增「模型与思考强度」「账号额度」两个卡片：模型下拉（显示名 + 实际模型 ID）、手动模型 ID、思考档位、额外模型 ID、额度进度条与刷新按钮。
- Client 与 Host 通过同源 Connection Fetch 路由通信；Client 不读取已保存的密码。
- 主机指纹先经用户已有可信 SSH 会话核实，再固定到配置。本文及安装包不包含密码、私钥或用户专用连接配置。

## 0.1.3 已完成的端到端结果（未回归）

远端纯文本、多轮、本地读取/创建/编辑、受控终端均通过；终端计算的 `output.txt` SHA256 与本机文件工具 revision 一致（`EA1C17282D61521571D80C72C01441D461E9CC52381EDB66868208BD5F76984D`）。

## 修正过的问题

- `remote-claude` 原生配置页无法一次展示模型/额度：新增 `/api/remote-claude/runtime` 只读接口与 refresh 动作。
- Host 曾从 `initialize` 取模型目录：改为并发 `list_models`/`get_usage`/`get_binary_version`。
- 思考档位曾只存不传：`--effort` 已进入 `run.sh`，档位变化会重建远端会话。
- Settings 写入到 ConfigRef 有传播延迟：refresh 响应与后续 GET 直接使用本次发现结果。
- Client 的 refresh 请求曾缺少 `?action=refresh`：已由 `test/client-runtime.test.js` 捕获并修复。

## 尚未完成的实机覆盖与功能限制

- 0.2.0 的 GUI 交互（下拉、刷新按钮、进度条）需在重启桌面应用使 Client 包重新构建后人工确认；本次自动化覆盖的是 Client API 与 Host handler 的契约。
- 本次没有对审批弹窗进行允许/拒绝交互，也没有人为断开 SSH 或取消活动工具；相关边界目前由自动化测试覆盖。
- 活动 turn 断线不自动重连或重放；Host 重启后没有持久 reattach，远端孤儿 run 回收尚未实现。
- Adapter 取不到外层 `ResolvedToolSet`，条件注册工具可能返回 `UNKNOWN_TOOL`。
- 远端运行目录保存对话及含临时 MCP token 的私有配置；当前没有自动保留期限策略。

结论：模型选择（带版本编号、含 fable）、思考强度下发、额度读取均已在真实 VPS 验证；GUI 需重启应用后再人工复核。
