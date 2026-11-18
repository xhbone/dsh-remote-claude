import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { HandoffStore } from '../lib/manager.js'

const config = { host: 'vps.test', username: 'workspace', remoteBaseDir: '.dsh-remote-claude' }
const tempFile = () => join(tmpdir(), `handoff-${randomUUID()}.json`)

test('handoff records survive a Host restart and can be deleted', () => {
  const file = tempFile()
  const store = new HandoffStore(config, { file })
  store.set('["session",""]', { claudeSessionId: 'claude-1', runId: 'run-1', count: 3, digest: 'abc' })
  assert.equal(store.get('["session",""]').claudeSessionId, 'claude-1')
  const reloaded = new HandoffStore(config, { file })
  assert.equal(reloaded.get('["session",""]').count, 3)
  reloaded.delete('["session",""]')
  assert.equal(reloaded.get('["session",""]'), undefined)
})

test('a missing or corrupt handoff file is treated as empty', () => {
  const store = new HandoffStore(config, { file: tempFile() })
  assert.equal(store.get('missing'), undefined)
})
