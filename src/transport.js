import { Client } from 'ssh2'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { basename, dirname, join } from 'node:path/posix'
import { parseSshConfig } from './ssh-config.js'

/**
 * POSIX shell single-quote escaping for a remote path/command fragment.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Bounded output collector: keeps the TAIL of a stream, flags truncation. */
class CapCollector {
  constructor(maxBytes) {
    this.maxBytes = maxBytes
    this.tail = ''
    this.truncated = false
  }

  push(chunk) {
    const piece = String(chunk)
    if (this.tail.length + piece.length > this.maxBytes) {
      this.truncated = true
      this.tail = (this.tail + piece).slice(-this.maxBytes)
    } else {
      this.tail += piece
    }
  }

  output() {
    return { text: this.tail, truncated: this.truncated }
  }
}

/** Expand a leading `~` in a path (system ssh did this for us; ssh2 does not). */
function expandTilde(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return joinPath(homedir(), value.slice(2))
  return value
}

/**
 * Default location of the user's OpenSSH client config.
 */
export function defaultSshConfigPath(home = homedir()) {
  return joinPath(home, '.ssh', 'config')
}

/**
 * Read and parse `~/.ssh/config` into host blocks (empty array when absent).
 */
export function hostsFromConfig(configPath = defaultSshConfigPath()) {
  if (!existsSync(configPath)) return []
  return parseSshConfig(readFileSync(configPath, 'utf8'))
}

/**
 * Build an `SshClient` for an ssh-config alias, falling back to using the
 * alias directly as the host when it is not declared.
 */
export function clientForHost(alias, configPath = defaultSshConfigPath()) {
  const host = hostsFromConfig(configPath).find((entry) => entry.alias === alias)
  return host ? new SshClient(host) : new SshClient({ alias })
}

/** Human-readable summary of an ssh2 connection/auth error. */
function describeError(error) {
  const message = error && error.message ? error.message : String(error)
  if (/all configured authentication methods failed/i.test(message)) {
    return '认证失败：密钥/口令不匹配或服务器未授权该密钥'
  }
  if (/no suitable authentication methods/i.test(message)) {
    return '服务器不接受可用的认证方式'
  }
  if (/cannot parse privatekey/i.test(message)) {
    return `私钥解析失败（口令错误或格式不支持）：${message}`
  }
  if (/encrypted private keys?|passphrase/i.test(message) && /incorrect/i.test(message)) {
    return `私钥口令错误：${message}`
  }
  if (/ECONNREFUSED|connect refused/i.test(message)) return '连接被拒绝（主机或端口不可达）'
  if (/ETIMEDOUT|timeout/i.test(message)) return '连接超时'
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '无法解析主机地址'
  if (/key exchange failed/i.test(message)) return '密钥交换失败（服务器可能不支持所选算法）'
  return message
}

/**
 * One SSH connection target, executed in-process through the `ssh2` client.
 *
 * Unlike the previous system-`ssh` transport, this supports every auth method
 * the settings form collects — password, private key (with an optional
 * passphrase), and the local agent — so passphrase-protected keys and password
 * logins work identically on every platform with no `BatchMode` restriction.
 */
export class SshClient {
  constructor({
    alias,
    host,
    user,
    port,
    identityFile,
    password,
    passphrase,
    timeoutMs = 30000,
    readyTimeoutMs = 10000,
  } = {}) {
    this.alias = alias
    this.host = host ?? alias
    this.user = user
    this.port = port
    this.identityFile = identityFile ? expandTilde(identityFile) : undefined
    this.password = password || undefined
    this.passphrase = passphrase || undefined
    this.timeoutMs = timeoutMs
    this.readyTimeoutMs = readyTimeoutMs
    this._os = undefined
  }

  connectConfig() {
    const config = {
      host: this.host,
      port: Number(this.port) || 22,
      readyTimeout: this.readyTimeoutMs,
    }
    if (this.user) config.username = this.user
    if (this.password) {
      config.password = this.password
    } else if (this.identityFile) {
      config.privateKey = readFileSync(this.identityFile)
      if (this.passphrase) config.passphrase = this.passphrase
    } else {
      // No explicit credential: use the running agent when present, and let
      // ssh2 fall back to the platform default keys otherwise.
      if (process.env.SSH_AUTH_SOCK) config.agent = process.env.SSH_AUTH_SOCK
    }
    return config
  }

  /**
   * Run one remote command and capture its stdout/stderr. Returns the same
   * `{ ok, ms, exitCode, stdout, stderr, error }` shape the system-ssh
   * transport produced, so every higher-level method is unchanged.
   */
  async run(command, { input, timeoutMs } = {}) {
    const started = Date.now()
    const deadline = timeoutMs ?? this.timeoutMs
    return await new Promise((resolve) => {
      const conn = new Client()
      let settled = false
      let timer
      const settle = (result) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        try { conn.end() } catch {}
        resolve({ ...result, ms: Date.now() - started })
      }
      timer = setTimeout(() => settle({ ok: false, error: 'SSH 命令执行超时' }), deadline)

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) { settle({ ok: false, error: err.message }); return }
          let stdout = ''
          let stderr = ''
          stream.on('data', (data) => { stdout += data })
          stream.stderr.on('data', (data) => { stderr += data })
          stream.on('close', (code) => { settle({ ok: code === 0, exitCode: code, stdout, stderr }) })
          if (input === undefined) stream.end()
          else stream.end(String(input))
        })
      })
      conn.on('error', (error) => { settle({ ok: false, error: describeError(error) }) })

      try {
        conn.connect(this.connectConfig())
      } catch (error) {
        settle({ ok: false, error: describeError(error) })
      }
    })
  }

  async exec(command, opts) {
    return this.run(command, opts)
  }

  /**
   * Run one remote command with the shell-executor contract: cwd, timeout,
   * bounded (tail-kept) stdout/stderr, stdin, and an abort signal that closes
   * the exec channel (SIGHUP on the remote). Resolves with exitCode/signal,
   * timedOut/aborted first-cause, and `{ text, truncated }` outputs.
   */
  async execShell(command, { cwd, timeoutMs = 60000, stdoutMaxBytes = 64000, stderrMaxBytes = 64000, stdin, signal } = {}) {
    const script = cwd ? `cd ${shellQuote(cwd)} || exit 1\n${command}` : command
    return await new Promise((resolve) => {
      const conn = new Client()
      let settled = false
      let timedOut = false
      let timer
      let stream
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        try { conn.end() } catch {}
        resolve(result)
      }
      const killRemote = () => {
        try { if (stream) stream.close() } catch {}
        try { conn.end() } catch {}
      }
      timer = setTimeout(() => { timedOut = true; killRemote() }, timeoutMs)
      if (signal !== undefined) {
        if (signal.aborted) killRemote()
        else signal.addEventListener('abort', killRemote, { once: true })
      }
      conn.on('ready', () => {
        conn.exec(script, (err, s) => {
          if (err) { finish({ ok: false, error: err.message }); return }
          stream = s
          const out = new CapCollector(stdoutMaxBytes)
          const errc = new CapCollector(stderrMaxBytes)
          s.on('data', (d) => out.push(d))
          s.stderr.on('data', (d) => errc.push(d))
          s.on('close', (code) => {
            const aborted = signal !== undefined && signal.aborted
            finish({
              ok: true,
              exitCode: code,
              signal: null,
              timedOut: timedOut && !aborted,
              aborted: aborted && !timedOut,
              stdout: out.output(),
              stderr: errc.output(),
            })
          })
          if (stdin === undefined) s.end()
          else s.end(String(stdin))
        })
      })
      conn.on('error', (error) => finish({ ok: false, error: describeError(error) }))
      try { conn.connect(this.connectConfig()) } catch (error) { finish({ ok: false, error: describeError(error) }) }
    })
  }

  /**
   * Open an SFTP channel and resolve a promise-wrapped facade over it.
   * Resolves `{ conn, readdir, stat, readFile, writeFile, mkdir, unlink, realpath, end }`.
   */
  sftp() {
    return new Promise((resolve, reject) => {
      const conn = new Client()
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try { conn.end() } catch {}
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const timer = setTimeout(() => fail(new Error('SFTP 连接超时')), this.readyTimeoutMs)
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timer); fail(err); return }
          clearTimeout(timer)
          settled = true
          const call = (method) => (...args) => new Promise((res, rej) => {
            sftp[method](...args, (e, out) => { if (e) rej(e); else res(out) })
          })
          resolve({
            conn,
            raw: sftp,
            readdir: call('readdir'),
            stat: call('stat'),
            readFile: call('readFile'),
            writeFile: (path, data) => new Promise((res, rej) => {
              sftp.writeFile(path, data, (e) => { if (e) rej(e); else res() })
            }),
            mkdir: call('mkdir'),
            unlink: call('unlink'),
            rename: call('rename'),
            rmdir: call('rmdir'),
            realpath: call('realpath'),
            end: () => { try { conn.end() } catch {} },
          })
        })
      })
      conn.on('error', (err) => { clearTimeout(timer); fail(err) })
      try { conn.connect(this.connectConfig()) } catch (err) { clearTimeout(timer); fail(err) }
    })
  }

  async remoteOs() {
    if (this._os === undefined) {
      const res = await this.run('uname -s')
      this._os = (res.stdout ?? '').trim().toLowerCase().startsWith('darwin') ? 'darwin' : 'linux'
    }
    return this._os
  }

  async listDir(path) {
    const res = await this.run(`ls -1a ${shellQuote(path)}`)
    const entries = res.ok
      ? res.stdout.split('\n').filter((name) => name !== '' && name !== '.' && name !== '..')
      : []
    return { ...res, entries }
  }

  async readFile(path) {
    return this.run(`cat ${shellQuote(path)}`)
  }

  /** Simple, non-atomic write (P0). Prefer `writeAtomic`. */
  async writeFile(path, content) {
    return this.run(`cat > ${shellQuote(path)}`, { input: content })
  }

  /**
   * Atomic write: stream content into a private temp file in the same
   * directory, then rename over the target. A failed transfer never leaves a
   * half-written target.
   */
  async writeAtomic(path, content) {
    const template = join(dirname(path), `.dsh-${basename(path)}.tmp.XXXXXX`)
    const script = [
      `tmp=$(mktemp ${shellQuote(template)}) || exit 1`,
      `cat > "$tmp" || { rm -f "$tmp"; exit 1; }`,
      `mv -f "$tmp" ${shellQuote(path)} || { rm -f "$tmp"; exit 1; }`,
    ].join('\n')
    return this.run(script, { input: content })
  }

  /** Remote metadata: mtime (ms), size, and type. Absent path ⇒ ok=false. */
  async stat(path) {
    const os = await this.remoteOs()
    const fmt = os === 'darwin' ? "stat -f '%m|%z|%HT'" : "stat -c '%Y|%s|%F'"
    const res = await this.run(`${fmt} ${shellQuote(path)}`)
    if (!res.ok) return res
    const parts = (res.stdout ?? '').trim().split('|')
    if (parts.length < 3) return { ...res, ok: false, error: `unexpected stat output: ${res.stdout}` }
    const rawType = (parts[2] ?? '').toLowerCase()
    return {
      ...res,
      mtimeMs: Number(parts[0]) * 1000,
      size: Number(parts[1]),
      type: rawType.includes('director') ? 'directory' : rawType.includes('regular') ? 'file' : 'other',
    }
  }

  /**
   * Literal find-and-replace: read, replace locally, write atomically.
   * `replaceAll=false` requires exactly one match; true replaces every match.
   */
  async editText(path, oldString, newString, replaceAll = false) {
    const read = await this.readFile(path)
    if (!read.ok) return read
    const content = read.stdout
    let matches = 0
    let offset = 0
    while (true) {
      const found = content.indexOf(oldString, offset)
      if (found < 0) break
      matches += 1
      offset = found + oldString.length
    }
    if (matches === 0) return { ok: false, ms: read.ms, error: 'old_string not found' }
    if (!replaceAll && matches !== 1) {
      return { ok: false, ms: read.ms, error: `old_string matched ${matches} times` }
    }
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
    return this.writeAtomic(path, next)
  }

  async canonicalPath(path) {
    return this.run(`realpath ${shellQuote(path)}`)
  }

  async remove(path) {
    return this.run(`rm -f ${shellQuote(path)}`)
  }

  /**
   * Remote file content hash for post-write verification. Tries GNU
   * `sha256sum` then BSD `shasum -a 256`; returns the lowercase hex digest or
   * `undefined` when no such tool exists (verification is then skipped).
   * Locale-independent: the digest is hex, never localized text.
   */
  async sha256(path) {
    for (const cmd of [`sha256sum ${shellQuote(path)}`, `shasum -a 256 ${shellQuote(path)}`]) {
      const res = await this.run(`${cmd} 2>/dev/null`)
      if (res.ok) {
        const hash = (res.stdout ?? '').trim().split(/\s+/)[0]
        if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase()
      }
    }
    return undefined
  }
}
