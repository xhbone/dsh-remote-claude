import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = resolve(project, 'local-dsh-remote-claude-0.1.3.tgz');
const archive = readFileSync(archivePath);
const tar = gunzipSync(archive);
const entries = new Map();
const text = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const field = (block, start, size) => text(block.subarray(start, start + size)).split('\0')[0];

for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const prefix = field(header, 345, 155);
  const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
  const size = parseInt(field(header, 124, 12).trim() || '0', 8);
  assert(Number.isSafeInteger(size) && size >= 0, `Invalid size: ${name}`);
  assert(offset + 512 + size <= tar.length, `Truncated entry: ${name}`);
  const type = String.fromCharCode(header[156]);
  assert(type === '0' || type === '\0' || type === '5', `Unexpected archive entry type: ${name}`);
  if (type !== '5') {
    assert(!entries.has(name), `Duplicate entry: ${name}`);
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}

const expected = [
  'package/package.json', 'package/index.js', 'package/client.js',
  'package/cordis.patch.yml', 'package/README.md', 'package/VALIDATION.md',
  'package/LICENSE', 'package/THIRD_PARTY_NOTICES.md', 'package/assets/remote-claude.svg',
  ...['adapter', 'claude-protocol', 'config-api', 'manager', 'mcp-gateway',
    'ndjson-cursor', 'remote-session', 'ssh-client', 'util'].map((name) => `package/lib/${name}.js`),
];
assert.deepEqual([...entries.keys()].sort(), expected.sort(), 'Archive must contain only the release allowlist');
const manifest = JSON.parse(text(entries.get('package/package.json')));
assert.equal(manifest.name, '@local/dsh-remote-claude');
assert.equal(manifest.version, '0.1.3');
assert(text(entries.get('package/VALIDATION.md')).includes('2.1.311'));
assert(text(entries.get('package/cordis.patch.yml')).includes('@local/dsh-remote-claude'));

for (const [name, source] of entries) {
  if (!name.endsWith('.js')) continue;
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: source, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(check.status, 0, `${name}: ${check.stderr || check.error || 'syntax check failed'}`);
}

const tests = spawnSync(process.execPath, ['--test', '--test-isolation=none', 'test/*.test.js'], {
  cwd: project, encoding: 'utf8', timeout: 60000,
});
writeFileSync(resolve(project, 'final-test-results-0.1.3.txt'), `${tests.stdout || ''}${tests.stderr || ''}`);
assert.equal(tests.status, 0, `Tests failed: ${tests.stderr || tests.error || tests.status}`);
const testCount = Number((tests.stdout || '').match(/tests (\d+)/)?.[1]);
assert.equal(testCount, 37, 'Expected the full 37-test regression suite');

const report = {
  status: 'passed', version: manifest.version, tests: testCount,
  archive: archivePath, archiveBytes: archive.length,
  archiveSha256: createHash('sha256').update(archive).digest('hex'),
  entries: [...entries.keys()].sort(),
  checkedAt: new Date().toISOString(),
};
writeFileSync(resolve(project, 'release-verification-0.1.3.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
