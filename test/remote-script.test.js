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

test('enables the full builtin tool set on explicit opt-in', () => {
  const script = buildRunScript({
    claudePath: '/usr/local/bin/claude',
    claudeSessionId: '550e8400-e29b-41d4-a716-446655440000',
    model: 'sonnet',
    remoteBuiltinTools: 'all',
  })
  assert.doesNotMatch(script, /--tools/)
  assert.match(script, /Read,Write,Edit,Glob,Grep,Bash/)
  assert.match(script, /mcp__local_dsh__\*/)
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

test('resumes a saved Claude session and can enable the remote web tools', () => {
  const script = buildRunScript({
    claudePath: '/usr/local/bin/claude',
    claudeSessionId: '550e8400-e29b-41d4-a716-446655440000',
    resumeSessionId: 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    model: 'sonnet',
    restrictedMode: false,
    allowRemoteWebTools: true,
  })
  assert.match(script, /--resume 'a3b1c2d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'/)
  assert.doesNotMatch(script, /--session-id/)
  assert.match(script, /--tools 'WebSearch,WebFetch'/)
  assert.match(script, /--allowedTools 'mcp__local_dsh__\*,WebSearch,WebFetch'/)
})
