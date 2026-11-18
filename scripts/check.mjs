// Syntax-check every shipped JavaScript file. The list is discovered instead of
// hand-maintained so a new lib/ or test/ file cannot silently escape `npm run check`.
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const roots = ['index.js', 'client.js']

for (const dir of ['lib', 'test', 'scripts']) {
  const full = join(project, dir)
  let entries = []
  try { entries = readdirSync(full) } catch { continue }
  for (const name of entries) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue
    const path = join(full, name)
    if (statSync(path).isFile()) roots.push(join(dir, name))
  }
}

for (const file of roots) {
  execFileSync(process.execPath, ['--check', join(project, file)], { stdio: 'inherit' })
}
console.log(`syntax ok: ${roots.length} files`)
