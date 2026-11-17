import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { Client } from 'ssh2'
import { abortError, expandLocalPath, normalizeFingerprint, throwIfAborted } from './util.js'

const MAX_EXEC_BYTES = 4 * 1024 * 1024

export function sha256Fingerprint(key) {
  const base64 = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${base64}`
}

export class SshClient {
  constructor(config, { resolvePassword, createClient = () => new Client() } = {}) {
    this.config = config
    this.resolvePassword = resolvePassword
    this.createClient = createClient
    this.client = undefined
    this.ready = false
    this.observedFingerprint = undefined
    this.forward = undefined
  }

  async connect(signal) {
    if (this.ready && this.client) return
    throwIfAborted(signal)
    validateConnectionConfig(this.config)
    const privateKey = this.config.privateKeyPath
      ? await readFile(expandLocalPath(this.config.privateKeyPath))
      : undefined
    // Resolve at connection time so a rotated credential is used on reconnect.
    // Keep the value out of Config, session state, and the remote run files.
    const password = this.config.passwordRef
      ? await this.resolvePassword?.(this.config.passwordRef)
      : undefined
    if (this.config.passwordRef && !password) {
      throw new Error(`SSH password credential is not configured: ${this.config.passwordRef}`)
    }
    throwIfAborted(signal)
    const client = this.createClient()
    this.client = client
    this.observedFingerprint = undefined
    const expected = normalizeFingerprint(this.config.knownHostFingerprint)

    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        client.end()
        finish(reject, abortError(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      client.once('ready', () => finish(resolve))
      client.on('error', (error) => {
        if (this.observedFingerprint && normalizeFingerprint(this.observedFingerprint) !== expected) {
          finish(reject, new Error(`SSH host fingerprint mismatch. Expected ${this.config.knownHostFingerprint}; observed ${this.observedFingerprint}`))
        } else {
          finish(reject, error)
        }
      })
      client.once('close', () => {
        if (this.client === client) {
          this.ready = false
          this.forward = undefined
        }
        finish(reject, new Error('SSH connection closed before becoming ready'))
      })
      client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        ...(privateKey ? { privateKey } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(this.config.agent ? { agent: this.config.agent } : {}),
        readyTimeout: this.config.connectTimeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          const observed = sha256Fingerprint(key)
          this.observedFingerprint = observed
          return normalizeFingerprint(observed) === expected
        },
      })
    })
    this.ready = true
  }

  async exec(command, { signal, maxBytes = MAX_EXEC_BYTES, input } = {}) {
    const timeout = AbortSignal.timeout(this.config.connectTimeoutMs || 20000)
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const stream = await this.openExec(command, { signal })
    const stdout = []
    const stderr = []
    let total = 0
    return await new Promise((resolve, reject) => {
      let exitCode = undefined
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = () => {
        stream.close()
        finish(reject, abortError(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const collect = (target, chunk) => {
        total += chunk.length
        if (total > maxBytes) {
          stream.close()
          finish(reject, new Error(`SSH command output exceeded ${maxBytes} bytes`))
          return
        }
        target.push(chunk)
      }
      stream.on('data', (chunk) => collect(stdout, Buffer.from(chunk)))
      stream.stderr.on('data', (chunk) => collect(stderr, Buffer.from(chunk)))
      stream.on('exit', (code) => { exitCode = code })
      stream.on('error', (error) => finish(reject, error))
      stream.on('close', () => finish(resolve, {
        code: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }))
      if (input !== undefined) stream.end(input)
    })
  }

  async openExec(command, { signal } = {}) {
    throwIfAborted(signal)
    if (!this.ready || !this.client) throw new Error('SSH connection is not ready')
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError(signal))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.client.exec(command, (error, stream) => {
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else if (signal?.aborted) {
          stream.close()
          reject(abortError(signal))
        } else resolve(stream)
      })
    })
  }

  async reverseForward(localPort, requestedRemotePort = 0) {
    if (!this.ready || !this.client) throw new Error('SSH connection is not ready')
    if (this.forward) return this.forward
    let boundPort = 0
    const handler = (info, accept, reject) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== boundPort) {
        reject()
        return
      }
      const channel = accept()
      const socket = net.connect({ host: '127.0.0.1', port: localPort })
      socket.once('error', () => channel.destroy())
      channel.once('error', () => socket.destroy())
      socket.pipe(channel).pipe(socket)
    }
    this.client.on('tcp connection', handler)
    try {
      boundPort = await new Promise((resolve, reject) => {
        this.client.forwardIn('127.0.0.1', requestedRemotePort, (error, port) => error ? reject(error) : resolve(port))
      })
    } catch (error) {
      this.client.off('tcp connection', handler)
      throw error
    }
    const close = async () => {
      if (!this.forward) return
      this.client?.off('tcp connection', handler)
      const active = this.forward
      this.forward = undefined
      if (this.ready && this.client) {
        await new Promise((resolve) => this.client.unforwardIn('127.0.0.1', active.remotePort, () => resolve()))
      }
    }
    this.forward = { remotePort: boundPort, close }
    return this.forward
  }

  async dispose() {
    await this.forward?.close().catch(() => {})
    this.forward = undefined
    const client = this.client
    this.client = undefined
    this.ready = false
    client?.end()
  }
}

function validateConnectionConfig(config) {
  if (!config.host) throw new Error('Remote Claude host is not configured')
  if (!config.username) throw new Error('Remote Claude SSH username is not configured')
  if (!config.knownHostFingerprint) throw new Error('knownHostFingerprint is required; trust-on-first-use is intentionally disabled')
  if (config.passwordRef && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.passwordRef)) {
    throw new Error('passwordRef must be a valid credential reference name')
  }
  if (config.passwordRef && (config.privateKeyPath || config.agent)) {
    throw new Error('Choose passwordRef or privateKeyPath/agent, not both')
  }
  if (!config.privateKeyPath && !config.agent && !config.passwordRef) {
    throw new Error('Configure privateKeyPath, an SSH agent socket, or passwordRef')
  }
}
