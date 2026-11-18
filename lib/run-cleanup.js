import { remoteBaseExpression } from './util.js'

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIN_STALE_MS = 60 * 60 * 1000

export function staleOrphanMs(idleSessionMs) {
  return Math.max(Number(idleSessionMs) * 2 || 0, MIN_STALE_MS)
}

/**
 * Bash script that tidies `<remoteBaseDir>/runs`. Output is one `reaped <id>` or
 * `removed <id>` line per action. Rules, in order, for every run directory:
 *  - names that are not UUIDs, symlinks, and runs in `keepRunIds` are never touched;
 *  - a run whose process is still alive is only terminated when its output has been
 *    silent for `staleMs` (another Host would have reaped it by then), and only after
 *    /proc confirms the pid really is this run's `run.sh` (guards against pid reuse);
 *    with `force` an unclaimed live run is terminated and its directory removed too;
 *  - a finished run is deleted once its last output is older than `retentionDays`
 *    (0 keeps everything). With `force` a finished run is deleted immediately.
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
is_run_process() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  kill -0 "$1" 2>/dev/null || return 1
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\\0' ' ' <"/proc/$1/cmdline" | grep -q 'run\\.sh' || return 1
  [ "$(readlink "/proc/$1/cwd" 2>/dev/null)" = "$(cd -- "$2" && pwd -P)" ] || return 1
  return 0
}
for d in "$runs"/*/; do
  d=\${d%/}
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  id=\${d##*/}
  case "$id" in ''|*[!0-9a-fA-F-]*) continue;; esac
  case "$skip" in *" $id "*) continue;; esac
  mt=$(stat -c %Y -- "$d/out.jsonl" 2>/dev/null || stat -c %Y -- "$d" 2>/dev/null || echo "$now")
  age=$((now - mt))
  pid=$(cat "$d/pid" 2>/dev/null || true)
  if [ ! -f "$d/exit" ] && is_run_process "$pid" "$d"; then
    if [ "$force" = 1 ]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      rm -rf -- "$d" && echo "reaped $id"
    elif [ "$age" -ge "$stale_secs" ]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      echo "reaped $id"
    fi
    continue
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

  /** Explicit user action: remove every finished run and reap unclaimed live runs; keepRunIds stay. */
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
