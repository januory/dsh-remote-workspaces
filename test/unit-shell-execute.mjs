/**
 * Offline test for the unified execution seam DSH 0.1.7-alpha.2 introduced
 * (core commit d6bebc5783 "feat(shell): converge on execute() and promote
 * timed-out commands to jobs").
 *
 * Why this is worth a test: the seam collapsed the old `run()`/`start()` pair
 * into ONE `execute(spec): Promise<ShellExecution>` whose `onExpiry` carries
 * the old split (`'kill'` default, `'none'` background) and whose handle must
 * be a LIVE process (`status`/`exitCode`/`signal`/`done`/`kill`/`readOutput`/
 * `observed`) plus a `result()` foreground projection. The plugin still only
 * had run/start, so every `bash`/`pwsh` call threw
 *
 *   Error: ctx.shell.execute is not a function
 *
 * and, because the jobs registry now registers every foreground call with
 * `onExpiry: 'none'` and later awaits `process.result()`, a handle without
 * `result()`/`observed` fails a second way. The consumer recipes below are
 * copied from `packages/shell/tool-bash/src/background.ts` (`processSources`,
 * `processJob`, `processOutcome`) and `index.ts` (`waitOnJob`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshShellExecutor } from '../src/shell-exec.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-rw-execute-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const workspaceRoot = process.cwd()

/** A subprocess runtime stub that behaves like the real one where it matters. */
function fakeSubprocess({ exitCode = 0, signal = null, stderrText = '', stdoutText = 'hi\n', failWith, onSpawn } = {}) {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      // The harness's own first line: `const [program, ...args] = spec.argv`.
      const [program, ...args] = spec.argv
      spawned.push({ program, args, argv: spec.argv, cwd: spec.cwd, signal: spec.signal })
      let settle
      const done = new Promise((resolve, reject) => {
        settle = { resolve, reject }
        if (failWith !== undefined) { reject(failWith); return }
        // A real provider kills the command when the caller's signal fires.
        if (spec.signal !== undefined) {
          const kill = () => resolve({ exitCode: null, signal: 'SIGTERM' })
          if (spec.signal.aborted) kill()
          else spec.signal.addEventListener('abort', kill, { once: true })
        }
        // A test can hand `onSpawn` the settle pair to drive completion by hand;
        // otherwise the stub settles immediately like a finished command.
        if (onSpawn !== undefined) onSpawn(settle)
        else resolve({ exitCode, signal })
      })
      const reader = (text) => ({
        readFrom: (from = 0) => {
          const at = Number.isFinite(from) && from > 0 ? Math.min(from, text.length) : 0
          return { text: text.slice(at), nextOffset: text.length, lossy: false }
        },
      })
      return {
        collected: { stdout: reader(stdoutText), stderr: reader(stderrText) },
        done,
        waitForExit: () => done.then(() => {}),
        terminate() {},
      }
    },
  }
}

function makeExecutor(subprocess, sandbox = undefined) {
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
  sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
  ...extra,
})

/** The handle surface every consumer of the seam relies on. */
function assertHandleShape(handle, label) {
  const missing = ['status', 'exitCode', 'signal', 'done', 'readOutput', 'kill', 'result']
    .filter((member) => handle[member] === undefined)
  const observed = handle.observed
  check(`${label}: the handle is a live ShellExecution`,
    missing.length === 0 && observed !== undefined
    && typeof observed.stdout?.readFrom === 'function' && typeof observed.stderr?.readFrom === 'function',
    `missing=${JSON.stringify(missing)}`)
}

// --- 1. the seam itself ------------------------------------------------------
{
  const ex = makeExecutor(fakeSubprocess())
  check('execute() exists (the seam replaced run/start with it)', typeof ex.execute === 'function')
  check('resolve() defaults onExpiry to kill', ex.resolve({ command: 'x' }).onExpiry === 'kill')
  check('resolve() carries an explicit onExpiry through', ex.resolve({ command: 'x', onExpiry: 'none' }).onExpiry === 'none')
  check('the legacy halves remain for older harnesses', typeof ex.run === 'function' && typeof ex.start === 'function')
}

// --- 2. `onExpiry: 'kill'` returns a handle whose result() is the run outcome -
{
  const subprocess = fakeSubprocess({ exitCode: 0, stdoutText: 'hello\n' })
  const ex = makeExecutor(subprocess)
  const handle = await ex.execute(specFor(ex, { command: 'echo hi' }))
  assertHandleShape(handle, 'foreground')
  const result = await handle.result()
  check('result() resolves the ShellRunResult shape the tool renders',
    result.exitCode === 0 && result.timedOut === false && result.aborted === false
    && result.timeoutMs === 120000 && result.stdout.text === 'hello\n' && result.stderr.text === '',
    JSON.stringify(result))
  check('the handle settled completed with the run facts',
    handle.status === 'completed' && handle.exitCode === 0, `${handle.status}/${handle.exitCode}`)
  check('observed readers are non-consuming over the same streams',
    handle.observed.stdout.readFrom(0).text === 'hello\n'
    && handle.observed.stdout.readFrom(0).text === 'hello\n',
    JSON.stringify(handle.observed.stdout.readFrom(0)))
}

// --- 3. kill() cancels an in-flight foreground command -----------------------
{
  const subprocess = fakeSubprocess({ onSpawn: () => { /* never settles by itself */ } })
  const ex = makeExecutor(subprocess)
  const handle = await ex.execute(specFor(ex, { command: 'sleep 300' }))
  check('kill() reports the in-flight command as killed', handle.kill() === true)
  const result = await handle.result()
  check('a killed foreground command resolves aborted (not a rejection)',
    result.aborted === true && result.timedOut === false, JSON.stringify(result))
  check('kill() is a no-op once the command settled', handle.kill() === false)
}

// --- 4. the 0.1.7 jobs recipe: onExpiry none + observed + result --------------
{
  const subprocess = fakeSubprocess({ exitCode: 7, stdoutText: 'BUILD-OK\n', stderrText: 'warning\n' })
  const ex = makeExecutor(subprocess)
  // Exactly what `startJob` hands the executor, and what `waitOnJob` then does.
  const handle = await ex.execute(ex.resolve({
    command: 'make',
    workdir: workspaceRoot,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
    onExpiry: 'none',
  }))
  assertHandleShape(handle, 'job')
  // processSources() pumps both channels from independent offsets.
  const stdout = handle.observed.stdout.readFrom(0)
  const stderr = handle.observed.stderr.readFrom(0)
  check('the job streams are split for the registry pump',
    stdout.text === 'BUILD-OK\n' && stderr.text === 'warning\n', JSON.stringify({ stdout, stderr }))
  check('a second offset read does not re-deliver what the first saw',
    handle.observed.stdout.readFrom(stdout.nextOffset).text === '', 'cursor moved')
  await handle.done
  const result = await handle.result()
  check('the settled job projects the process facts (processOutcome + waitOnJob)',
    handle.status === 'completed' && handle.exitCode === 7
    && result.exitCode === 7 && result.stdout.text === 'BUILD-OK\n' && result.stderr.text === 'warning\n',
    JSON.stringify({ status: handle.status, exitCode: handle.exitCode, result }))
}

// --- 5. a rejected spawn: done settles killed, result() rejects --------------
{
  const failure = Object.assign(new Error('subprocess failed before reporting an outcome'), { name: 'SubprocessError' })
  const ex = makeExecutor(fakeSubprocess({ failWith: failure }))
  const handle = await ex.execute(ex.resolve({
    command: 'nope',
    workdir: workspaceRoot,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot },
    onExpiry: 'none',
  }))
  await handle.done
  check('a rejected spawn settles the handle killed without rejecting done', handle.status === 'killed', handle.status)
  check('the spawn failure is served on the observed stderr stream',
    handle.observed.stderr.readFrom(0).text.includes('spawn failed'), JSON.stringify(handle.observed.stderr.readFrom(0)))
  const caught = await handle.result().then(() => undefined, (error) => error)
  check('result() rejects with the original provider error (identity preserved)', caught === failure, String(caught?.message))
}

// --- 6. confinement facts still reach result().sandbox -----------------------
{
  const provider = { async confine(argv) { return { argv: ['runner', '--', ...argv], enforcement: 'full', denialSignatures: [] } } }
  const ex = makeExecutor(fakeSubprocess(), provider)
  const handle = await ex.execute(ex.resolve({
    command: 'echo hi',
    workdir: workspaceRoot,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot, sessionId: 's1' },
    onExpiry: 'none',
  }))
  await handle.done
  const result = await handle.result()
  check('a confined job reports its enforcement through result().sandbox',
    result.sandbox?.mode === 'workspace-write' && result.sandbox?.enforcement === 'full' && result.sandbox?.denied === false,
    JSON.stringify(result.sandbox))
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
