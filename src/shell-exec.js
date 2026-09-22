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

import { SshClient, shellQuote, PROBE_UNKNOWN_MSG, reapPidCommand } from './transport.js'
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

/**
 * Mirror of the harness's `classifyRunnerFailure`
 * (`packages/sandbox/sandbox/src/diagnostics.ts`). DSH 0.1.7 hands the selected
 * backend's structured `runnerFailureRules` back from `confine()`: a runner
 * that failed BEFORE executing the command produces fatal stderr evidence,
 * which must outrank a policy denial (the command never ran) and gate the
 * denial signatures behind it. Each rule needs a nonzero exit (optionally
 * listed in `allowedExitCodes`), informational lines excluded by exact
 * case-insensitive equality, then a fatal signature on one remaining line.
 */
function classifyRunnerFailure(exitCode, stderr, rules) {
  if (exitCode === null || exitCode === undefined || exitCode === 0) return undefined
  const lines = String(stderr).split(/\r?\n/)
  for (const rule of rules ?? []) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informational = new Set((rule.informationalLines ?? []).map((line) => String(line).toLowerCase()))
    const fatal = (rule.fatalSignatures ?? [])
      .filter((signature) => String(signature).trim().length > 0)
      .map((signature) => String(signature).toLowerCase())
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informational.has(lowered)) continue
      if (fatal.some((signature) => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

/**
 * A runner failure is infrastructure, not a command result. The harness throws
 * a `SandboxUnavailableError` here (`@deepseek-ai/dsh-sandbox`); this plugin
 * cannot import it without dual-packaging the harness, so the plain error
 * carries the same name and stable code for structured consumers.
 */
function runnerFailureError(mode, detail) {
  const error = new Error(
    `sandbox mode "${mode}" was requested but the sandbox runner failed before the command could run; `
    + `refusing to run the command unconfined. Runner failure: ${detail}`,
  )
  error.name = 'SandboxUnavailableError'
  error.code = 'SANDBOX_UNAVAILABLE'
  return error
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A non-consuming offset reader over text the executor retains. It is the
 * `observed` half of a process handle: independent consumers (the job
 * registry's output pump) read at their own offsets without stealing bytes
 * from the consuming {@link SshShellExecutor} `readOutput()` cursor.
 */
function textReader(getText, getLossy = () => false) {
  return {
    readFrom(fromByte) {
      const text = getText()
      const from = Number.isFinite(fromByte) && fromByte > 0 ? Math.min(Math.floor(fromByte), text.length) : 0
      return { text: text.slice(from), nextOffset: text.length, lossy: getLossy() }
    },
  }
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
      // DSH 0.1.7-alpha.2 moved the run()/start() split into the spec: `kill`
      // (the default) arms the foreground deadline, `none` is the background
      // contract where the caller bounds its own wait.
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * The legacy foreground half. DSH 0.1.7-alpha.2 replaced the run()/start()
   * pair with {@link execute}, which returns the live handle; this path is
   * unchanged and still backs `onExpiry: 'kill'`.
   */
  async run(spec) {
    if (isRemoteCwd(spec.workdir)) return this.remoteRun(spec)
    this.assertNotLocalInRemoteSession(spec)
    return this.localRun(spec)
  }

  /**
   * The legacy background half, and the `onExpiry: 'none'` half of
   * {@link execute}. Async because confinement preparation is async on
   * DSH >= 0.1.6-alpha.1; the handles it returns are full `ShellExecution`s so
   * either generation of consumer finds what it needs.
   */
  async start(spec) {
    if (isRemoteCwd(spec.workdir)) return this.remoteStart(spec)
    this.assertNotLocalInRemoteSession(spec)
    return await this.localStart(spec)
  }

  /**
   * The DSH >= 0.1.7-alpha.2 seam (commit d6bebc5783 "feat(shell): converge on
   * execute()"): ONE method returns the live handle and the caller decides
   * what it wants from it — `result()` for a foreground outcome, or the handle
   * itself as a job. The old run()/start() split rides the spec's `onExpiry`:
   * `'kill'` (the default) is the foreground half, `'none'` the background one.
   *
   * Without this method the harness's `bash`/`pwsh` tools threw
   * `ctx.shell.execute is not a function`. With a jobs registry present they
   * also route EVERY foreground call through `onExpiry: 'none'` (registering
   * it as a job at its start and awaiting `result()` once it settles), so the
   * background handle must answer `result()` too.
   */
  async execute(spec) {
    if (spec.onExpiry === 'none') return await this.start(spec)
    return this.foreground(spec)
  }

  /**
   * `onExpiry: 'kill'` as a handle: the proven {@link run} path stays the
   * execution mechanism (confinement, remote reaping, output caps), and the
   * handle is a projection over it so `kill()` can cancel a command that is
   * still in flight.
   */
  foreground(spec) {
    const ctl = this.killSwitch(spec)
    const run = isRemoteCwd(spec.workdir)
      ? this.remoteRun(ctl.spec)
      : (this.assertNotLocalInRemoteSession(ctl.spec), this.localRun(ctl.spec))
    return this.executionView(run, ctl)
  }

  /**
   * A foreground run owns its deadline internally (`makeDeadline`), so the
   * caller cannot reach the process through `spec.signal` alone. This gives
   * the handle a signal of its own, fused with the caller's, whose abort is
   * the exact kill the caller's own cancellation would have performed.
   */
  killSwitch(spec) {
    const ac = new AbortController()
    const parent = spec.signal
    const onAbort = () => { if (!ac.signal.aborted) ac.abort(parent?.reason) }
    if (parent !== undefined) {
      if (parent.aborted) onAbort()
      else parent.addEventListener('abort', onAbort, { once: true })
    }
    return {
      spec: { ...spec, signal: ac.signal },
      dispose: () => { try { parent?.removeEventListener('abort', onAbort) } catch { /* already gone */ } },
      kill: () => {
        if (ac.signal.aborted) return false
        ac.abort(new Error('command killed'))
        return true
      },
    }
  }

  /**
   * Project an in-flight foreground `run()` as the unified execution handle.
   * `result()` memoizes the run promise, so a consumer that only keeps the
   * handle (a job) never owns its rejection; `done` never rejects and carries
   * the process facts; the stream readers serve what the run collected.
   */
  executionView(run, ctl) {
    let outcome
    let failure
    let resultPromise
    let outOffset = 0
    let errOffset = 0
    const stdoutText = () => (outcome === undefined ? '' : outcome.stdout.text)
    const stderrText = () => (failure !== undefined
      ? `spawn failed: ${messageOf(failure)}`
      : outcome === undefined ? '' : outcome.stderr.text)
    const view = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      observed: { stdout: textReader(stdoutText), stderr: textReader(stderrText) },
      readOutput() {
        const out = stdoutText()
        const err = stderrText()
        const outDelta = out.slice(outOffset)
        const errDelta = err.slice(errOffset)
        outOffset = out.length
        errOffset = err.length
        const separator = outDelta.length > 0 && !outDelta.endsWith('\n') ? '\n' : ''
        return { delta: outDelta + (errDelta.length > 0 ? `${separator}[stderr]\n${errDelta}` : ''), lossy: false }
      },
      kill() {
        if (view.status !== 'running') return false
        view.status = 'killed'
        return ctl.kill()
      },
      result() {
        return (resultPromise ??= run)
      },
    }
    view.done = run.then((result) => {
      outcome = result
      if (view.status === 'running') view.status = result.aborted === true ? 'killed' : 'completed'
      view.exitCode = result.exitCode ?? null
      view.signal = result.signal ?? null
      if (result.sandbox !== undefined) view.sandbox = result.sandbox
      ctl.dispose()
    }, (error) => {
      failure = error
      view.status = 'killed'
      ctl.dispose()
    })
    return view
  }

  /**
   * An already-settled handle for an execution that never spawns (a remote
   * command the sandbox policy refuses). The harness classifies the denial
   * from `result().sandbox`, exactly as the foreground path did before the
   * seam converged.
   */
  settledExecution(result) {
    let consumed = false
    return {
      status: 'completed',
      exitCode: result.exitCode,
      signal: result.signal,
      ...(result.sandbox !== undefined ? { sandbox: result.sandbox } : {}),
      done: Promise.resolve(),
      observed: { stdout: textReader(() => result.stdout.text), stderr: textReader(() => result.stderr.text) },
      readOutput() {
        if (consumed) return { delta: '', lossy: false }
        consumed = true
        return { delta: result.stdout.text, lossy: result.stdout.truncated }
      },
      kill() { return false },
      result: () => Promise.resolve(result),
    }
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

  /**
   * The `onExpiry: 'none'` half: a detached, live execution handle. POSIX
   * launches through `setsid`/`nohup` into a per-command temp directory (its
   * stdout, stderr, and exit status become files the handle polls), while
   * Windows uses a long-lived exec stream. DSH 0.1.7-alpha.2 also routes every
   * foreground call through this half — the jobs registry registers it at its
   * start and awaits `result()` once it settles — so the handle carries the
   * real exit code, split streams, `observed` readers, and `result()`, not just
   * the legacy consuming `readOutput()` cursor.
   */
  remoteStart(spec) {
    const policy = this.policy(spec)
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      return this.settledExecution(this.deniedRemoteResult(spec, policy.mode))
    }
    const parsed = parseRemoteWorkdir(spec.workdir)
    const client = this.clientForRemote(parsed.host, parsed.user, parsed.port)
    const path = parsed.path
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    // POSIX launcher. `setsid` puts the command in its OWN session and process
    // group, so the pid this script reports — `$!` — is that GROUP's leader and
    // `kill -TERM -<pid>` reaches the whole tree (see `reapPidCommand`). Without
    // it `$!` is only the `sh -c` wrapper: `sh` forks for a simple command
    // instead of exec'ing it, so killing the wrapper reparented the real work to
    // init and it kept running (verified on a real Linux host). `nohup` is gone
    // because a session of its own cannot be reached by a terminal SIGHUP; the
    // `else` branch keeps hosts with no `setsid` utility (e.g. macOS) working,
    // where the group kill simply fails over to the single-pid form. stdin is
    // /dev/null so the job never depends on the (short-lived) exec channel.
    //
    // Streams go to separate files (not one `2>&1` log) because the harness
    // reads stdout and stderr independently; a third file records the command's
    // own `$?` so a settled job reports the REAL exit code. The directory is a
    // per-command `mktemp -d`, so a foreground call never litters the remote
    // workspace; the hidden workspace dir is only the fallback for a host with
    // no usable temp directory.
    const fallbackDir = `${path.replace(/\/+$/, '')}/.dsh-rw-${id}`
    // The command rides inside a SUBSHELL so the redirects bind to the WHOLE
    // command list. `${spec.command} > "$dir/out"` would bind them to the list's
    // LAST simple command only — `printf A; echo B > out` captures just `B` and
    // sends `A` to the launcher's /dev/null — silently dropping the output of
    // everything before it (measured against a real host). The subshell also
    // keeps a command that ends in `exit N` from terminating the status writer
    // before it records `$?`, so the job reports the real exit code.
    const inner = `(\n${spec.command}\n) > "$dir/out" 2> "$dir/err" </dev/null; echo $? > "$dir/exit"`
    const launcher = [
      `dir=$(mktemp -d 2>/dev/null) || dir=${shellQuote(fallbackDir)}`,
      'mkdir -p "$dir" 2>/dev/null || true',
      'export dir',
      "printf 'DWSH_DIR=%s\\n' \"$dir\"",
      'if command -v setsid >/dev/null 2>&1; then',
      `setsid sh -c ${shellQuote(inner)} > /dev/null 2>&1 </dev/null &`,
      'else',
      `nohup sh -c ${shellQuote(inner)} > /dev/null 2>&1 </dev/null &`,
      'fi',
      'echo $!',
    ].join('\n')
    const launchScript = `cd ${shellQuote(path)} || exit 1\n${launcher}`

    let pid = null
    let dir = null
    let outBuf = ''
    let errBuf = ''
    let outBytes = 0
    let errBytes = 0
    let outLossy = false
    let errLossy = false
    let offsetOut = 0
    let offsetErr = 0
    let spawnFailure
    let pendingFailureNote
    let resultPromise
    let pollTimer
    let streamCtl = null

    const failureText = () => `spawn failed: ${messageOf(spawnFailure)}`
    const consumeFailureNote = () => { const note = pendingFailureNote ?? ''; pendingFailureNote = undefined; return note }
    /** Retain the tail of one stream under its byte budget (lossy once it overflows). */
    const appendOut = (text) => {
      if (typeof text !== 'string' || text === '') return
      outBytes += Buffer.byteLength(text, 'utf8')
      const room = spec.stdoutMaxBytes - outBuf.length
      if (room <= 0) { outLossy = true; return }
      if (text.length > room) { outBuf += text.slice(text.length - room); outLossy = true }
      else outBuf += text
    }
    const appendErr = (text) => {
      if (typeof text !== 'string' || text === '') return
      errBytes += Buffer.byteLength(text, 'utf8')
      const room = DEFAULT_STDERR_MAX_BYTES - errBuf.length
      if (room <= 0) { errLossy = true; return }
      if (text.length > room) { errBuf += text.slice(text.length - room); errLossy = true }
      else errBuf += text
    }
    /** A launch failure settles the handle killed and is reported once on stderr. */
    const fail = (error) => {
      spawnFailure = error
      pendingFailureNote = `spawn failed: ${messageOf(error)}`
      proc.status = 'killed'
    }
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      sandbox: { mode: 'danger-full-access', denied: false },
      observed: {
        stdout: textReader(() => outBuf, () => outLossy),
        stderr: textReader(() => (spawnFailure !== undefined && errBuf === '' ? failureText() : errBuf), () => errLossy),
      },
      readOutput() {
        const outDelta = outBuf.slice(offsetOut)
        const errDelta = errBuf.slice(offsetErr)
        offsetOut = outBuf.length
        offsetErr = errBuf.length
        // A launch failure is reported through the job's stderr exactly once,
        // mirroring localStart. Without this the background job ended as an
        // empty, reason-less result and the model could not tell why it never
        // started.
        const errText = errDelta.length > 0 ? errDelta : consumeFailureNote()
        const separator = outDelta.length > 0 && !outDelta.endsWith('\n') ? '\n' : ''
        return {
          delta: outDelta + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: outLossy || errLossy,
        }
      },
      kill() {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        if (streamCtl !== null) streamCtl.terminate()
        // POSIX: the recorded pid leads the command's own session/process
        // group, so the negative-pid kill reaches the real work — a bare
        // `kill <pid>` only reaped the `sh -c` wrapper and orphaned its child.
        else if (pid !== null) void client.run(reapPidCommand(pid, 'posix'))
        return true
      },
      /**
       * The foreground projection DSH >= 0.1.7-alpha.2 awaits on the job it
       * registered (`onExpiry: 'none'` arms no executor deadline, so `timedOut`
       * stays false: the CALLER bounds its own wait and promotes at its own
       * deadline). Memoized, and only created when asked for, so a background
       * consumer never owns this promise's rejection.
       */
      result() {
        return (resultPromise ??= proc.done.then(() => {
          if (spawnFailure !== undefined) throw spawnFailure
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: false,
            aborted: spec.signal?.aborted === true,
            timeoutMs: spec.timeoutMs,
            stdout: { text: outBuf, truncated: outLossy },
            stderr: { text: errBuf, truncated: errLossy },
            ...(proc.sandbox !== undefined ? { sandbox: proc.sandbox } : {}),
          }
        }))
      },
      done: (async () => {
        const profile = await client.profile()
        if (profile.family === 'unknown') {
          // Never run the POSIX nohup launcher against an undetected host (a
          // Windows/cmd host would die on the `cd '…'` line with Win32 123).
          fail(new Error(PROBE_UNKNOWN_MSG))
          return
        }
        if (profile.family === 'windows') {
          // No nohup-style detach exists on Windows remotes, and closing the
          // channel alone does NOT reap the remote tree (verified) - so the
          // job is a long-lived exec stream whose terminate() actively
          // taskkill /T's the remote PID and then closes the channel.
          const ctl = await client.execStream(spec.command, {
            cwd: path,
            stdoutMaxBytes: spec.stdoutMaxBytes,
          })
          if (proc.status !== 'running') { ctl.terminate(); return }
          streamCtl = ctl
          const merge = () => {
            appendOut(ctl.readOut().delta)
            appendErr(ctl.readErr().delta)
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
            fail(new Error(outcome.error))
            return
          }
          proc.exitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : null
          return
        }
        const launched = await client.run(launchScript, { agentFacing: true })
        if (!launched.ok) {
          fail(new Error((launched.stderr ?? '').trim() || launched.error || 'background spawn failed'))
          return
        }
        const lines = String(launched.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
        const dirLine = lines.find((line) => line.startsWith('DWSH_DIR='))
        const pidToken = [...lines].reverse().find((line) => /^\d+$/.test(line))
        dir = dirLine === undefined ? null : dirLine.slice('DWSH_DIR='.length)
        const parsedPid = pidToken === undefined ? NaN : Number(pidToken)
        if (typeof dir !== 'string' || !dir.startsWith('/')) {
          fail(new Error('background spawn failed: no temp directory'))
          return
        }
        if (!Number.isFinite(parsedPid) || parsedPid <= 0) {
          fail(new Error('background spawn failed: no pid'))
          await this.cleanupRemote(client, dir)
          return
        }
        const outLog = `${dir}/out`
        const errLog = `${dir}/err`
        const exitLog = `${dir}/exit`
        pid = parsedPid
        // kill() can land while the launcher is still in flight; the pid is the
        // only handle on the remote tree, so reap it now rather than leaving a
        // "killed" job running on the remote.
        if (proc.status !== 'running') {
          await client.run(reapPidCommand(pid, 'posix'))
          await this.cleanupRemote(client, dir)
          return
        }
        // Poll both streams into the buffers (readOutput/observed stay
        // synchronous) under their byte offsets.
        const drain = async () => {
          const [outTail, errTail] = await Promise.all([
            client.run(`tail -c +${outBytes + 1} ${shellQuote(outLog)} 2>/dev/null || true`),
            client.run(`tail -c +${errBytes + 1} ${shellQuote(errLog)} 2>/dev/null || true`),
          ])
          if (outTail.ok === true) appendOut(outTail.stdout)
          if (errTail.ok === true) appendErr(errTail.stdout)
        }
        const poll = async () => {
          if (proc.status !== 'running') return
          await drain()
          pollTimer = setTimeout(() => { void poll() }, 500)
        }
        pollTimer = setTimeout(() => { void poll() }, 500)
        // Poll pid liveness until it exits, then drain what the writers left.
        for (;;) {
          const alive = await client.run(`kill -0 ${pid} 2>/dev/null && echo yes || echo no`)
          if (alive.stdout?.trim() === 'no' || proc.status !== 'running') break
          await new Promise((r) => setTimeout(r, 500))
        }
        clearTimeout(pollTimer)
        await drain()
        if (proc.status === 'running') {
          proc.exitCode = await this.readRemoteExit(client, exitLog)
          proc.status = proc.exitCode === null ? 'killed' : 'completed'
          if (proc.exitCode === null) pendingFailureNote = 'the remote command ended without reporting an exit status'
        }
        await this.cleanupRemote(client, dir)
      })().catch((error) => {
        fail(error)
      }),
    }
    return proc
  }

  /**
   * The detached POSIX launcher records the command's own `$?` in `<dir>/exit`
   * as it exits, so a settled job reports the REAL exit code (the poll-only
   * handle reported `null`). A few short retries cover the writer racing the
   * liveness probe.
   */
  async readRemoteExit(client, exitLog) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await client.run(`cat ${shellQuote(exitLog)} 2>/dev/null || true`)
      const text = String(res.stdout ?? '').trim()
      if (/^-?\d+$/.test(text)) return Number(text)
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  /** Remove the per-command temp directory a detached POSIX launch created. */
  async cleanupRemote(client, dir) {
    if (typeof dir !== 'string' || !dir.startsWith('/')) return
    try { await client.run(`rm -rf ${shellQuote(dir)} 2>/dev/null || true`) } catch { /* already gone */ }
  }

  // -------------------------------------------------------------------------
  // Local (ctx.subprocess + ctx.sandbox confine)
  // -------------------------------------------------------------------------
  argv(spec) {
    return process.platform === 'win32'
      ? [resolvePwshPath(), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', spec.command]
      : ['bash', '-c', spec.command]
  }

  /**
   * Wrap `argv` through `ctx.sandbox`. DSH 0.1.6-alpha.1 made `confine()`
   * ASYNC (`Promise<ConfinedArgv>`, commit caa69608fb "refactor(sandbox):
   * await cancellable preparation in process consumers"), so consuming it
   * synchronously left `confined.argv` undefined and the subprocess provider's
   * destructuring threw
   *
   *   undefined is not iterable (cannot read property Symbol(Symbol.iterator))
   *
   * before the command ever started. Preparation is cancellable, so the
   * caller's signal is forwarded exactly as the harness's own bash/pwsh
   * executors do; provider failures (e.g. SandboxUnavailableError) propagate
   * unchanged rather than being reshaped here.
   */
  async confine(argv, policy, signal) {
    if (policy === undefined || policy.mode === 'danger-full-access') {
      return { argv, enforcement: undefined, denialSignatures: [], runnerFailureRules: [] }
    }
    const sandbox = this.getSandbox()
    if (!sandbox) throw new Error('sandbox backend unavailable: refusing to run unconfined')
    return await sandbox.confine(argv, {
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      ...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {}),
    }, signal)
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
    const subprocess = this.getSubprocess()
    if (!subprocess) throw new Error('subprocess service unavailable')
    const d = makeDeadline(spec.signal, spec.timeoutMs)
    // Confinement runs under the same deadline as the command it prepares:
    // the provider may have to start a runner, which is cancellable work.
    let confined
    try {
      confined = await this.confine(this.argv(spec), policy, d.signal)
    } catch (error) {
      d.dispose()
      throw error
    }
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
    const stderrText = stderr?.readFrom(0).text ?? ''
    // Runner failure outranks denial because the command did not run — the
    // harness's own bash/pwsh sandbox executors throw here rather than return a
    // result (packages/shell/bash-sandbox/src/index.ts).
    const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderrText, confined.runnerFailureRules)
    if (runnerFailure !== undefined) throw runnerFailureError(policy.mode, runnerFailure.detail)
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
          denied: matchesSignature(outcome.exitCode, stderrText, confined.denialSignatures),
          enforcement: confined.enforcement,
        },
      } : {}),
    }
  }

  finalOutput(reader) {
    const read = reader.readFrom(0)
    return { text: read.text, truncated: read.lossy, ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}) }
  }

  async localStart(spec) {
    const policy = this.policy(spec)
    const subprocess = this.getSubprocess()
    if (!subprocess) throw new Error('subprocess service unavailable')
    const confined = await this.confine(this.argv(spec), policy, spec.signal)
    const running = subprocess.spawn(this.spawnSpec(spec, confined.argv, spec.stdoutMaxBytes, spec.signal))
    const { stdout, stderr } = running.collected
    let spawnFailure
    let pendingFailureNote
    let resultPromise
    const finalOutput = this.finalOutput.bind(this)
    const failureText = () => `spawn failed: ${messageOf(spawnFailure)}`
    const failureReaderText = () => {
      const base = stderr ? stderr.readFrom(0).text : ''
      if (base === '') return failureText()
      return `${base}${base.endsWith('\n') ? '' : '\n'}${failureText()}`
    }
    const consumeFailureNote = () => { const n = pendingFailureNote ?? ''; pendingFailureNote = undefined; return n }
    let outOffset = 0
    let errOffset = 0
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: {
        stdout: stdout !== undefined ? stdout : textReader(() => ''),
        // A rejected spawn produced no output, so its stderr stream IS the
        // failure note (the harness's own local executors report it the same
        // way); it must survive the consuming readOutput() cursor.
        stderr: {
          readFrom(fromByte) {
            if (spawnFailure === undefined) {
              return stderr !== undefined ? stderr.readFrom(fromByte) : { text: '', nextOffset: fromByte, lossy: false }
            }
            return textReader(failureReaderText).readFrom(fromByte)
          },
        },
      },
      /**
       * The foreground projection DSH >= 0.1.7-alpha.2 awaits on the job it
       * registered. `onExpiry: 'none'` arms no executor deadline, so `timedOut`
       * stays false: the CALLER bounds its own wait. Memoized, and only created
       * when asked for, so a background consumer never owns its rejection.
       */
      result() {
        return (resultPromise ??= proc.done.then(() => {
          if (spawnFailure !== undefined) throw spawnFailure
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            timedOut: false,
            aborted: spec.signal?.aborted === true,
            timeoutMs: spec.timeoutMs,
            stdout: stdout !== undefined ? finalOutput(stdout) : { text: '', truncated: false },
            stderr: stderr !== undefined ? finalOutput(stderr) : { text: '', truncated: false },
            ...(proc.sandbox !== undefined ? { sandbox: proc.sandbox } : {}),
          }
        }))
      },
      done: running.done.then((outcome) => {
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        if (policy !== undefined && policy.mode !== 'danger-full-access') {
          const stderrText = stderr?.readFrom(0).text ?? ''
          // The handle path reports the failure as a FACT (`sandbox.runnerFailed`)
          // instead of rejecting, mirroring `onProcessDone` in the harness's own
          // sandbox executors; the job/foreground renderers turn it into the
          // "the sandbox runner itself failed" notice.
          const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderrText, confined.runnerFailureRules)
          proc.sandbox = {
            mode: policy.mode,
            denied: runnerFailure === undefined && matchesSignature(outcome.exitCode, stderrText, confined.denialSignatures),
            enforcement: confined.enforcement,
            ...(runnerFailure !== undefined ? { runnerFailed: true } : {}),
          }
        }
      }, (error) => {
        proc.status = 'killed'
        spawnFailure = error
        pendingFailureNote = `spawn failed: ${messageOf(error)}`
      }),
      readOutput() {
        const out = stdout ? stdout.readFrom(outOffset) : { text: '', nextOffset: 0, lossy: false }
        const err = stderr ? stderr.readFrom(errOffset) : { text: '', nextOffset: 0, lossy: false }
        outOffset = out.nextOffset
        errOffset = err.nextOffset
        const errText = err.text.length > 0 ? err.text : consumeFailureNote()
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
