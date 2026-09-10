import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { registerAnchor } from '../src/registry.js'
import { SshShellExecutor } from '../src/shell-exec.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-shell-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

/** Run a spec through run() and report the message it settles with ('' = ran). */
async function verdict(spec) {
  try {
    await ex.run(spec)
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const anchor = join(home, 'remote-workspaces', 'test-root-22', 'root--test')
registerAnchor({ anchorPath: anchor, machineId: 'm1', host: '192.168.1.1', port: 22, user: 'root', remotePath: '/root/test' })

// A Windows remote, exactly the shape of the 192.168.151.240 session that ran
// `workdir: C:\Windows\Temp` on the local DSH host.
const winAnchor = join(home, 'remote-workspaces', '10.0.0.9-administrator', 'C--Windows--Temp')
registerAnchor({
  anchorPath: winAnchor, machineId: 'm2', host: '10.0.0.9', port: null, user: 'administrator',
  remotePath: '/C:/Windows/Temp', os: { family: 'windows', os: 'windows', shell: 'cmd' },
})

const posixAnchor = join(home, 'remote-workspaces', '10.0.0.7-root-2222', 'data--nfdump')
registerAnchor({
  anchorPath: posixAnchor, machineId: 'm3', host: '10.0.0.7', port: 2222, user: 'root',
  remotePath: '/data/nfdump', os: { family: 'posix', os: 'linux', shell: 'posix' },
})

const ex = new SshShellExecutor({ clientForRemote: () => ({}), getPolicy: () => undefined, getSandbox: () => undefined, getSubprocess: () => undefined })
/** The per-call sandbox policy carries the session cwd (its routing key). */
const session = (anchorPath) => ({ mode: 'danger-full-access', workspaceRoot: anchorPath, sessionId: 's1' })
const winSession = session(winAnchor)
const posixSession = session(posixAnchor)

// translateWorkdir
check('local workdir unchanged', ex.translateWorkdir('C:/some/local/dir') === 'C:/some/local/dir')
check('ssh:// workdir unchanged', ex.translateWorkdir('ssh://root@host:22/root/test') === 'ssh://root@host:22/root/test')
const remoteW = ex.translateWorkdir(anchor)
check('anchor -> ssh:// URI', remoteW.startsWith('ssh://root@192.168.1.1:22/root/test'), remoteW)
const remoteSub = ex.translateWorkdir(join(anchor, 'sub'))
check('anchor descendant -> ssh:// subpath', remoteSub === 'ssh://root@192.168.1.1:22/root/test/sub', remoteSub)

// resolve: defaults + caps + workdir translation
const localSpec = ex.resolve({ command: 'echo hi', workdir: 'C:/some/local/dir' })
check('resolve local keeps workdir', localSpec.workdir === 'C:/some/local/dir')
check('resolve default timeout', localSpec.timeoutMs === 120000)
check('resolve timeout cap', ex.resolve({ command: 'x', timeoutMs: 999999999 }).timeoutMs === 600000)
check('resolve stdout cap default', localSpec.stdoutMaxBytes === 64000)

const remoteSpec = ex.resolve({ command: 'pwd', workdir: anchor })
check('resolve translates remote workdir', remoteSpec.workdir.startsWith('ssh://'), remoteSpec.workdir)

// ---------------------------------------------------------------------------
// Session-scoped routing: in a remote session the workdir's SPELLING must not
// decide the machine. `tool-pwsh` passes an absolute model workdir verbatim.
// ---------------------------------------------------------------------------
const route = (workdir, policy) => ex.resolve({ command: 'x', ...workdir !== undefined ? { workdir } : {}, sandboxPolicy: policy }).workdir

check('win session: drive workdir routes to the REMOTE',
  route('C:\\Windows\\Temp', winSession) === 'ssh://administrator@10.0.0.9/C:/Windows/Temp', route('C:\\Windows\\Temp', winSession))
check('win session: drive path outside the workspace still routes remote',
  route('C:\\Windows\\System32', winSession) === 'ssh://administrator@10.0.0.9/C:/Windows/System32', route('C:\\Windows\\System32', winSession))
check('win session: remote-spelled /C:/ workdir routes remote',
  route('/C:/Windows/Temp/sub', winSession) === 'ssh://administrator@10.0.0.9/C:/Windows/Temp/sub', route('/C:/Windows/Temp/sub', winSession))
check('win session: anchor-spelled workdir routes remote',
  route(winAnchor, winSession) === 'ssh://administrator@10.0.0.9/C:/Windows/Temp', route(winAnchor, winSession))
check('win session: omitted workdir uses the session, never process.cwd()',
  route(undefined, winSession) === 'ssh://administrator@10.0.0.9/C:/Windows/Temp', route(undefined, winSession))
check('win session: relative workdir resolves under the workspace',
  route(join(winAnchor, 'sub', 'dir'), winSession) === 'ssh://administrator@10.0.0.9/C:/Windows/Temp/sub/dir', route(join(winAnchor, 'sub', 'dir'), winSession))
check('cross-anchor workdir still routes to its own anchor',
  route(posixAnchor, winSession) === 'ssh://root@10.0.0.7:2222/data/nfdump', route(posixAnchor, winSession))
const escaped = route(resolvePath(winAnchor, '..', '..', '..'), winSession)
check('win session: a ..-escaped workdir still never runs locally', escaped.startsWith('ssh://'), escaped)
check('explicit ssh:// workdir wins over the session', route('ssh://other@h:2200/data/x', winSession) === 'ssh://other@h:2200/data/x')

check('posix session: absolute remote path routes remote',
  route('/data/nfdump/x', posixSession) === 'ssh://root@10.0.0.7:2222/data/nfdump/x', route('/data/nfdump/x', posixSession))
check('posix session: /tmp routes to the remote /tmp',
  route('/tmp', posixSession) === 'ssh://root@10.0.0.7:2222/tmp', route('/tmp', posixSession))
check('posix session: omitted workdir uses the session, never process.cwd()',
  route(undefined, posixSession) === 'ssh://root@10.0.0.7:2222/data/nfdump', route(undefined, posixSession))

// A local session is untouched: no session anchor means today's behavior.
check('local session: drive workdir stays local', route('C:\\Windows\\Temp', undefined) === 'C:\\Windows\\Temp')
check('local session: omitted workdir falls back to process.cwd()', route(undefined, undefined) === process.cwd())

// ---------------------------------------------------------------------------
// The invariant: inside a remote session the LOCAL executor is unreachable.
// ---------------------------------------------------------------------------
const unmappable = route('C:\\Windows\\Temp', posixSession)
check('posix session: a drive path is not mappable to the host', !unmappable.startsWith('ssh://'), unmappable)
const posixVerdict = await verdict({ command: 'x', workdir: unmappable, sandboxPolicy: posixSession })
check('posix session: run() refuses it instead of running locally', posixVerdict.includes('refusing to run locally'), posixVerdict)
const bypassVerdict = await verdict({ command: 'x', workdir: 'C:\\Users\\x', sandboxPolicy: winSession })
check('remote session: run() refuses a local workdir that bypassed resolve()', bypassVerdict.includes('refusing to run locally'), bypassVerdict)
let startVerdict = ''
try {
  ex.start({ command: 'x', workdir: 'C:\\Users\\x', sandboxPolicy: winSession })
} catch (error) {
  startVerdict = error instanceof Error ? error.message : String(error)
}
check('remote session: start() refuses it too (background jobs)', startVerdict.includes('refusing to run locally'), startVerdict)
const localVerdict = await verdict({ command: 'x', workdir: 'C:/some/local/dir' })
check('local session: run() is NOT refused (reaches the local executor)', localVerdict.includes('subprocess service unavailable'), localVerdict)

// --- remoteStart surfaces a launch failure instead of an empty job ----------
{
  const fakeClient = {
    profile: async () => ({ family: 'posix', os: 'linux', shell: 'posix' }),
    run: async () => ({ ok: false, ms: 3, exitCode: 1, stdout: '', stderr: '', error: 'connection timed out' }),
  }
  const startEx = new SshShellExecutor({
    clientForRemote: () => fakeClient,
    getPolicy: () => ({ resolve: () => ({ mode: 'danger-full-access' }) }),
    getSandbox: () => undefined,
    getSubprocess: () => undefined,
  })
  const proc = startEx.start({ command: 'sleep 1', workdir: 'ssh://root@10.0.0.7:22/data/x', timeoutMs: 1000 })
  await proc.done
  const first = proc.readOutput()
  const second = proc.readOutput()
  check('remote background launch failure is surfaced to the caller', first.delta.includes('[stderr]') && first.delta.includes('connection timed out'), JSON.stringify(first.delta))
  check('the launch failure is reported exactly once', second.delta === '', JSON.stringify(second.delta))
  check('the failed background job reports killed', proc.status === 'killed', proc.status)
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
