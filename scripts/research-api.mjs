import { writeFile } from 'node:fs/promises'
const url = 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages'
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
  const html = await response.text()
  const paths = [...new Set([...html.matchAll(/"path":"(packages\/[^"\\]+)"/g)].map(match => match[1]))]
  await writeFile(new URL('../research-api.txt', import.meta.url), JSON.stringify({ status: response.status, paths }, null, 2))
} catch (error) { await writeFile(new URL('../research-api.txt', import.meta.url), String(error)) }
