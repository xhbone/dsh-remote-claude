import { SshClient } from './ssh-client.js'
import { shellQuote } from './util.js'
import { normalizeModels } from './model-catalog.js'

// No user prompt is sent: only read-only control requests run, so discovery
// costs no额度. Account identity and credentials are deliberately not returned.
// Control responses answer without a user message (verified on Claude Code
// 2.1.311), which is what keeps this probe free.
export const PROBE_PYTHON = `import sys,json,subprocess,selectors,os,signal,time
cfg=json.load(sys.stdin)
args=[cfg['path'],'-p','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--permission-prompts','none','--no-session-persistence']
if cfg.get('restricted'):
    args.append('--restricted')
p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
sel=selectors.DefaultSelector()
sel.register(p.stdout,selectors.EVENT_READ)
result={}
buf=b''
pending=set(['probe-init','probe-models','probe-usage','probe-version'])
deadline=time.monotonic()+20
def request(rid,sub,**kw):
    p.stdin.write((json.dumps({'type':'control_request','request_id':rid,'request':dict(subtype=sub,**kw)})+chr(10)).encode())
    p.stdin.flush()
try:
    request('probe-init','initialize')
    request('probe-models','list_models')
    request('probe-usage','get_usage',skip_behaviors=True)
    request('probe-version','get_binary_version')
    while time.monotonic()<deadline and pending:
        if not sel.select(0.2):
            if p.poll() is not None:
                break
            continue
        data=os.read(p.stdout.fileno(),65536)
        if not data:
            break
        buf+=data
        if len(buf)>2097152:
            break
        while b'\\n' in buf:
            line,buf=buf.split(b'\\n',1)
            try:
                event=json.loads(line)
            except Exception:
                continue
            if event.get('type')!='control_response':
                continue
            response=event.get('response') or {}
            rid=response.get('request_id')
            if rid not in pending:
                continue
            pending.discard(rid)
            if response.get('subtype')!='success':
                continue
            payload=response.get('response') or {}
            if rid=='probe-models':
                result['models']=payload.get('models') or []
            elif rid=='probe-usage':
                result['usage']=payload
            elif rid=='probe-version':
                result['version']=payload.get('version')
finally:
    sel.close()
    try:
        os.killpg(p.pid,signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid,signal.SIGKILL)
        p.wait()
print(json.dumps(result))
`

export async function probeRemote(ctx, config, signal) {
  const ssh = new SshClient(config, { resolvePassword: async ref => (await ctx.credentials.resolve(ref))?.value })
  try {
    await ssh.connect(signal)
    const result = await ssh.exec(`python3 -c ${shellQuote(PROBE_PYTHON)}`, {
      signal, maxBytes: 4 * 1024 * 1024,
      input: JSON.stringify({ path: config.claudePath, restricted: config.restrictedMode }),
    })
    if (result.code !== 0) throw new Error('Remote model discovery failed')
    const raw = JSON.parse(result.stdout)
    const models = normalizeModels(raw.models)
    if (!models.length) throw new Error('Claude list_models did not return a model catalog')
    return {
      models,
      version: typeof raw.version === 'string' ? raw.version.slice(0, 64) : undefined,
      usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : null,
    }
  } finally { await ssh.dispose() }
}
