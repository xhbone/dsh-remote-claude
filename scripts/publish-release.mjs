// Create (or reuse) the GitHub Release for a version tag and upload the packed
// plugin tarball as its asset. Token comes from GH_TOKEN / GITHUB_TOKEN in the
// environment; it is never written to disk by this script.
//
//   GH_TOKEN=... node scripts/publish-release.mjs 0.3.0
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: GH_TOKEN=... node scripts/publish-release.mjs <x.y.z>');
  process.exit(2);
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('missing GH_TOKEN');
  process.exit(2);
}

const OWNER = 'xhbone';
const REPO = 'dsh-remote-claude';
const TAG = `v${version}`;
const ARCHIVE = resolve(project, `local-dsh-remote-claude-${version}.tgz`);
const ASSET = `local-dsh-remote-claude-${version}.tgz`;
const API = 'https://api.github.com';
const HEADERS = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-remote-claude-release',
  'X-GitHub-Api-Version': '2022-11-28',
};

const BODY = `在 VPS 上运行 Claude Code 的 Agent Loop，文件、搜索、编辑、终端、审批与工具结果留在本机 DSH 工作区。

本版新增会话 composer 下方的活动条：实时显示远端阶段（准备/思考中/输出中/调用工具/等待权限）、已用与静默时间、token 与成本，并提供「暂停」（发 interrupt，约 1 秒内结束当前 turn，远端进程与会话保留，再发消息即可从原上下文继续）与「停止」（回收远端进程）。

- 新增 \`lib/activity.js\`（活动状态机与环形快照）与 \`lib/control-api.js\`（\`GET/POST /api/remote-claude/activity\`）
- stream-json 投影补充 thinking、tool_use、compact、init 的模型/版本、interrupted 结果字段
- 思考强度可随模型 \`supportedEffortLevels\` 选择，作为 \`--effort\` 传给远端
- 自动化测试 91 项全通过；已在真实 VPS 的 Claude Code 2.1.311 上验证

安装：\`pnpm add "C:\\\\path\\\\to\\\\${ASSET}"\`，再把 \`"@local/dsh-remote-claude"\` 加进 profile \`package.json\` 的 \`dsh.profile.bundles\`，重启 DSH。详见随包 \`INSTALL.md\`。

要求 DSH \`>=0.2.1-rc.2 <0.3.0-0\`、Node.js \`>=22.19.0\`，VPS 上需专用非 root 用户并已登录 Claude Code。`;

async function api(path, init = {}) {
  const res = await fetch(path.startsWith('https://') ? path : `${API}${path}`, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

const size = statSync(ARCHIVE).size;
const bytes = readFileSync(ARCHIVE);
console.log(`archive ${ARCHIVE} (${size} bytes)`);

let release = (await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`)).json;
if (!release || !release.id) {
  const created = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: version,
      body: BODY,
      draft: false,
      prerelease: false,
    }),
  });
  if (!created.ok) {
    console.error('create release failed', created.status, created.text.slice(0, 800));
    process.exit(1);
  }
  release = created.json;
  console.log('created release', release.id, release.html_url);
} else {
  console.log('release already exists', release.id, release.html_url);
  const edited = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: version, body: BODY, draft: false, prerelease: false }),
  });
  if (edited.ok) release = edited.json;
}

const existing = (release.assets || []).find((asset) => asset.name === ASSET);
if (existing) {
  console.log('removing stale asset', existing.id);
  const del = await api(`/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' });
  if (!del.ok) { console.error('delete asset failed', del.status, del.text.slice(0, 400)); process.exit(1); }
}

const base = release.upload_url.replace(/\{.*$/, '');
const uploaded = await api(`${base}?name=${encodeURIComponent(ASSET)}&label=${encodeURIComponent(ASSET)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(size) },
  body: bytes,
});
if (!uploaded.ok) {
  console.error('upload failed', uploaded.status, uploaded.text.slice(0, 800));
  process.exit(1);
}
console.log(JSON.stringify({
  release: release.html_url,
  tag: TAG,
  asset: uploaded.json.name,
  assetBytes: uploaded.json.size,
  download: uploaded.json.browser_download_url,
}, null, 2));
