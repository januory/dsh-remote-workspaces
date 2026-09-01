/**
 * SshShellExecutor — the plugin's `ctx.shell` provider (structural, not a
 * harness `ShellExecutor` subclass, so the bundle resolves with no harness
 * import and Cordis does not dual-package).
 *
 * Routes by the resolved workdir: `ssh://[user@]host[:port]/path` workdirs
 * execute on the remote over ssh2 `exec`; ordinary local workdirs execute
 * locally through `ctx.subprocess` + `ctx.sandbox` (the same confinement the
 * harness's `bash-sandbox`/`pwsh-sandbox` apply).
 */

import { SshClient, shellQuote } from './transport.js'
import { isRemoteCwd, parseSshUri } from './ssh-uri.js'
import { findByCwd } from './registry.js'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_STDOUT_MAX_BYTES = 64_000
const DEFAULT_STDERR_MAX_BYTES = 64_000
const SPILL_MAX_BYTES = 64 * 1024 * 1024
const GRACE_MS = 3_000

function clamp(value, fallback, max) {
  const v = value === undefined ? fallback : value
  if (!Number.isFinite(v) || v <= 0) return fallback
  return Math.min(v, max)
}

/** Fused timeout + cancellation deadline (mirrors the harness's `deadline`). */
function makeDeadline(signal, timeoutMs) {
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, timeoutMs)
  const onAbort = () => { if (!timedOut) ac.abort(signal.reason) }
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    },
  }
}

function matchesSignature(exitCode, stderr, signatures) {
  if (exitCode === null || exitCode === 0) return false
  const lowered = String(stderr).toLowerCase()
  return signatures.some((s) => lowered.includes(String(s).toLowerCase()))
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the pwsh executable (mirrors the harness's `resolvePwshPath`): the
 * Windows ACL runner needs a full path (a bare `pwsh` fails CreateProcessAsUser
 * with Win32 error 2), so probe PowerShell 7, PATH entries, then PowerShell 5.1.
 */
function resolvePwshPath() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length > 0) candidates.push(join(trimmed, 'pwsh.exe'))
  }
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) {
    try {
      const st = lstatSync(candidate)
      if (st.isFile() || st.isSymbolicLink()) return candidate
    } catch {}
  }
  return 'pwsh'
}

/** Parse a resolved remote workdir (`ssh://…`) into connection parts. */
function parseRemoteWorkdir(workdir) {
  const parsed = parseSshUri(workdir)
  if (parsed === null) return null
  return { host: parsed.host, user: parsed.user, port: parsed.port, path: parsed.path }
}

export class SshShellExecutor {
  constructor({ clientForRemote, getPolicy, getSandbox, getSubprocess }) {
    this.clientForRemote = clientForRemote
    this.getPolicy = getPolicy
    this.getSandbox = getSandbox
    this.getSubprocess = getSubprocess
  }

  /** Local half confines under workspace-write; the tool wires per-session policy. */
  get sandboxMode() {
    return 'workspace-write'
  }

  /**
   * Translate the workdir into the execution world: a registered anchor (or
   * `ssh://` URI) becomes an `ssh://host/remotepath` URI; local paths pass
   * through. The URI prefix is the run/start routing marker.
   */
  translateWorkdir(workdir) {
    if (typeof workdir !== 'string' || workdir === '') return workdir
    if (isRemoteCwd(workdir)) return workdir
    const hit = findByCwd(workdir)
    if (hit === undefined) return workdir
    const path = hit.remoteSubpath === '' ? hit.remotePath : `${hit.remotePath.replace(/\/+$/, '')}/${hit.remoteSubpath}`
    return `ssh://${hit.user ? `${hit.user}@` : ''}${hit.host}${hit.port ? `:${hit.port}` : ''}${path}`
  }

  resolve(request) {
    const timeoutMs = clamp(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const stdoutMaxBytes = request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
    return {
      command: request.command,
      workdir: this.translateWorkdir(request.workdir ?? process.cwd()),
      timeoutMs,
      stdoutMaxBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec) {
    if (isRemoteCwd(spec.workdir)) return this.remoteRun(spec)
    return this.localRun(spec)
  }

  start(spec) {
    if (isRemoteCwd(spec.workdir)) return this.remoteStart(spec)
    return this.localStart(spec)
  }

  // -------------------------------------------------------------------------
  // Remote (ssh2 exec)
  // -------------------------------------------------------------------------
  clientFor(spec) {
    const parsed = parseRemoteWorkdir(spec.workdir)
    if (parsed === null) throw new Error(`cannot parse remote workdir "${spec.workdir}"`)
    return {
      client: this.clientForRemote(parsed.host, parsed.user, parsed.port),
      path: parsed.path,
    }
  }

  /**
   * A remote command refused because the policy cannot be enforced on the
   * remote host: `read-only` and `workspace-write` would both be bypassed by
   * arbitrary remote code (there is no directory-level sandbox on the remote),
   * so under either mode the command does not run. The result reports the
   * shared sandbox denial (the tool layer turns it into the `[sandbox: …]`
   * marker + escalation hint), and the command can still run after the user
   * approves a `sandbox_permissions: danger-full-access` escalation.
   */
  deniedRemoteResult(spec, mode) {
    return {
      exitCode: 1, signal: null, timedOut: false, aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode, denied: true },
    }
  }

  async remoteRun(spec) {
    const policy = this.policy(spec)
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      return this.deniedRemoteResult(spec, policy.mode)
    }
    const { client, path } = this.clientFor(spec)
    const result = await client.execShell(spec.command, {
      cwd: path,
      timeoutMs: spec.timeoutMs,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES,
      ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
      ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
    })
    if (!result.ok) {
      return {
        exitCode: null, signal: null, timedOut: false, aborted: spec.signal?.aborted === true,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: result.error ?? '', truncated: false },
      }
    }
    return {
      exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, aborted: result.aborted,
      timeoutMs: spec.timeoutMs, stdout: result.stdout, stderr: result.stderr,
      sandbox: { mode: 'danger-full-access', denied: false },
    }
  }

  remoteStart(spec) {
    const policy = this.policy(spec)
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      return {
        status: 'completed',
        exitCode: 1,
        signal: null,
        sandbox: { mode: policy.mode, denied: true },
        readOutput() { return { delta: '', lossy: false } },
        kill() { return false },
        done: Promise.resolve(),
      }
    }
    const parsed = parseRemoteWorkdir(spec.workdir)
    const client = this.clientForRemote(parsed.host, parsed.user, parsed.port)
    const path = parsed.path
    const log = `${path.replace(/\/+$/, '')}/.dsh-bg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`
    const launchScript = `cd ${shellQuote(path)} || exit 1\nnohup sh -c ${shellQuote(spec.command)} > ${shellQuote(log)} 2>&1 &\necho $!`

    let pid = null
    let offset = 0
    let buffer = ''
    let spawnError
    let pollTimer

    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      sandbox: { mode: 'danger-full-access', denied: false },
      readOutput() {
        const delta = buffer.slice(offset)
        offset = buffer.length
        return { delta, lossy: false }
      },
      kill() {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        if (pid !== null) void client.run(`kill ${pid} 2>/dev/null || true`)
        return true
      },
      done: (async () => {
        const launched = await client.run(launchScript)
        if (!launched.ok) {
          spawnError = new Error((launched.stderr ?? '').trim() || launched.error || 'background spawn failed')
          proc.status = 'killed'
          return
        }
        const parsedPid = Number((launched.stdout ?? '').trim())
        if (!Number.isFinite(parsedPid) || parsedPid <= 0) {
          spawnError = new Error('background spawn failed: no pid')
          proc.status = 'killed'
          return
        }
        pid = parsedPid
        // Poll the log into the buffer (readOutput stays synchronous).
        const poll = async () => {
          if (proc.status !== 'running') return
          const tail = await client.run(`tail -c +${offset + 1} ${shellQuote(log)} 2>/dev/null || true`)
          if (tail.ok && tail.stdout) { buffer += tail.stdout; }
          pollTimer = setTimeout(poll, 500)
        }
        pollTimer = setTimeout(poll, 500)
        // Poll pid liveness until it exits.
        for (;;) {
          const alive = await client.run(`kill -0 ${pid} 2>/dev/null && echo yes || echo no`)
          if (alive.stdout?.trim() === 'no' || proc.status !== 'running') break
          await new Promise((r) => setTimeout(r, 500))
        }
        if (proc.status === 'running') proc.status = 'completed'
        clearTimeout(pollTimer)
      })().catch((error) => {
        spawnError = error
        proc.status = 'killed'
      }),
    }
    return proc
  }

  // -------------------------------------------------------------------------
  // Local (ctx.subprocess + ctx.sandbox confine)
  // -------------------------------------------------------------------------
  argv(spec) {
    return process.platform === 'win32'
      ? [resolvePwshPath(), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command]
      : ['bash', '-c', spec.command]
  }

  confine(argv, policy) {
    if (policy === undefined || policy.mode === 'danger-full-access') {
      return { argv, enforcement: undefined, denialSignatures: [] }
    }
    const sandbox = this.getSandbox()
    if (!sandbox) throw new Error('sandbox backend unavailable: refusing to run unconfined')
    return sandbox.confine(argv, {
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      ...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {}),
    })
  }

  policy(spec) {
    return spec.sandboxPolicy ?? this.getPolicy()?.resolve?.()
  }

  spawnSpec(spec, argv, stdoutMaxBytes, signal) {
    const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: SPILL_MAX_BYTES } })
    return {
      argv,
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(DEFAULT_STDERR_MAX_BYTES),
      },
      graceMs: GRACE_MS,
      signal,
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
    }
  }

  async localRun(spec) {
    const policy = this.policy(spec)
    const confined = this.confine(this.argv(spec), policy)
    const subprocess = this.getSubprocess()
    if (!subprocess) throw new Error('subprocess service unavailable')
    const d = makeDeadline(spec.signal, spec.timeoutMs)
    let handle
    try {
      handle = subprocess.spawn(this.spawnSpec(spec, confined.argv, spec.stdoutMaxBytes, d.signal))
    } catch (error) {
      d.dispose()
      throw new Error(`sandbox runner failed to start: ${messageOf(error)}`)
    }
    const outcome = await handle.done
    const timedOut = d.timedOut()
    const aborted = d.signal.aborted && !timedOut
    d.dispose()
    const { stdout, stderr } = handle.collected
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: stdout ? this.finalOutput(stdout) : { text: '', truncated: false },
      stderr: stderr ? this.finalOutput(stderr) : { text: '', truncated: false },
      ...(policy !== undefined && policy.mode !== 'danger-full-access' ? {
        sandbox: {
          mode: policy.mode,
          denied: matchesSignature(outcome.exitCode, stderr?.readFrom(0).text ?? '', confined.denialSignatures),
          enforcement: confined.enforcement,
        },
      } : {}),
    }
  }

  finalOutput(reader) {
    const read = reader.readFrom(0)
    return { text: read.text, truncated: read.lossy, ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}) }
  }

  localStart(spec) {
    const policy = this.policy(spec)
    const confined = this.confine(this.argv(spec), policy)
    const subprocess = this.getSubprocess()
    if (!subprocess) throw new Error('subprocess service unavailable')
    const running = subprocess.spawn(this.spawnSpec(spec, confined.argv, DEFAULT_STDOUT_MAX_BYTES, spec.signal))
    const { stdout, stderr } = running.collected
    let spawnFailureNote
    const consumeSpawnFailure = () => { const n = spawnFailureNote ?? ''; spawnFailureNote = undefined; return n }
    let outOffset = 0
    let errOffset = 0
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        if (policy !== undefined && policy.mode !== 'danger-full-access') {
          proc.sandbox = {
            mode: policy.mode,
            denied: matchesSignature(outcome.exitCode, stderr?.readFrom(0).text ?? '', confined.denialSignatures),
            enforcement: confined.enforcement,
          }
        }
      }, (error) => {
        proc.status = 'killed'
        spawnFailureNote = `spawn failed: ${messageOf(error)}`
      }),
      readOutput() {
        const out = stdout ? stdout.readFrom(outOffset) : { text: '', nextOffset: 0, lossy: false }
        const err = stderr ? stderr.readFrom(errOffset) : { text: '', nextOffset: 0, lossy: false }
        outOffset = out.nextOffset
        errOffset = err.nextOffset
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
          ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
        }
      },
      kill() {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }
}

export default SshShellExecutor
