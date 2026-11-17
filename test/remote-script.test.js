import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCreateRunCommand, buildRunScript } from '../lib/remote-session.js'
import { remoteBaseExpression, shellQuote } from '../lib/util.js'

test('quotes shell values and rejects unsafe home-relative paths', () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`)
  assert.equal(remoteBaseExpression('.dsh-remote-claude'), `"$HOME"/'.dsh-remote-claude'`)
  assert.throws(() => remoteBaseExpression('../escape'))
})

test('remote script disables built-ins and confines access to local DSH MCP tools', () => {
  const script = buildRunScript({
    claudePath: '/usr/local/bin/claude',
    claudeSessionId: '550e8400-e29b-41d4-a716-446655440000',
    model: 'sonnet',
    restrictedMode: true,
  })
  assert.match(script, /--input-format stream-json/)
  assert.match(script, /--output-format stream-json/)
  assert.match(script, /--tools ''/)
  assert.match(script, /--strict-mcp-config/)
  assert.match(script, /mcp__local_dsh__\*/)
  assert.match(script, /--permission-prompts none/)
  assert.match(script, /--restricted/)
  assert.doesNotMatch(script, /dangerously-skip-permissions/)
})

test('create command transfers configuration as base64 and uses a detached process group', () => {
  const command = buildCreateRunCommand({
    remoteBaseDir: '.dsh-remote-claude', runId: 'run-id',
    mcpJson: '{"secret":"TOKEN"}', systemPrompt: 'prompt', runScript: '#!/bin/bash\nexit 0\n',
  })
  assert.match(command, /base64 -d/)
  assert.match(command, /setsid nohup bash -l/)
  assert.doesNotMatch(command, /TOKEN/)
})
