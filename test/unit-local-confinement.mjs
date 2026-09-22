/**
 * Offline test for the LOCAL half of the shell executor: `ctx.sandbox` +
 * `ctx.subprocess` confinement.
 *
 * Why this is worth a test: DSH 0.1.6-alpha.1 changed `SandboxProvider.confine`
 * from a synchronous `ConfinedArgv` to an async, cancellable
 * `Promise<ConfinedArgv>` (commit caa69608fb "refactor(sandbox): await
 * cancellable preparation in process consumers"). This plugin consumed it
 * synchronously, so `confined.argv` was `undefined` and the subprocess provider's
 * own destructuring (`packages/subprocess/subprocess-local/src/spawn.ts`,
 * `const [program, ...args] = spec.argv`) threw
 *
 *   undefined is not iterable (cannot read property Symbol(Symbol.iterator))
 *
 * which this plugin then wrapped as `sandbox runner failed to start: …` — every
 * LOCAL command failed, while remote commands (ssh2 exec) were unaffected.
 *
 * The provider stubs below therefore return promises the way the real provider
 * (`packages/sandbox/sandbox-local`, `async confine`) does, and the subprocess
 * stub destructures `spec.argv` exactly like the harness: a regression to
 * synchronous consumption fails here instead of on a user's machine.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshShellExecutor } from '../src/shell-exec.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-rw-confinement-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const workspaceRoot = process.cwd()

/** Incremental-reader stub with fixed text (the executor reads from offset 0). */
function reader(text) {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

/** A subprocess runtime stub that fails exactly where the harness would. */
function fakeSubprocess({ exitCode = 0, stderrText = '' } = {}) {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      // The harness's own first line: `const [program, ...args] = spec.argv`.
      const [program, ...args] = spec.argv
      spawned.push({ program, args, argv: spec.argv, cwd: spec.cwd, graceMs: spec.graceMs, env: spec.env })
      return {
        collected: { stdout: reader(''), stderr: reader(stderrText) },
        done: Promise.resolve({ exitCode, signal: null }),
        waitForExit: () => Promise.resolve(),
        terminate() {},
      }
    },
  }
}

function makeExecutor(sandbox, subprocess) {
  return new SshShellExecutor({
    clientForRemote: () => ({}),
    getPolicy: () => undefined,
    getSandbox: () => sandbox,
    getSubprocess: () => subprocess,
  })
}

const specFor = (ex, extra = {}) => ex.resolve({
  command: 'echo hi',
  workdir: workspaceRoot,
  sandboxPolicy: { mode: 'workspace-write', workspaceRoot, sessionId: 's1' },
  ...extra,
})

// --- 1. the async provider contract (DSH >= 0.1.6-alpha.1) -------------------
{
  const calls = []
  const provider = {
    async confine(argv, policy, signal) {
      calls.push({ argv, policy, signal })
      return { argv: ['runner', '--', ...argv], enforcement: 'full', denialSignatures: ['operation not permitted'] }
    },
  }
  const subprocess = fakeSubprocess()
  const ex = makeExecutor(provider, subprocess)
  const result = await ex.run(specFor(ex))

  const spawned = subprocess.spawned[0]
  check('an async confine() result is awaited before spawn (no undefined argv)',
    spawned !== undefined && Array.isArray(spawned.argv) && spawned.program === 'runner',
    JSON.stringify(spawned?.argv))
  check('the provider argv is what actually runs, including the shell program',
    spawned !== undefined && spawned.args[0] === '--' && typeof spawned.args[1] === 'string' && spawned.args.length >= 3,
    JSON.stringify(spawned?.args))
  check('confinement facts come from the provider (enforcement + denial signatures)',
    result.sandbox?.mode === 'workspace-write' && result.sandbox?.enforcement === 'full' && result.sandbox?.denied === false,
    JSON.stringify(result.sandbox))
  check('the provider receives the per-call policy (mode, root, session)',
    calls.length === 1 && calls[0].policy.mode === 'workspace-write'
    && calls[0].policy.workspaceRoot === workspaceRoot && calls[0].policy.sessionId === 's1',
    JSON.stringify(calls[0]?.policy))
  check('preparation is cancellable: the provider gets an AbortSignal',
    calls[0]?.signal instanceof AbortSignal && calls[0].signal.aborted === false,
    String(calls[0]?.signal))
  check('the spawn spec is unchanged for the confined run (cwd + grace)',
    spawned?.cwd === workspaceRoot && typeof spawned?.graceMs === 'number',
    JSON.stringify({ cwd: spawned?.cwd, graceMs: spawned?.graceMs }))
}

// --- 2. denial classification still rides the provider's signatures ----------
{
  const provider = {
    async confine(argv) {
      return { argv: ['runner', '--', ...argv], enforcement: 'partial', denialSignatures: ['permission denied'] }
    },
  }
  const ex = makeExecutor(provider, fakeSubprocess({ exitCode: 1, stderrText: 'bash: /etc/x: Permission denied' }))
  const result = await ex.run(specFor(ex))
  check('a denied command is classified from the provider signatures',
    result.sandbox?.denied === true && result.sandbox?.enforcement === 'partial' && result.exitCode === 1,
    JSON.stringify(result.sandbox))
}

// --- 3. the 0.1.5-line synchronous provider still works ----------------------
{
  const provider = {
    confine(argv) {
      return { argv: [...argv], enforcement: 'full', denialSignatures: [] }
    },
  }
  const subprocess = fakeSubprocess()
  const ex = makeExecutor(provider, subprocess)
  const result = await ex.run(specFor(ex))
  check('a synchronous (pre-0.1.6) provider is still accepted',
    subprocess.spawned.length === 1 && Array.isArray(subprocess.spawned[0].argv)
    && subprocess.spawned[0].program !== 'runner' && subprocess.spawned[0].program !== undefined,
    JSON.stringify(subprocess.spawned[0]?.program))
  check('an unconfinable argv passes through unchanged (sync provider)',
    result.sandbox?.enforcement === 'full' && result.sandbox?.denied === false,
    JSON.stringify(result.sandbox))
}

// --- 4. danger-full-access and no policy never touch the provider ------------
{
  let called = 0
  const provider = { async confine() { called += 1; return { argv: [], enforcement: 'full', denialSignatures: [] } } }
  const subprocess = fakeSubprocess()
  const ex = makeExecutor(provider, subprocess)

  const full = await ex.run(ex.resolve({
    command: 'echo hi', workdir: workspaceRoot,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
  }))
  check('danger-full-access spawns without confinement', called === 0 && full.sandbox === undefined,
    JSON.stringify({ called, sandbox: full.sandbox }))

  const bare = await ex.run(ex.resolve({ command: 'echo hi', workdir: workspaceRoot }))
  check('no policy at all spawns without confinement', called === 0 && bare.sandbox === undefined,
    JSON.stringify({ called, sandbox: bare.sandbox }))
  check('the unconfined argv is the executor\'s own argv', subprocess.spawned.length === 2
    && subprocess.spawned.every((s) => s.program !== 'runner'), JSON.stringify(subprocess.spawned.map((s) => s.program)))
}

// --- 5. fail-closed: provider missing or failing -----------------------------
{
  const ex = makeExecutor(undefined, fakeSubprocess())
  const message = await ex.run(specFor(ex)).then(() => '', (error) => (error instanceof Error ? error.message : String(error)))
  check('a confined mode with no provider refuses to run unconfined',
    message.includes('sandbox backend unavailable'), message)
}
{
  const unavailable = Object.assign(new Error('bubblewrap missing'), { code: 'SANDBOX_UNAVAILABLE', name: 'SandboxUnavailableError' })
  const provider = { async confine() { throw unavailable } }
  const subprocess = fakeSubprocess()
  const ex = makeExecutor(provider, subprocess)
  const caught = await ex.run(specFor(ex)).then(() => undefined, (error) => error)
  check('a provider failure propagates unchanged (not reshaped as a spawn failure)',
    caught === unavailable && caught.code === 'SANDBOX_UNAVAILABLE', String(caught?.message))
  check('a failed preparation never spawns a process', subprocess.spawned.length === 0)
}

// --- 6. background start() under the same async contract --------------------
{
  const provider = {
    async confine(argv) {
      return { argv: ['runner', '--', ...argv], enforcement: 'full', denialSignatures: [] }
    },
  }
  const subprocess = fakeSubprocess()
  const ex = makeExecutor(provider, subprocess)
  const proc = await ex.start(specFor(ex))
  check('start() resolves a live handle (the seam declares Promise<ShellProcess>)',
    proc !== undefined && typeof proc.readOutput === 'function' && typeof proc.kill === 'function'
    && subprocess.spawned[0]?.program === 'runner',
    JSON.stringify({ status: proc?.status, program: subprocess.spawned[0]?.program }))
  await proc.done
  check('the background process carries the provider confinement facts',
    proc.sandbox?.mode === 'workspace-write' && proc.sandbox?.enforcement === 'full' && proc.sandbox?.denied === false,
    JSON.stringify(proc.sandbox))
}

// --- 7. runner failure outranks a denial (0.1.7 runnerFailureRules) ---------
{
  const provider = {
    async confine(argv) {
      return {
        argv: ['runner', '--', ...argv],
        enforcement: 'full',
        denialSignatures: ['permission denied'],
        runnerFailureRules: [{
          allowedExitCodes: [1],
          informationalLines: ['runner: warming up'],
          fatalSignatures: ['setting up uid map: permission denied'],
        }],
      }
    },
  }
  const ex = makeExecutor(provider, fakeSubprocess({ exitCode: 1, stderrText: 'runner: warming up\nbwrap: setting up uid map: Permission denied' }))
  const caught = await ex.run(specFor(ex)).then(() => undefined, (error) => error)
  check('a fatal runner line is infrastructure, not a command result',
    caught !== undefined && caught.code === 'SANDBOX_UNAVAILABLE', String(caught && caught.message))
  check('the runner-failure error carries the matched line (informational lines excluded)',
    caught !== undefined && caught.message.includes('setting up uid map') && !caught.message.includes('warming up'),
    String(caught && caught.message))
}
{
  // The same denial stderr with NO runner evidence stays an ordinary denial.
  const provider = {
    async confine(argv) {
      return { argv: ['runner', '--', ...argv], enforcement: 'full', denialSignatures: ['permission denied'], runnerFailureRules: [] }
    },
  }
  const ex = makeExecutor(provider, fakeSubprocess({ exitCode: 1, stderrText: 'bash: /etc/x: Permission denied' }))
  const result = await ex.run(specFor(ex))
  check('without runner evidence the run is still classified denied', result.sandbox?.denied === true, JSON.stringify(result.sandbox))
}
// --- 8. the background handle reports runnerFailed as a FACT, not a denial --
{
  const provider = {
    async confine(argv) {
      return {
        argv: ['runner', '--', ...argv],
        enforcement: 'full',
        denialSignatures: [],
        runnerFailureRules: [{ fatalSignatures: ['UID map setup failed'] }],
      }
    },
  }
  const ex = makeExecutor(provider, fakeSubprocess({ exitCode: 1, stderrText: 'bwrap: UID map setup failed' }))
  const proc = await ex.start(specFor(ex))
  await proc.done
  check('the handle stamps runnerFailed and does not claim a denial',
    proc.sandbox?.runnerFailed === true && proc.sandbox?.denied === false, JSON.stringify(proc.sandbox))
  const result = await proc.result()
  check('result() carries the same runner-failure fact', result.sandbox?.runnerFailed === true, JSON.stringify(result.sandbox))
}

// --- 9. cancellation and preparation timeout reach the provider -------------
{
  const provider = {
    confine(_argv, _policy, signal) {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(signal?.reason ?? new Error('aborted'))
        signal.aborted ? fail() : signal.addEventListener('abort', fail, { once: true })
      })
    },
  }
  const subprocess = fakeSubprocess()
  const ex = makeExecutor(provider, subprocess)

  const ac = new AbortController()
  const pending = ex.run(specFor(ex, { signal: ac.signal }))
  ac.abort(new Error('cancelled-while-preparing'))
  const cancelled = await pending.then(() => '', (error) => (error instanceof Error ? error.message : String(error)))
  check('caller cancellation during preparation rejects with the caller reason',
    cancelled === 'cancelled-while-preparing', cancelled)

  const timedOut = await ex.run(specFor(ex, { timeoutMs: 5 })).then(() => '', (error) => (error instanceof Error ? error.message : String(error)))
  check('a preparation deadline rejects instead of publishing a process',
    timedOut !== '' && subprocess.spawned.length === 0, timedOut)
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
