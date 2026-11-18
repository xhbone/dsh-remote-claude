# 安装到其他电脑

本插件是标准的 DSH bundle 包：`@local/dsh-remote-claude`。安装包是同目录下的 `local-dsh-remote-claude-0.3.3.tgz`，解包后是 `package/` 目录，包含 Host 入口、Client 包、preset 补丁、文档和 `test/`（可离线复现测试）。

## 1. 导出

只需要两个文件：

- `local-dsh-remote-claude-0.3.3.tgz`（纯源码，不含 `node_modules`，含 `test/`）
- 本文件

如果目标机器**不能联网**，改为复制整个源码目录（含 `node_modules`，其中已装好 `ssh2` 与 `@deepseek-ai/schemastery`）：

```text
dsh-remote-claude\
  index.js  client.js  lib\  assets\  cordis.patch.yml  package.json  node_modules\
```

`test/` 只在复现自动化测试时需要，不影响运行；不要复制 `*.tgz` 与 `final-test-results-*.txt`。

## 1.5 从 GitHub 安装（推荐）

源码仓库建议设为**私有**：本包改造自没有 LICENSE 的 `HEYD66/claude-bridge`，公开分发存在授权风险（详见 `THIRD_PARTY_NOTICES.md`）。

安装包可以在仓库的 Release 附件里下载，也可以直接从仓库装。目标机器需要已获得该私有仓库的权限（SSH key 或 token）。

```powershell
# 方式 1：直接装 git 依赖（私有仓库需本机 SSH key 已授权给 GitHub）
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "git+ssh://git@github.com/<你的账号>/dsh-remote-claude.git#v0.3.3"
```

```powershell
# 方式 2：克隆后以本地目录安装（改源码、调试时用）
git clone git@github.com:<你的账号>/dsh-remote-claude.git C:\src\dsh-remote-claude
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "C:\src\dsh-remote-claude"
```

```powershell
# 方式 3：装 Release 里的 tgz（无需 git 权限，最省事）
pnpm add "C:\path\to\local-dsh-remote-claude-0.3.3.tgz"
```

三种方式都要手动把 `"@local/dsh-remote-claude"` 补进 profile `package.json` 的 `dsh.profile.bundles`，然后重启 DSH。

## 2. 目标机器前置条件

- DSH 桌面版 `>=0.2.1-rc.2`，Node.js `>=22.19.0`（DSH 自带运行时即可）。插件会特性探测 `ctx.tools.execute` 与 `ctx.agents`。
- 目标机器能 SSH 到同一台 VPS；VPS 上是专用非 root 用户，已安装并登录 Claude Code（建议 2.1.311）；需要 Bash、GNU tail（`--pid`）、base64、setsid、nohup。模型目录与额度刷新不再依赖远端 `python3`。
- SSHD 允许仅绑定回环地址的 remote forwarding，不要 `GatewayPorts yes`。

## 3. 安装（二选一）

profile 目录：

- Windows：`%USERPROFILE%\.dsh\profiles\desktop`
- macOS/Linux：`~/.dsh/profiles/desktop`

### 方式 A：图形界面（推荐）

1. 把 `local-dsh-remote-claude-0.3.3.tgz` 拷到目标机器。
2. 打开 DSH → 设置 → 插件，选择「从本地文件安装 / 安装本地 bundle」，选中该 tgz。
3. 等待安装完成，重启 DSH 桌面应用（Client 包在重启时构建）。

如果你的版本没有本地文件安装入口，用方式 B。

### 方式 B：命令行

```powershell
# Windows PowerShell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add "C:\path\to\local-dsh-remote-claude-0.3.3.tgz"
```

```bash
# macOS / Linux
cd ~/.dsh/profiles/desktop
pnpm add /path/to/local-dsh-remote-claude-0.3.3.tgz
```

然后编辑同一个目录下的 `package.json`，把包名加入 `dsh.profile.bundles` 数组（**必须手动加**，`pnpm add` 不会自动选中 bundle）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "@local/dsh-remote-claude"
      ]
    }
  }
}
```

保存后重启 DSH 桌面应用。

离线机器改用整个目录：

```powershell
pnpm add "C:\path\to\dsh-remote-claude"
```

`file:` 依赖会直接链接该目录，`node_modules` 里已有的 `ssh2`、`@deepseek-ai/schemastery` 会被复用，无需联网。`@deepseek-ai/dsh-llm` 等 peer 包由 DSH 运行时提供，不必单独安装。

> 实测（pnpm 12）：`pnpm add <tgz>` 会把 `ssh2@1.17.0`、`@deepseek-ai/schemastery@3.18.5` 和 peer `@deepseek-ai/dsh-llm@0.2.1-rc.4` 装进 profile 的 `.pnpm`，安装后插件目录能正常 `require('ssh2')`。如果 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`（`ssh2`、`cpu-features` 的构建脚本被拦截），这不会影响运行（ssh2 有纯 JS 回退）；要消除提示，在 profile 的 `package.json` 加：

```json
{ "pnpm": { "onlyBuiltDependencies": ["ssh2", "cpu-features"] } }
```

> 然后再执行一次 `pnpm add`（或 `pnpm rebuild`）。

## 4. 首次配置

1. 重启后打开左侧「插件」→ `@local/dsh-remote-claude` →「Remote Claude 连接设置」。
2. 填 `host`、`port`（默认 22）、`username`、`claudePath`（如 `/home/workspace/.local/bin/claude`）、`knownHostFingerprint`。
3. 指纹用可信链路核对，不要把首次连接看到的直接当可信值：

   ```bash
   ssh-keyscan -p 22 your-vps.example | ssh-keygen -lf - -E sha256
   ```

4. 先点「测试连接」：它一次检查 SSH 认证、指纹、bash/setsid/GNU tail、`claudePath` 与回环端口转发，失败项会给出机器码与操作提示。指纹不一致时可用「使用此指纹」显式确认。
5. 密码认证：在 `passwordRef` 填凭据引用名（如 `DSH_REMOTE_CLAUDE_SSH_PASSWORD`），在专用密码框输入 VPS 密码；密码只写入本机 DSH Credentials，不写进插件配置、命令或远端文件。用私钥或 agent 时填对应字段即可，不需要清空 `passwordRef`。
6. 点击「刷新模型与额度」。它通过 SSH 在远端跑一次只读的 Claude Code 控制请求（不需要用户消息，**不消耗额度**），成功后会看到模型目录、Claude Code 版本与 5 小时 / 7 天 / 模型专属窗口的额度。
7. 选择模型（下拉显示 `显示名 · 实际模型 ID`，含 `fable`）与思考强度；需要时在「远端运行环境」卡片调整 `remoteBaseDir`、`idleSessionMs`、`connectTimeoutMs`、`turnIdleTimeoutMs`、`turnReconnectAttempts`、`auxiliaryModel`、`retentionDays`、`restrictedMode`、`remoteBuiltinTools`，最后点击「保存 Remote Claude 连接」。

## 5. 使用与验证

1. 新建会话，选择 `Remote Claude` preset。
2. 模型选择器里选 provider `remote-claude`，可选 `claude-code-agent`（用配置里的 `claudeModel`），也可以直接选目录里的具体模型，如 `claude-fable-5-2`。
3. 发一句话验证往返，例如让它读一个本机文件；工具调用会回到本机 DSH 管线。
4. 额度卡片应显示真实百分比与重置时间；如需更新，重新点「刷新模型与额度」。

## 6. 常见问题

- **安装后看不到插件页**：多半是忘了把包名加进 `dsh.profile.bundles`，或没有重启应用（Client 包只在启动时构建）。
- **刷新报「无法读取远端模型目录与额度」**：先点「测试连接」，按返回的机器码逐项修复（`CLAUDE_NOT_FOUND`、`CLAUDE_UNRESPONSIVE`、`FORWARD_DENIED` 等）。错误信息不会包含远端诊断细节，可在 VPS 上手动执行 `claude --version` 复核。
- **思考强度下拉是灰的**：当前模型没有声明 `supportedEffortLevels`（例如 `claude-haiku-4-5-20251001`），此时不会传 `--effort`，属正常行为。
- **选中的档位报错**：该档位不在模型的 `supportedEffortLevels` 内（例如某些 4.6 模型没有 `xhigh`），插件不会静默降级，请换档位。
- **`@local/...` 安装失败**：`@local` 只是本地包名，安装的是 tgz 本身，不需要发布到 npm。
