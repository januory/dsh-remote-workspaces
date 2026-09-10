import { Client } from 'ssh2'
import { createHash } from 'node:crypto'
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

/**
 * Convert a canonical REMOTE path — as the SFTP `realpath` reports it, which
 * is POSIX-style even on Windows hosts (`/X:/work/demo`) — into the form a
 * Windows shell accepts (`X:/work/demo`). PowerShell understands forward
 * slashes, so only a leading `/X:` drive prefix is stripped; everything else
 * passes through untouched.
 */
export function toWinPath(value) {
  const s = String(value ?? '')
  return /^\/[A-Za-z]:/.test(s) ? s.slice(1) : s
}

/** PowerShell single-quote escaping for a path/string literal. */
export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * First-input `cd` command that lands an interactive shell channel in `cwd`,
 * dialect-aware: POSIX single-quotes, PowerShell (cd = Set-Location) single-
 * quotes a forward-slash win path, and cmd.exe — where single quotes are
 * literal — uses double quotes + backslashes with `/d` to switch drive too.
 */
export function shellCdCommand(profile, cwd) {
  const p = profile ?? { family: 'unknown' }
  if (p.family === 'windows') {
    const winPath = toWinPath(cwd)
    if (p.shell === 'cmd') return `cd /d "${winPath.replace(/\//g, '\\')}"\r`
    return `cd ${psQuote(winPath)}\r`
  }
  return `cd ${shellQuote(cwd)}\r`
}

/**
 * Strip PowerShell progress records from a stderr capture. When a nested
 * powershell is launched by a Windows OpenSSH exec channel (e.g. the cmd
 * default-shell wrapper), the engine's first-run module-analysis warm-up emits
 * a `#< CLIXML …</Objs>` progress blob to stderr on every fresh process —
 * real cmdlet errors still arrive as plain text, so removing only CLIXML
 * blocks keeps genuine diagnostics intact.
 */
export function stripPsProgressClixml(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let inBlob = false
  for (const line of lines) {
    if (!inBlob && /#< CLIXML/i.test(line)) {
      inBlob = !/<\/Objs>/i.test(line)
      continue
    }
    if (inBlob) {
      if (/<\/Objs>/i.test(line)) { inBlob = false; continue }
      // XML record lines are dropped; a non-XML text line ends a truncated
      // blob so genuine diagnostics that follow it are preserved.
      if (!/^\s*</.test(line) && line.trim() !== '') { inBlob = false; out.push(line); continue }
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Whole-text CRLF→LF (Windows remote output normalization). */
export function crlfToLf(text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

/**
 * Streaming CRLF→LF normalizer that carries a trailing `\r` across chunk
 * boundaries (a `\r\n` pair may be split between two data events). `feed`
 * returns the normalized fragment; call `flush()` at stream end for a lone
 * trailing `\r` (isolated CRs are preserved, not folded).
 */
export function createCrlfToLf() {
  let carry = ''
  return {
    feed(text) {
      const s = String(text ?? '')
      let out = carry + s
      carry = ''
      out = out.replace(/\r\n/g, '\n')
      if (out.endsWith('\r')) {
        carry = '\r'
        out = out.slice(0, -1)
      }
      return out
    },
    flush() {
      const rest = carry
      carry = ''
      return rest
    },
  }
}

/**
 * Exit-code glue appended to every Windows remote script so the channel's
 * exit status mirrors what a POSIX shell reports: the last command's result.
 * `exit N` inside the user's own command terminates first and wins.
 */
const PS_EXIT_GLUE = 'if ($?) { exit $LASTEXITCODE } else { exit 1 }'

/**
 * Remote execution profiles, probed once per target and cached for the
 * process lifetime:
 *   { family: 'posix',  os: 'linux'|'darwin', shell: 'posix' }
 *   { family: 'windows', os: 'windows', shell: 'powershell'|'cmd' }
 *   { family: 'unknown', … } — callers fall back to POSIX behaviour.
 */
const REMOTE_PROFILE_CACHE = new Map()

export function profileCacheKey({ host, user, port }) {
  return `${user ?? ''}@${host ?? ''}:${port ?? 22}`
}

/**
 * Detect a target's OS family and default exec shell without parsing
 * localized output: `uname -s` proves a POSIX shell; the bare `ver` builtin
 * proves a cmd-default Windows host; a quoted nested `cmd /c "ver"` proves
 * Windows under a PowerShell default (PowerShell itself has no `ver`); a
 * `$PSVersionTable` expression then tells cmd from PowerShell as the default.
 *
 * Quoting matters on real cmd-default Windows hosts: OpenSSH wraps the exec
 * payload for cmd.exe in a way that mangles inner unquoted spaces — `cmd /c
 * ver` arrives as `ver"` and fails, while a bare single token (`ver`) and a
 * quoted inner command (`cmd /c "ver"`) both pass (verified on a real host).
 */
export async function probeRemoteProfile(client) {
  const uname = await client.run('uname -s')
  if (uname.ok) {
    const os = (uname.stdout ?? '').trim().toLowerCase()
    return { family: 'posix', os: os.startsWith('darwin') ? 'darwin' : 'linux', shell: 'posix' }
  }
  const ver = await client.run('ver')
  if (ver.ok) return { family: 'windows', os: 'windows', shell: 'cmd' }
  const nested = await client.run('cmd /c "ver"')
  if (nested.ok && /windows/i.test(nested.stdout ?? '')) {
    const ps = await client.run('$PSVersionTable.PSVersion.ToString()')
    return ps.ok
      ? { family: 'windows', os: 'windows', shell: 'powershell' }
      : { family: 'windows', os: 'windows', shell: 'cmd' }
  }
  const ps = await client.run('$PSVersionTable.PSVersion.ToString()')
  if (ps.ok) return { family: 'windows', os: 'windows', shell: 'powershell' }
  return { family: 'unknown', os: 'unknown', shell: 'unknown' }
}

/**
 * Error text used whenever a command cannot run because the remote profile
 * probe failed (family 'unknown'). Explicit instead of guessing a dialect:
 * sending a POSIX `cd 'x' || exit 1` script to a Windows/cmd host produces the
 * misleading "文件名、目录名或卷标语法不正确" (Win32 123) failure, and the
 * other way around is equally wrong — so callers refuse loudly.
 */
export const PROBE_UNKNOWN_MSG =
  'cannot determine the remote shell type (exec probe failed); command not executed. Check the host side: the account home/profile directory must exist, the OpenSSH DefaultShell must be valid, and the exec channel itself must be usable.'

/** Encode a PowerShell script for quote-safe transport through cmd.exe.
 *
 * `powershell -EncodedCommand` would be ideal (no quoting at all), but a
 * nested -EncodedCommand host serializes BOTH progress and error records to
 * stderr as CLIXML soup. A `-Command` host prints plain text, so instead the
 * script rides inside one fixed, quote-free command line: base64 has no
 * `% ! ^ " $ '` and the wrapper has no `$`, so neither cmd nor a PowerShell
 * outer shell can mangle it, and the inner text is decoded + `iex`'d.
 */
export function psCommandEnvelope(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell -NoProfile -NonInteractive -Command "& { iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'))) }"`
}

/**
 * Build the exec-channel script for one command under a remote profile.
 *
 * POSIX / unknown: unchanged legacy form (`cd 'x' || exit 1` + command).
 *
 * Windows with a PowerShell default shell: the raw script text is executed
 * by the server's default shell directly (cmdlets + aliases like ls/cat/cd
 * make simple commands work), prefixed with a `Set-Location` when a cwd is
 * given and suffixed with the exit-code glue. Windows with a cmd default
 * shell: the same script rides inside a fixed, quote-free
 * `powershell -Command` envelope (base64 + iex), so cmd only ever parses one
 * fixed command line, its exit code is the child's, and stderr stays plain
 * text (no CLIXML records).
 */
export function buildExecScript(profile, command, cwd) {
  if (profile === undefined) {
    return cwd ? `cd ${shellQuote(cwd)} || exit 1\n${command}` : command
  }
  if (profile.family === 'unknown') {
    // Never guess: a POSIX script against a Windows/cmd host dies on the first
    // line with Win32 123-style errors and never reaches the command.
    throw new Error(PROBE_UNKNOWN_MSG)
  }
  if (profile.family !== 'windows') {
    return cwd ? `cd ${shellQuote(cwd)} || exit 1\n${command}` : command
  }
  const script = [
    ...(cwd ? [`Set-Location -LiteralPath ${psQuote(toWinPath(cwd))}`] : []),
    command,
    PS_EXIT_GLUE,
  ].join('\n')
  return profile.shell === 'cmd' ? psCommandEnvelope(script) : script
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

/** Human-readable summary of an ssh2 connection/auth error (USER-facing). */
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
 * English counterpart of {@link describeError} for the messages the MODEL
 * reads. `execShell()` errors surface to the agent (the remote shell tool
 * result and the remote-`rg` tool error) and agent-facing text is English;
 * the Chinese set above stays on the paths a USER sees (the settings "test
 * connection" card, the Shell tab).
 */
function describeErrorEn(error) {
  const message = error && error.message ? error.message : String(error)
  if (/all configured authentication methods failed/i.test(message)) {
    return 'authentication failed: key/passphrase rejected or the server does not authorize this key'
  }
  if (/no suitable authentication methods/i.test(message)) {
    return 'the server accepts no supported authentication method'
  }
  if (/cannot parse privatekey/i.test(message)) {
    return `could not parse the private key (wrong passphrase or unsupported format): ${message}`
  }
  if (/encrypted private keys?|passphrase/i.test(message) && /incorrect/i.test(message)) {
    return `wrong private-key passphrase: ${message}`
  }
  if (/ECONNREFUSED|connect refused/i.test(message)) return 'connection refused (host or port unreachable)'
  if (/ETIMEDOUT|timeout/i.test(message)) return 'connection timed out'
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return 'cannot resolve the host address'
  if (/key exchange failed/i.test(message)) return 'key exchange failed (the server may not support the offered algorithms)'
  return message
}

/** Stage labels for a failed remote channel open, per audience. */
const CHANNEL_STAGE_USER = { connect: '连接', handshake: '握手', subsystem: 'SFTP 子系统', shell: 'shell 通道' }

/**
 * Message for a remote CHANNEL open that failed (the SFTP subsystem or an
 * interactive shell), carrying the target and the stage it died at.
 *
 * Same audience rule as the rest of the transport: `agentFacing` is English
 * because the model reads it (the file tools and the agent loop open channels
 * through here), the default is the Chinese text the settings card and the
 * Shell tab show the USER. The stage is the diagnostic that was missing when a
 * killed sshd listener surfaced as a bare "SFTP 连接超时": `connect` means the
 * TCP/SSH connection never came up, `handshake` means it was accepted but the
 * SSH handshake stalled, `subsystem`/`shell` means the authenticated connection
 * refused the channel itself.
 */
function channelOpenMessage({ what, agentFacing, timedOut, stage, target, cause }) {
  const detail = timedOut || cause === undefined || cause === '' ? '' : `: ${cause}`
  if (agentFacing) {
    return `${what} connection ${timedOut ? 'timed out' : 'failed'} (target: ${target}, stage: ${stage})${detail}`
  }
  return `${what} 连接${timedOut ? '超时' : '失败'}（目标：${target}，阶段：${CHANNEL_STAGE_USER[stage] ?? stage}）${detail}`
}

/**
 * Signatures of a command that failed because the SCRIPT DIALECT did not match
 * the host — i.e. the cached remote profile went stale because the host's
 * default shell changed (or sshd was reconfigured) under a long-lived DSH
 * process. Matching one clears the cached profile so the next call re-probes
 * instead of failing every command until DSH restarts.
 *
 * Deliberately narrow: almost every pattern names a wrapper token the plugin
 * itself emitted (`Set-Location`, the POSIX `||` glue, the `powershell`
 * envelope), so an ordinary failing command is not mistaken for dialect drift.
 * The one broad pattern is the Win32-123 phrasing a POSIX `cd` produces on
 * cmd.exe.
 */
const DIALECT_MISMATCH_PATTERNS = [
  // A raw PowerShell script (or a POSIX `cd`) handed to cmd.exe.
  /['"`]?Set-Location['"`]?[^\n]{0,80}(not recognized|不是内部或外部命令)/i,
  /['"`]?cd['"`]?[^\n]{0,80}(not recognized|不是内部或外部命令)/i,
  // The POSIX `cd 'x' || exit 1` line handed to cmd.exe: Win32 error 123.
  /(filename, directory name, or volume label syntax is incorrect|文件名、目录名或卷标语法不正确)/i,
  // The POSIX `||` glue handed to Windows PowerShell 5.1 (a parse error).
  /(not a valid statement separator|不是此版本中的有效语句分隔符)/i,
  // A PowerShell script handed to a POSIX shell.
  /Set-Location[:]?[^\n]{0,80}not found/i,
  // The cmd envelope needs a `powershell` binary, which a POSIX host lacks.
  /(^|[\s|;])['"`]?powershell['"`]?[^\n]{0,80}(not recognized|not found|不是内部或外部命令)/i,
]

function looksLikeDialectMismatch(text) {
  const s = String(text ?? '')
  if (s === '') return false
  return DIALECT_MISMATCH_PATTERNS.some((re) => re.test(s))
}

// ---------------------------------------------------------------------------
// Short-lived exec connection pool
// ---------------------------------------------------------------------------
// `run()`/`execShell()` used to open a brand-new ssh2 session (TCP connect +
// key exchange + authentication) for EVERY command. Parallel tool calls — a
// few grep/glob/file/shell ops in one step, or two sessions hitting the same
// host — therefore burst dozens of simultaneous handshakes at the remote
// sshd, which dropped connections under the load (`Connection lost before
// handshake`, `read ECONNRESET`). The pool bounds that handshake load to a
// few persistent connections per target; `exec` channels multiplex over
// them, so after warm-up a command costs no connection setup at all.
// Connections are evicted when they error or close, closed after being idle
// for `EXEC_POOL_IDLE_MS`, and a connection that carried an aborted
// (timed-out) command is drained then torn down so the remote session really
// ends (closing the exec channel alone does not reliably reap a Windows
// remote process tree).
const EXEC_POOL_MAX_CONNS = 3
const EXEC_POOL_IDLE_MS = 120_000
const EXEC_POOL_SWEEP_MS = 30_000
const EXEC_KEEPALIVE_MS = 15_000
const RETRY_DELAY_MS = 200
/** Open another pooled connection once current ones host at least this many channels. */
const CHANNELS_PER_CONN_SPREAD_AT = 3

const execPools = new Map()
let poolSweeper = null

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function evictPoolEntry(pool, entry) {
  const index = pool.conns.indexOf(entry)
  if (index >= 0) pool.conns.splice(index, 1)
  if (!entry.connEnded) {
    entry.connEnded = true
    try { entry.conn.end() } catch {}
  }
}

function sweepExecPools() {
  const now = Date.now()
  for (const pool of execPools.values()) {
    for (const entry of [...pool.conns]) {
      if (entry.open > 0) continue
      const idleTooLong = entry.alive && !entry.wantsDead && entry.idleSince > 0 && now - entry.idleSince >= EXEC_POOL_IDLE_MS
      if (idleTooLong || entry.wantsDead || !entry.alive) evictPoolEntry(pool, entry)
    }
  }
}

function ensurePoolSweeper() {
  if (poolSweeper === null) {
    poolSweeper = setInterval(sweepExecPools, EXEC_POOL_SWEEP_MS)
    if (typeof poolSweeper.unref === 'function') poolSweeper.unref()
  }
}

/** Connect an ssh2 Client and resolve once it is authenticated ('ready'). */
function connectClient(conn, config) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error) => {
      if (settled) return
      settled = true
      conn.removeListener('error', onError)
      if (error === undefined) resolve()
      else reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onError = (error) => done(error)
    conn.once('ready', () => done())
    conn.on('error', onError)
    try {
      conn.connect(config)
    } catch (error) {
      done(error)
    }
  })
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

  /** `user@host:port`, for diagnostics in connection-failure messages. */
  _targetLabel() {
    return `${this.user ? `${this.user}@` : ''}${this.host}:${Number(this.port) || 22}`
  }

  /**
   * Agent-facing (English) connection-error text, tagged with the target — the
   * model triages from this, and a bare "connection timed out" never said
   * WHICH host or WHICH stage died.
   */
  _agentError(error) {
    return `${describeErrorEn(error)} (target: ${this._targetLabel()})`
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
  /**
   * Run one remote command and capture its stdout/stderr. Returns the same
   * `{ ok, ms, exitCode, stdout, stderr, error }` shape the system-ssh
   * transport produced, so every higher-level method is unchanged.
   *
   * The command runs over a SHORT-LIVED pooled connection (see the exec pool
   * above): at most `EXEC_POOL_MAX_CONNS` SSH sessions are ever open per
   * target, so bursty parallel tool calls no longer present the remote sshd
   * with a fresh handshake per command. A failure that happened before the
   * command was sent (nothing ran remotely) retries once.
   *
   * `agentFacing: true` switches connection-failure text to English, for the
   * callers that surface it to the MODEL (background-job launches); the default
   * Chinese set is what the settings "test connection" card shows the USER.
   */
  async run(command, { input, timeoutMs, agentFacing = false } = {}) {
    const started = Date.now()
    const deadline = timeoutMs ?? this.timeoutMs
    const describe = agentFacing ? describeErrorEn : describeError
    // The agent-facing wording carries the target too (see `_agentError`).
    const describeFor = (error) => {
      const text = describe(error)
      return agentFacing ? `${text} (target: ${this._targetLabel()})` : text
    }
    for (let attempt = 0; ; attempt++) {
      let lease
      try {
        lease = await this._acquireExec()
      } catch (error) {
        if (attempt === 0) { await sleepMs(RETRY_DELAY_MS); continue }
        return { ok: false, ms: Date.now() - started, error: describeFor(error) }
      }
      const outcome = await this._execOnLease(lease, {
        command,
        input,
        deadline: Math.max(0, deadline - (Date.now() - started)),
        describe,
      })
      lease.release(outcome.healthy)
      if (!outcome.ok && attempt === 0 && outcome.presend) {
        await sleepMs(RETRY_DELAY_MS)
        continue
      }
      const result = { ...outcome.result, ms: Date.now() - started }
      if (!result.ok && agentFacing && typeof result.error === 'string' && result.error !== '') {
        result.error = `${result.error} (target: ${this._targetLabel()})`
      }
      if (!result.ok && (looksLikeDialectMismatch(result.error) || looksLikeDialectMismatch(result.stderr))) {
        this.invalidateProfile()
      }
      return result
    }
  }

  async exec(command, opts) {
    return this.run(command, opts)
  }

  /**
   * Run one remote command with the shell-executor contract: cwd, timeout,
   * bounded (tail-kept) stdout/stderr, stdin, and an abort signal that closes
   * the exec channel (SIGHUP on the remote). Resolves with exitCode/signal,
   * timedOut/aborted first-cause, and `{ text, truncated }` outputs.
   *
   * The command text is executed through the target's default shell. On
   * Windows targets the script is built per detected default shell
   * (`buildExecScript`): raw PowerShell when PowerShell is the default, a
   * quote-safe `powershell -EncodedCommand` wrapper when cmd is.
   */
  async execShell(command, { cwd, timeoutMs = 60000, stdoutMaxBytes = 64000, stderrMaxBytes = 64000, stdin, signal } = {}) {
    const profile = await this.profile()
    if (profile.family === 'unknown') {
      return { ok: false, error: PROBE_UNKNOWN_MSG }
    }
    const script = buildExecScript(profile, command, cwd)
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      let lease
      try {
        lease = await this._acquireExec()
      } catch (error) {
        if (attempt === 0) { await sleepMs(RETRY_DELAY_MS); continue }
        return { ok: false, error: this._agentError(error) }
      }
      const outcome = await this._execShellOnLease(lease, {
        script,
        profile,
        stdin,
        signal,
        deadline: Math.max(0, timeoutMs - (Date.now() - started)),
        stdoutMaxBytes,
        stderrMaxBytes,
      })
      lease.release(outcome.healthy)
      if (!outcome.ok) {
        if (looksLikeDialectMismatch(outcome.result.error)) this.invalidateProfile()
      } else if (outcome.result.exitCode !== 0 && looksLikeDialectMismatch(outcome.result.stderr?.text)) {
        // The host's shell drifted under the cached profile: drop it so the
        // next call re-probes instead of failing until DSH restarts.
        this.invalidateProfile()
      }
      if (!outcome.ok && attempt === 0 && outcome.presend) {
        await sleepMs(RETRY_DELAY_MS)
        continue
      }
      return outcome.result
    }
  }

  /**
   * Pool identity: target plus a credentials fingerprint (never logged).
   * Distinct credential sets for the same host:user:port stay in separate
   * pools so one machine's authenticated session is never reused by another.
   */
  _execPoolKey() {
    const base = `${this.user ?? ''}@${this.host}:${Number(this.port) || 22}`
    const creds = `${this.identityFile ?? ''}\n${this.password ?? ''}\n${this.passphrase ?? ''}`
    return `${base}#${createHash('sha1').update(creds).digest('hex').slice(0, 12)}`
  }

  /**
   * Take one pooled exec connection, opening a new ssh2 session only when the
   * pool is below its cap and the live connections are already spreading
   * several channels. Every acquire must be paired with exactly one
   * `lease.release()`.
   */
  async _acquireExec() {
    const key = this._execPoolKey()
    let pool = execPools.get(key)
    if (pool === undefined) {
      pool = { conns: [], creating: 0 }
      execPools.set(key, pool)
      ensurePoolSweeper()
    }
    for (;;) {
      const ready = pool.conns.filter((e) => e.state === 'ready' && e.alive && !e.wantsDead)
      if (ready.length > 0) {
        const best = ready.slice().sort((a, b) => a.open - b.open)[0]
        // Reuse when the pool is at its cap or this connection is still light;
        // otherwise fall through to open one more (bounded by the cap).
        if (pool.conns.length >= EXEC_POOL_MAX_CONNS || best.open < CHANNELS_PER_CONN_SPREAD_AT) {
          best.open += 1
          best.idleSince = 0
          return this._leaseFor(best, false)
        }
      }
      if (pool.conns.length + pool.creating < EXEC_POOL_MAX_CONNS) {
        pool.creating += 1
        try {
          const entry = await this._createPooledEntry(pool)
          entry.open += 1
          entry.idleSince = 0
          return this._leaseFor(entry, true)
        } finally {
          pool.creating -= 1
        }
      }
      // Pool saturated and no ready connection yet (the in-flight one is still
      // handshaking or all live connections are drained/dying): wait and
      // re-check instead of opening another handshake beyond the cap.
      await sleepMs(20)
    }
  }

  /**
   * Push a NEW entry onto the pool and connect it. The entry only becomes
   * reusable once it is authenticated ('ready'): concurrent acquires must
   * never hand an exec to a connection that is still in the handshake phase
   * (that corrupts the protocol stream and re-bursts the sshd).
   */
  async _createPooledEntry(pool) {
    const entry = {
      conn: new Client(), pool, state: 'connecting', alive: true, open: 0,
      idleSince: 0, wantsDead: false, connEnded: false,
    }
    pool.conns.push(entry)
    const config = { ...this.connectConfig(), keepaliveInterval: EXEC_KEEPALIVE_MS, keepaliveCountMax: 3 }
    entry.conn.on('error', () => evictPoolEntry(pool, entry))
    entry.conn.on('close', () => evictPoolEntry(pool, entry))
    try {
      await connectClient(entry.conn, config)
      entry.state = 'ready'
      return entry
    } catch (error) {
      evictPoolEntry(pool, entry)
      throw error
    }
  }

  _leaseFor(entry, fresh) {
    const lease = {
      conn: entry.conn,
      fresh,
      release(healthy) {
        entry.open = Math.max(0, entry.open - 1)
        if (healthy === false || !entry.alive) {
          entry.alive = false
          if (entry.open === 0) evictPoolEntry(entry.pool, entry)
          return
        }
        if (entry.open === 0 && !entry.wantsDead) entry.idleSince = Date.now()
      },
      teardown() {
        // Aborted op: end the whole connection once no other channel uses it
        // (closing the exec channel alone does not reliably reap the remote).
        entry.wantsDead = true
        if (entry.open <= 1) evictPoolEntry(entry.pool, entry)
      },
    }
    return lease
  }

  /**
   * Run one `exec` over an already-connected pooled lease. Resolves with
   * `{ ok, presend, healthy, result }`: `healthy` says whether the
   * underlying connection may stay pooled, `presend` is true when the
   * failure happened before the command reached the server (safe to retry).
   */
  _execOnLease(lease, { command, input, deadline, describe = describeError }) {
    return new Promise((resolve) => {
      const conn = lease.conn
      let settled = false
      let timer
      let stream = null
      const finish = (result, { healthy = true, presend = false } = {}) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        conn.removeListener('error', onConnError)
        resolve({ ok: result.ok, presend, healthy, result })
      }
      const onConnError = (error) => {
        finish({ ok: false, error: describe(error) }, { healthy: false, presend: stream === null })
      }
      conn.on('error', onConnError)
      timer = setTimeout(() => {
        finish({ ok: false, error: 'SSH 命令执行超时' }, { healthy: false, presend: false })
        // Drain-teardown: end the connection once this op is the only user.
        lease.teardown()
      }, Math.max(0, deadline))
      try {
        conn.exec(command, (err, s) => {
          if (settled) return
          if (err) {
            // exec failed before a channel existed -> the command never ran.
            finish({ ok: false, error: describe(err) }, { healthy: false, presend: true })
            return
          }
          stream = s
          let stdout = ''
          let stderr = ''
          s.on('data', (data) => { stdout += data })
          s.stderr.on('data', (data) => { stderr += data })
          s.on('close', (code) => {
            finish({ ok: code === 0, exitCode: code, stdout, stderr }, { healthy: true })
          })
          if (input === undefined) s.end()
          else s.end(String(input))
        })
      } catch (error) {
        finish({ ok: false, error: describe(error) }, { healthy: false, presend: true })
      }
    })
  }

  /**
   * execShell half over one pooled lease (bounded output, exit status, abort
   * and timeout with drain-teardown). Mirrors the standalone semantics.
   */
  _execShellOnLease(lease, { script, profile, stdin, signal, deadline, stdoutMaxBytes, stderrMaxBytes }) {
    return new Promise((resolve) => {
      const conn = lease.conn
      let settled = false
      let timedOut = false
      let aborting = false
      let timer
      let stream = null
      const finish = (result, { healthy = true, presend = false } = {}) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        conn.removeListener('error', onConnError)
        resolve({ ok: result.ok, presend, healthy, result })
      }
      const onConnError = (error) => {
        finish({ ok: false, error: this._agentError(error) }, { healthy: false, presend: stream === null })
      }
      const onAbort = () => {
        aborting = true
        try { if (stream !== null) stream.close() } catch {}
        lease.teardown()
      }
      conn.on('error', onConnError)
      if (signal !== undefined) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      timer = setTimeout(() => {
        timedOut = true
        try { if (stream !== null) stream.close() } catch {}
        finish({
          ok: true,
          exitCode: null,
          signal: null,
          timedOut: true,
          aborted: false,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }, { healthy: false })
        // Drain-teardown: end the connection once this op is the only user.
        lease.teardown()
      }, Math.max(0, deadline))
      try {
        conn.exec(script, (err, s) => {
          if (settled) return
          if (err) {
            // exec failed before a channel existed -> the command never ran.
            finish({ ok: false, error: this._agentError(err) }, { healthy: false, presend: true })
            return
          }
          stream = s
          const out = new CapCollector(stdoutMaxBytes)
          const errc = new CapCollector(stderrMaxBytes)
          s.on('data', (d) => out.push(d))
          s.stderr.on('data', (d) => errc.push(d))
          s.on('close', (code) => {
            const stdout = out.output()
            const stderr = errc.output()
            if (profile.family === 'windows') {
              stderr.text = crlfToLf(stripPsProgressClixml(stderr.text))
              stdout.text = crlfToLf(stdout.text)
            }
            finish({
              ok: true,
              exitCode: code,
              signal: null,
              timedOut: timedOut && !aborting,
              aborted: aborting && !timedOut,
              stdout,
              stderr,
            }, { healthy: !aborting })
          })
          if (stdin === undefined) s.end()
          else s.end(String(stdin))
        })
      } catch (error) {
        finish({ ok: false, error: this._agentError(error) }, { healthy: false, presend: true })
      }
    })
  }

  /**
   * Open an SFTP channel and resolve a promise-wrapped facade over it.
   * Resolves `{ conn, readdir, stat, readFile, writeFile, mkdir, unlink, realpath, end }`.
   */
  sftp({ agentFacing = false } = {}) {
    return new Promise((resolve, reject) => {
      const conn = new Client()
      let settled = false
      let timedOut = false
      let stage = 'connect'
      const fail = (error) => {
        if (settled) return
        settled = true
        try { conn.end() } catch {}
        const cause = error instanceof Error ? error.message : String(error)
        const wrapped = new Error(channelOpenMessage({
          what: 'SFTP',
          agentFacing,
          timedOut,
          stage,
          target: this._targetLabel(),
          cause: timedOut ? undefined : cause,
        }))
        if (error !== undefined && error !== null && error.code !== undefined) wrapped.code = error.code
        reject(wrapped)
      }
      const timer = setTimeout(() => { timedOut = true; fail(new Error('timeout')) }, this.readyTimeoutMs)
      conn.on('connect', () => { stage = 'handshake' })
      conn.on('ready', () => {
        stage = 'subsystem'
        conn.sftp((err, sftp) => {
          if (err) { clearTimeout(timer); fail(err); return }
          clearTimeout(timer)
          settled = true
          const call = (method) => (...args) => new Promise((res, rej) => {
            sftp[method](...args, (e, out) => { if (e) rej(e); else res(out) })
          })
          const facade = {
            conn,
            raw: sftp,
            alive: true,
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
            end: () => { facade.alive = false; try { conn.end() } catch {} },
          }
          // A dedicated SFTP connection lives as long as its holder needs it
          // (RoutingFileSystem keeps one per target). When the server drops or
          // resets it, flag the facade dead so holders reopen instead of
          // failing every later operation on a stale channel.
          conn.on('error', () => { facade.alive = false })
          conn.on('close', () => { facade.alive = false })
          resolve(facade)
        })
      })
      conn.on('error', (err) => { clearTimeout(timer); fail(err) })
      try { conn.connect(this.connectConfig()) } catch (err) { clearTimeout(timer); fail(err) }
    })
  }

  /**
   * Open an INTERACTIVE shell channel with a PTY — the remote half of the UI
   * Shell tool. ssh2 `conn.shell` + a pty is the same mechanism on POSIX and
   * Windows OpenSSH (ConPTY) remotes; the target's DefaultShell decides whether
   * the session is a login shell, cmd, or PowerShell, and its OS decides the
   * line endings. The channel merges stderr into stdout (one data stream) and
   * the bytes are passed through RAW — a PTY already emits terminal-ready CRLF
   * that xterm renders directly, so the exec-channel CRLF folding must NOT be
   * applied here.
   *
   * When `cwd` is given, the shell is chdir'd there as its first input (a
   * dialect-aware `cd`, probed once per target). The shell still starts at the
   * remote account's home; the `cd` is emitted into the PTY so the prompt and
   * every later command land in the requested directory.
   *
   * Resolves a handle compatible with the local PTY one:
   *   { output, write, terminate, resize, pid } where `output` is the ssh2
   *   stream (an EventEmitter emitting 'data' and 'close'), `resize` maps to
   *   `setWindow` (REACHABLE here, unlike the local seam — the S0 finding), and
   *   `terminate` closes the channel then ends the connection.
   */
  openShell({ rows = 24, cols = 80, term = 'xterm-256color', env, cwd } = {}) {
    const chdirPromise = cwd !== undefined && cwd !== null && cwd !== ''
      ? this.profile().then((profile) => shellCdCommand(profile, cwd)).catch(() => '')
      : Promise.resolve('')
    return chdirPromise.then((chdir) => new Promise((resolve, reject) => {
      const conn = new Client()
      let settled = false
      let timedOut = false
      let stage = 'connect'
      const fail = (error) => {
        if (settled) return
        settled = true
        try { conn.end() } catch {}
        const cause = error instanceof Error ? error.message : String(error)
        const wrapped = new Error(channelOpenMessage({
          what: 'SSH shell',
          agentFacing: false,
          timedOut,
          stage,
          target: this._targetLabel(),
          cause: timedOut ? undefined : cause,
        }))
        if (error !== undefined && error !== null && error.code !== undefined) wrapped.code = error.code
        reject(wrapped)
      }
      const timer = setTimeout(() => { timedOut = true; fail(new Error('timeout')) }, this.readyTimeoutMs)
      conn.on('connect', () => { stage = 'handshake' })
      conn.on('ready', () => {
        stage = 'shell'
        conn.shell({ term, rows, cols, ...(env ? { env } : {}) }, (err, stream) => {
          if (err) { clearTimeout(timer); fail(err); return }
          clearTimeout(timer)
          settled = true
          let closed = false
          stream.on('close', () => { closed = true })
          if (chdir !== '') stream.write(chdir)
          resolve({
            output: stream,
            pid: null,
            write(data) { if (!closed) { try { stream.write(data) } catch {} } },
            terminate() { try { stream.close() } catch {} try { conn.end() } catch {} },
            resize(r, c) { if (!closed) { try { stream.setWindow(r, c) } catch {} } },
          })
        })
      })
      conn.on('error', (connError) => { clearTimeout(timer); fail(connError) })
      try { conn.connect(this.connectConfig()) } catch (connectError) { clearTimeout(timer); fail(connectError) }
    }))
  }

  /**
   * Open a LONG-LIVED exec channel for streaming (used by background/start
   * jobs on Windows remotes, where no nohup-style detach exists and closing
   * the channel alone does NOT reliably reap the remote command tree — a kill
   * must actively `taskkill /T` the remote process first; the channel close
   * is only a fallback).
   *
   * The channel rides the SAME per-target connection pool as `run()` and
   * `execShell()`: N parallel background jobs multiplex over at most
   * `EXEC_POOL_MAX_CONNS` connections instead of opening one SSH session each.
   * A pooled connection is shared, so a job never ends it — `terminate()`
   * reaps the remote tree by PID and closes only its own channel, and only a
   * pid-less abort marks the connection for drain-teardown.
   *
   * On Windows the remote script is prefixed with a self-reporting PID line
   * (`DWSH_PID=<pid>`), which is parsed out of the first output chunk so the
   * controller can tree-kill the exact process. Resolves a controller:
   *   { readOut(), readErr() -> { delta, lossy }, exit: Promise<{exitCode}|{error}>, terminate() }
   */
  async execStream(command, { cwd, signal, stdoutMaxBytes = 16 * 1024 * 1024, stderrMaxBytes = 16 * 1024 * 1024 } = {}) {
    const profile = await this.profile()
    if (profile.family === 'unknown') {
      // Same explicit refusal as execShell: no dialect to build the script in.
      return {
        readOut: () => ({ delta: '', lossy: false }),
        readErr: () => ({ delta: '', lossy: false }),
        exit: Promise.resolve({ error: PROBE_UNKNOWN_MSG }),
        terminate() {},
      }
    }
    const windows = profile.family === 'windows'
    const ssh = this
    // The marker runs FIRST inside the same remote shell that owns the exec
    // channel (the raw PowerShell on PS-default hosts, the nested PowerShell
    // inside the -Command envelope on cmd-default hosts), so its $PID is the
    // process whose tree taskkill must reap.
    const markerCommand = windows ? "Write-Output ('DWSH_PID=' + $PID)\n" + command : command
    const script = buildExecScript(profile, markerCommand, cwd)
    let lease
    try {
      lease = await this._acquireExec()
    } catch (error) {
      // Same controller shape as a failed launch: the background tool learns
      // the reason through `exit` instead of an exception.
      return {
        readOut: () => ({ delta: '', lossy: false }),
        readErr: () => ({ delta: '', lossy: false }),
        exit: Promise.resolve({ error: this._agentError(error) }),
        terminate() {},
      }
    }
    return await new Promise((resolve) => {
      const conn = lease.conn
      const out = { buf: '', pos: 0, max: stdoutMaxBytes, lossy: false }
      const err = { buf: '', pos: 0, max: stderrMaxBytes, lossy: false }
      let stream
      let settled = false
      let released = false
      let pidResolve
      const pid = new Promise((res) => { pidResolve = res })
      // A stuck launch must not hold terminate() forever.
      const pidTimer = setTimeout(() => pidResolve(null), 8000)
      let exitResolve
      const exit = new Promise((res) => { exitResolve = res })
      // The pooled connection is SHARED with other channels (short execs and
      // sibling background jobs), so a finished job releases its lease instead
      // of ending the connection; `healthy: false` lets the pool drop the
      // connection once every channel on it is done.
      const release = (healthy) => {
        if (released) return
        released = true
        lease.release(healthy)
      }
      const finish = (value, { healthy = true } = {}) => {
        if (settled) return
        settled = true
        clearTimeout(pidTimer)
        conn.removeListener('error', onConnError)
        conn.removeListener('close', onConnClose)
        release(healthy)
        exitResolve(value)
      }
      const onConnError = (connError) => finish({ error: this._agentError(connError) }, { healthy: false })
      // A silent connection close (server dropped us without a DISCONNECT
      // packet) emits no 'error'; without this a long-lived job would never
      // settle — there is no channel timeout on a background job.
      const onConnClose = () => finish({ error: this._agentError(new Error('connection closed unexpectedly')) }, { healthy: false })
      conn.on('error', onConnError)
      conn.on('close', onConnClose)
      const push = (target) => (chunk) => {
        const piece = String(chunk)
        if (target.buf.length + piece.length > target.max) { target.lossy = true; return }
        target.buf += piece
      }
      const reader = (target) => () => {
        const delta = target.buf.slice(target.pos)
        target.pos = target.buf.length
        return { delta, lossy: target.lossy }
      }
      // Normalize Windows CRLF output to LF at the chunk boundary so a \r\n
      // split across data events still folds (isolated CRs are preserved).
      const outLf = windows ? createCrlfToLf() : null
      const errLf = windows ? createCrlfToLf() : null
      // The PID marker is the FIRST stdout line, but the first data chunk may
      // hold only part of it, so buffer head bytes until the line completes.
      let head = ''
      let markerResolved = false
      const onOut = (chunk) => {
        const text = outLf === null ? String(chunk) : outLf.feed(chunk)
        if (text === '') return
        if (markerResolved) { push(out)(text); return }
        head += text
        if (windows) {
          const m = /^DWSH_PID=(\d+)\r?\n/.exec(head)
          if (m !== null) {
            markerResolved = true
            clearTimeout(pidTimer)
            pidResolve(Number(m[1]))
            const rest = head.slice(m[0].length)
            head = ''
            if (rest.length > 0) push(out)(rest)
            return
          }
          if (head.length > 4096) {
            // Something else produced output first; give up on the marker.
            markerResolved = true
            clearTimeout(pidTimer)
            pidResolve(null)
            push(out)(head)
            head = ''
          }
          return
        }
        markerResolved = true
        clearTimeout(pidTimer)
        pidResolve(null)
        push(out)(head)
        head = ''
      }
      const onErr = (chunk) => {
        const text = errLf === null ? String(chunk) : errLf.feed(chunk)
        if (text !== '') push(err)(text)
      }
      // The pooled connection is already authenticated, so exec starts right
      // away — there is no per-job 'ready' to wait for.
      try {
        conn.exec(script, (execError, s) => {
          if (settled) return
          if (execError) { finish({ error: this._agentError(execError) }, { healthy: false }); return }
          stream = s
          s.on('data', onOut)
          s.stderr.on('data', onErr)
          s.on('close', (code) => {
            if (outLf !== null) { const rest = outLf.flush(); if (rest !== '') push(out)(rest) }
            if (errLf !== null) { const rest = errLf.flush(); if (rest !== '') push(err)(rest) }
            if (code !== 0 && looksLikeDialectMismatch(err.buf)) ssh.invalidateProfile()
            finish({ exitCode: code })
          })
          s.end()
        })
      } catch (error) {
        finish({ error: this._agentError(error) }, { healthy: false })
      }
      resolve({
        readOut: reader(out),
        readErr: reader(err),
        exit,
        terminate() {
          // On Windows the verified reaper is `taskkill /PID <pid> /T /F`; the
          // channel close is only a fallback. The connection stays pooled —
          // ending it would kill sibling jobs sharing it.
          const closeChannel = (healthy) => {
            try { if (stream) stream.close() } catch {}
            // Settle explicitly: the remote 'close' event is not guaranteed.
            finish({ exitCode: null }, { healthy })
          }
          pid.then((remotePid) => {
            if (typeof remotePid === 'number' && remotePid > 0) {
              void ssh.execShell(`taskkill /PID ${remotePid} /T /F`, {
                timeoutMs: 15000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096,
              }).catch(() => {}).finally(() => closeChannel(true))
            } else {
              // No PID to reap with: closing the channel alone does not
              // guarantee the remote tree dies, so drain-tear this connection
              // (it ends once no other channel uses it).
              lease.teardown()
              closeChannel(false)
            }
          })
        },
      })
    })
  }

  /**
   * Cached remote execution profile ({ family, os, shell }); probed once per
   * target and reused for the process lifetime. FAILED probes (family
   * 'unknown') are never cached, so the next call re-probes: a transient
   * failure or a host-side fix is picked up without restarting the process.
   */
  async profile() {
    const key = profileCacheKey(this)
    let profile = REMOTE_PROFILE_CACHE.get(key)
    if (profile === undefined) {
      profile = await probeRemoteProfile(this)
      if (profile.family === 'posix' || profile.family === 'windows') {
        REMOTE_PROFILE_CACHE.set(key, profile)
      }
    }
    return profile
  }

  /**
   * Drop the cached profile for this target (dialect drift self-heal). The next
   * `profile()` call re-probes; a failed probe is never cached, so re-probing
   * always sees the host's CURRENT default shell.
   */
  invalidateProfile() {
    REMOTE_PROFILE_CACHE.delete(profileCacheKey(this))
    this._os = undefined
  }

  async remoteOs() {
    if (this._os === undefined) {
      const profile = await this.profile()
      if (profile.family === 'posix') this._os = profile.os === 'darwin' ? 'darwin' : 'linux'
      else if (profile.family === 'windows') this._os = 'windows'
      else {
        const res = await this.run('uname -s')
        this._os = (res.stdout ?? '').trim().toLowerCase().startsWith('darwin') ? 'darwin' : 'linux'
      }
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
   * Remote file content hash for post-write verification. On POSIX targets
   * tries GNU `sha256sum` then BSD `shasum -a 256`; on Windows targets uses
   * PowerShell `Get-FileHash`. Returns the lowercase hex digest or
   * `undefined` when no such tool exists (verification is then skipped).
   * Locale-independent: the digest is hex, never localized text.
   */
  async sha256(path) {
    const profile = await this.profile()
    if (profile.family === 'windows') {
      const res = await this.execShell(
        `(Get-FileHash -LiteralPath ${psQuote(toWinPath(path))} -Algorithm SHA256).Hash.ToLower()`,
        { timeoutMs: 30000 },
      )
      if (res.exitCode === 0) {
        const hash = (res.stdout?.text ?? '').trim().toLowerCase()
        if (/^[0-9a-f]{64}$/.test(hash)) return hash
      }
      return undefined
    }
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
