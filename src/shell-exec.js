/**
 * SshShellExecutor — the plugin's `ctx.shell` provider (structural, not a
 * harness `ShellExecutor` subclass, so the bundle resolves with no harness
 * import and Cordis does not dual-package).
 *
 * Routing is decided by the SESSION, not by the workdir's spelling: inside a
 * remote workspace session every command runs on that remote host, whatever
 * form the workdir arrives in; only an ordinary local session runs locally.
 * `ssh://[user@]host[:port]/path` workdirs execute on the remote over ssh2
 * `exec`; local workdirs execute through `ctx.subprocess` + `ctx.sandbox` (the
 * same confinement the harness's `bash-sandbox`/`pwsh-sandbox` apply).
 *
 * This matters because the harness passes the model's explicit `workdir`
 * through verbatim when it is absolute (`tool-pwsh`'s `resolveWorkdir`), and an
 * agent in a remote session naturally spells it the way the REMOTE host does —
 * `C:\Windows\Temp` for `…/C--Windows--Temp`, `/data/x` for `/data`. Judging
 * routing by the path alone therefore sent those commands to the local DSH host.
 */

import { SshClient, shellQuote, PROBE_UNKNOWN_MSG } from './transport.js'
import { isRemoteCwd, parseSshUri } from './ssh-uri.js'
import { findByCwd } from './registry.js'
import { lstatSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

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

const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/
/** A drive path in the remote-spelled form the plugin stores and displays (`/C:/…`). */
const DRIVE_REMOTE_PATH = /^\/[A-Za-z]:(\/|$)/

/** The `ssh://` workdir that routes to this anchor at this remote path. */
function sshUriFor(rec, remotePath) {
  return `ssh://${rec.user ? `${rec.user}@` : ''}${rec.host}${rec.port ? `:${rec.port}` : ''}${remotePath}`
}

/** The anchor's own remote origin: `remotePath` plus the registered subpath. */
function anchorRemoteRoot(hit) {
  return hit.remoteSubpath === '' ? hit.remotePath : `${hit.remotePath.replace(/\/+$/, '')}/${hit.remoteSubpath}`
}

/** Absolute in EITHER host's spelling: the local host may not be the remote's OS. */
function isSpelledAbsolute(path) {
  return path.startsWith('/') || path.startsWith('\\') || DRIVE_PATH.test(path)
}

function isWindowsRemote(rec) {
  if (rec?.os?.family === 'windows') return true
  return typeof rec?.remotePath === 'string' && DRIVE_REMOTE_PATH.test(rec.remotePath)
}

/**
 * Spell an absolute workdir the way the REMOTE host spells paths, or
 * `undefined` when that path cannot belong to the remote (a Windows drive path
 * in a POSIX session) — the caller must then refuse rather than fall back to
 * the local machine. Windows remotes take the plugin's own `/C:/…` form, which
 * is what `anchors.json` stores and what remote `cd` receives.
 */
function remoteSpelling(workdir, rec) {
  const drive = DRIVE_PATH.exec(workdir)
  if (isWindowsRemote(rec)) {
    if (drive !== null) return `/${drive[1].toUpperCase()}:/${drive[2].replace(/\\/g, '/')}`.replace(/\/$/, '')
    if (DRIVE_REMOTE_PATH.test(workdir)) return workdir
    if (workdir.startsWith('\\\\')) return workdir.replace(/\\/g, '/').replace(/^\/+/, '//')
    return workdir.startsWith('/') ? workdir : undefined
  }
  if (workdir.startsWith('/')) return workdir
  return undefined
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
   * The session's own remote origin, read from the per-call sandbox policy:
   * `workspaceRoot` is the session cwd, which for a remote workspace session is
   * the local anchor path. `undefined` for an ordinary local session. This is
   * the routing key — the workdir alone is not (it arrives in the remote's own
   * spelling, which matches no anchor).
   */
  sessionAnchor(spec) {
    const root = this.policy(spec)?.workspaceRoot
    if (typeof root !== 'string' || root === '') return undefined
    return findByCwd(root)
  }

  /**
   * Translate the workdir into the execution world. A registered anchor (or an
   * `ssh://` URI) becomes an `ssh://host/remotepath` URI, as before. The new
   * rule: inside a REMOTE session, an absolute workdir the model spelled the
   * remote's way is routed to that remote instead of being taken for a local
   * path — the harness passes an absolute workdir through verbatim, so this is
   * what keeps `workdir: C:\Windows\Temp` (session `…\C--Windows--Temp`) from
   * silently running on the local DSH host. A path that cannot belong to the
   * session's host is left local-looking on purpose: {@link
   * assertNotLocalInRemoteSession} then refuses it loudly rather than guessing.
   * A local session keeps local paths local.
   */
  translateWorkdir(workdir, session) {
    if (typeof workdir !== 'string' || workdir === '') return workdir
    if (isRemoteCwd(workdir)) return workdir
    const hit = findByCwd(workdir)
    if (hit !== undefined) return sshUriFor(hit, anchorRemoteRoot(hit))
    if (session === undefined) return workdir
    if (isSpelledAbsolute(workdir)) {
      const spelled = remoteSpelling(workdir, session)
      return spelled === undefined ? workdir : sshUriFor(session, spelled)
    }
    // Relative: only reachable when a caller skipped the harness's own
    // session-cwd resolution — resolve it against the anchor, then re-route.
    const joined = resolvePath(session.anchorPath, workdir)
    const nested = findByCwd(joined)
    return nested === undefined ? joined : sshUriFor(nested, anchorRemoteRoot(nested))
  }

  /**
   * Invariant: inside a remote workspace session nothing may execute on the
   * LOCAL host. `resolve()` maps every workdir into the remote world, so a spec
   * that still carries a local workdir here either bypassed `resolve()` or names
   * a path that cannot exist on the remote (e.g. a drive path in a POSIX
   * session). Refuse loudly: silently running the command against the local DSH
   * host is how an agent ends up reading and writing the wrong machine's files.
   */
  assertNotLocalInRemoteSession(spec) {
    if (isRemoteCwd(spec.workdir)) return
    const session = this.sessionAnchor(spec)
    if (session === undefined) return
    const target = `${session.user ? `${session.user}@` : ''}${session.host}${session.port ? `:${session.port}` : ''}`
    throw new Error(
      `refusing to run locally: this session is the remote workspace ${target} (${anchorRemoteRoot(session)}), `
      + `but the workdir "${spec.workdir}" is not a path on that host — use a path relative to the workspace root, `
      + 'the workspace path itself, or an explicit ssh:// workdir',
    )
  }

  resolve(request) {
    const timeoutMs = clamp(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const stdoutMaxBytes = request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
    const session = this.sessionAnchor(request)
    // A remote session must never default to the DSH process cwd (the local
    // host's) when the caller omits a workdir.
    const workdir = request.workdir ?? session?.anchorPath ?? process.cwd()
    return {
      command: request.command,
      workdir: this.translateWorkdir(workdir, session),
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
    this.assertNotLocalInRemoteSession(spec)
    return this.localRun(spec)
  }

  start(spec) {
    if (isRemoteCwd(spec.workdir)) return this.remoteStart(spec)
    this.assertNotLocalInRemoteSession(spec)
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
    let streamCtl = null

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
        if (streamCtl !== null) streamCtl.terminate()
        else if (pid !== null) void client.run(`kill ${pid} 2>/dev/null || true`)
        return true
      },
      done: (async () => {
        const profile = await client.profile()
        if (profile.family === 'unknown') {
          // Never run the POSIX nohup launcher against an undetected host (a
          // Windows/cmd host would die on the `cd '…'` line with Win32 123).
          spawnError = new Error(PROBE_UNKNOWN_MSG)
          proc.status = 'killed'
          return
        }
        if (profile.family === 'windows') {
          // No nohup-style detach exists on Windows remotes, and closing the
          // channel alone does NOT reap the remote tree (verified) - so the
          // job is a long-lived exec stream whose terminate() actively
          // taskkill /T's the remote PID and then closes the channel.
          const ctl = await client.execStream(spec.command, { cwd: path })
          if (proc.status !== 'running') { ctl.terminate(); return }
          streamCtl = ctl
          const merge = () => {
            const outPart = ctl.readOut()
            const errPart = ctl.readErr()
            if (outPart.delta.length > 0) {
              if (buffer.length > 0 && !buffer.endsWith('\n')) buffer += '\n'
              buffer += outPart.delta
            }
            if (errPart.delta.length > 0) {
              if (buffer.length > 0 && !buffer.endsWith('\n')) buffer += '\n'
              buffer += '[stderr]\n' + errPart.delta
            }
          }
          if (spec.signal !== undefined) {
            const onAbort = () => { if (streamCtl !== null) streamCtl.terminate() }
            if (spec.signal.aborted) onAbort()
            else spec.signal.addEventListener('abort', onAbort, { once: true })
          }
          const pump = async () => {
            while (proc.status === 'running') {
              merge()
              await new Promise((r) => setTimeout(r, 150))
            }
          }
          void pump()
          const outcome = await ctl.exit
          merge()
          if (proc.status === 'running') proc.status = 'completed'
          if (outcome.error !== undefined) {
            spawnError = new Error(outcome.error)
            proc.status = 'killed'
            return
          }
          proc.exitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : null
          return
        }
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
