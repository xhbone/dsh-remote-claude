import { remoteBaseExpression } from './util.js'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIN_STALE_MS = 60 * 60 * 1000

export function staleOrphanMs(idleSessionMs) {
  return Math.max(Number(idleSessionMs) * 2 || 0, MIN_STALE_MS)
}

/**
 * Bash script that tidies `<remoteBaseDir>/runs`. Output is one `removed <id>`
 * line per action. Rules, in order, for every run directory:
 *  - names that are not UUIDs, symlinks, and runs in `keepRunIds` are never touched;
 *  - live or briefly unidentifiable runs are preserved. Silence does not establish
 *    ownership because another Host can have an idle or approval-blocked process;
 *  - finished runs expire after `retentionDays` (0 keeps them). `force` bypasses
 *    retention only for confirmed exits, or dead runs after the startup grace period.
 */
export function buildSweepScript({ remoteBaseDir, retentionDays, staleMs, keepRunIds = [], force = false }) {
  const days = Number(retentionDays)
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('retentionDays must be an integer between 0 and 3650')
  const stale = Math.floor(Number(staleMs) / 1000)
  if (!Number.isSafeInteger(stale) || stale < 60) throw new Error('staleMs must be at least 60000')
  const keep = [...new Set(keepRunIds)].filter((id) => RUN_ID.test(String(id)))
  return `set -u
base_dir=${remoteBaseExpression(remoteBaseDir)}
runs="$base_dir/runs"
[ -d "$runs" ] || exit 0
now=$(date +%s)
keep_secs=${days * 86400}
stale_secs=${stale}
force=${force ? 1 : 0}
skip=" ${keep.join(' ')} "
for d in "$runs"/*/; do
  d=\${d%/}
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  id=\${d##*/}
  [[ "$id" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] || continue
  case "$skip" in *" $id "*) continue;; esac
  mt=$(stat -c %Y -- "$d/out.jsonl" 2>/dev/null || stat -c %Y -- "$d" 2>/dev/null || echo "$now")
  age=$((now - mt))
  if [ ! -f "$d/exit" ]; then
    [ "$age" -ge "$stale_secs" ] || continue
    pid=$(cat "$d/pid" 2>/dev/null || true)
    case "$pid" in ''|0*|1|*[!0-9]*) continue;; esac
    if kill -0 "$pid" 2>/dev/null || kill -0 -- "-$pid" 2>/dev/null; then continue; fi
  fi
  if [ "$force" = 1 ] || { [ "$keep_secs" -gt 0 ] && [ "$age" -ge "$keep_secs" ]; }; then
    rm -rf -- "$d" && echo "removed $id"
  fi
done
exit 0
`
}

export function parseSweepOutput(stdout) {
  const result = { reaped: [], removed: [] }
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^(reaped|removed) ([0-9a-fA-F-]{36})$/.exec(line.trim())
    if (match) result[match[1]].push(match[2])
  }
  return result
}

/** Runs the sweep at most once per `intervalMs`; a failed sweep is retried on the next opportunity. */
export class RunSweeper {
  constructor({ intervalMs = 6 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.intervalMs = intervalMs
    this.now = now
    this.lastStartedAt = undefined
    this.running = undefined
  }

  due() {
    return !this.running && (this.lastStartedAt === undefined || this.now() - this.lastStartedAt >= this.intervalMs)
  }

  async run(ssh, config, keepRunIds) {
    if (!this.due() || !ssh?.ready) return undefined
    this.lastStartedAt = this.now()
    const script = buildSweepScript({
      remoteBaseDir: config.remoteBaseDir,
      retentionDays: config.retentionDays ?? 7,
      staleMs: staleOrphanMs(config.idleSessionMs),
      keepRunIds,
    })
    this.running = (async () => {
      try {
        const result = await ssh.exec('bash -s', { input: script })
        if (result.code !== 0) throw new Error(`Remote run cleanup failed: ${result.stderr.trim() || result.stdout.trim()}`)
        return parseSweepOutput(result.stdout)
      } catch (error) {
        this.lastStartedAt = undefined
        throw error
      } finally {
        this.running = undefined
      }
    })()
    return await this.running
  }

  /** Explicit user action: remove finished runs without waiting for retention. */
  async clean(ssh, config, keepRunIds) {
    if (!ssh?.ready) throw new Error('SSH connection is not ready')
    const script = buildSweepScript({
      remoteBaseDir: config.remoteBaseDir,
      retentionDays: 0,
      staleMs: 60 * 1000,
      keepRunIds,
      force: true,
    })
    const result = await ssh.exec('bash -s', { input: script })
    if (result.code !== 0) throw new Error(`Remote run cleanup failed: ${result.stderr.trim() || result.stdout.trim()}`)
    return parseSweepOutput(result.stdout)
  }
}
