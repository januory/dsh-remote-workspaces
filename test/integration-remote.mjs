/**
 * End-to-end integration test against a REAL SSH host, exercising every
 * tool backend the plugin routes to the remote: transport (exec/execShell),
 * SFTP (write/read/edit/list/stat), the routing filesystem, the shell
 * executor, and grep/glob.
 *
 * Uses a dedicated throwaway directory `/tmp/dsh-remote-workspaces-test` so it
 * never touches a shared working tree. Requires a configured machine registry;
 * targets the first machine, or the one aliased `test`.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMachines } from '../src/machine-store.js'
import { SshClient } from '../src/transport.js'
import { ensureAnchor } from '../src/anchor.js'
import { registerAnchor, findByCwd } from '../src/registry.js'
import { SftpBackend } from '../src/fs-sftp.js'
import { RoutingFileSystem } from '../src/routing-fs.js'
import { SshShellExecutor } from '../src/shell-exec.js'
import { createSearchTools } from '../src/search.js'

const REMOTE_DIR = '/tmp/dsh-remote-workspaces-test'

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// Load the REAL machines (before overriding DSH_HOME for the anchor half).
const machines = loadMachines()
const machine = machines.find((m) => m.alias === 'test') ?? machines[0]
if (machine === undefined) {
  console.log('FAIL  no configured machine to test against')
  process.exit(1)
}
check('found test machine', Boolean(machine), `${machine.alias}@${machine.host}`)

const client = new SshClient({
  alias: machine.alias, host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})

// ---------------------------------------------------------------------------
// 0. Prepare a clean, dedicated remote directory.
// ---------------------------------------------------------------------------
const setup = await client.run(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`)
check('prepare remote dir', setup.ok, setup.ok ? REMOTE_DIR : setup.error)

// ---------------------------------------------------------------------------
// 1. Transport: one-shot run + shell exec (cwd / cap / exit code).
// ---------------------------------------------------------------------------
const echo = await client.run('echo ok')
check('transport run echo', echo.ok && echo.stdout.trim() === 'ok', echo.ok ? echo.stdout.trim() : echo.error)
const shell = await client.execShell('pwd', { cwd: REMOTE_DIR, timeoutMs: 20000 })
check('transport execShell cwd', shell.ok && shell.exitCode === 0 && shell.stdout.text.trim() === REMOTE_DIR, shell.ok ? shell.stdout.text.trim() : shell.error)

// ---------------------------------------------------------------------------
// 2. SFTP backend: write / read / edit / list / stat + the version contract.
// ---------------------------------------------------------------------------
const be = new SftpBackend(client)

const hello = await be.resolve('hello.txt', { cwd: REMOTE_DIR })
const w1 = await be.writeText(hello, 'Hello world\nhello again\n')
check('write create', w1.operation === 'create' && w1.before === null && w1.after.startsWith('Hello world'), `op=${w1.operation} before=${JSON.stringify(w1.before)}`)

const r1 = await be.readText(hello)
check('read matches written', r1 === 'Hello world\nhello again\n', JSON.stringify(r1))

// Overwrite without a prior read must refuse (the harness's version contract).
let noObserve = null
try { await be.writeText(hello, 'x', { kind: 'createIfAbsent' }) } catch (e) { noObserve = e }
check('write existing without read → FS_NOT_OBSERVED', noObserve !== null && noObserve.code === 'FS_NOT_OBSERVED', noObserve ? noObserve.code : '(no error)')

const w2 = await be.writeText(hello, 'Updated\nhello again\n', { kind: 'replaceIfVersion', version: w1.version })
check('write update (version match)', w2.operation === 'update' && w2.before === 'Hello world\nhello again\n' && w2.after === 'Updated\nhello again\n', `op=${w2.operation}`)

const notes = await be.resolve('notes.md', { cwd: REMOTE_DIR })
await be.writeText(notes, 'alpha beta gamma\n')
const e1 = await be.editText(notes, { oldString: 'beta', newString: 'BETA', replaceAll: false })
check('edit replaces old_string', e1.before === 'alpha beta gamma\n' && e1.after === 'alpha BETA gamma\n', JSON.stringify(e1.after))

const list = await be.listDir(await be.resolve('.', { cwd: REMOTE_DIR }))
check('list contains written files', list.some((x) => x.name === 'hello.txt') && list.some((x) => x.name === 'notes.md'), list.map((x) => x.name).join(','))

const st = await be.stat(hello)
check('stat type=file', st !== undefined && st.type === 'file', st ? `${st.type} size=${st.size}` : 'undefined')

// ---------------------------------------------------------------------------
// 3. Routing filesystem: anchor → remote resolve / read / list.
// ---------------------------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'dsh-remote-'))
process.env.DSH_HOME = home
const anchor = ensureAnchor(machine, REMOTE_DIR)
registerAnchor({ anchorPath: anchor, machineId: machine.id, host: machine.host, port: machine.port, user: machine.user, remotePath: REMOTE_DIR })
check('anchor registered', findByCwd(anchor) !== undefined && findByCwd(anchor).remotePath === REMOTE_DIR)

const rfs = new RoutingFileSystem({ clientForRemote: () => client, getPolicy: () => undefined })
const rt = await rfs.resolve('hello.txt', { cwd: anchor })
check('routing resolve encodes ssh://', rt.targetKey.startsWith('ssh://'), rt.targetKey)
check('routing readText', await rfs.readText(rt) === 'Updated\nhello again\n')

const rlist = await rfs.listDir(await rfs.resolve('.', { cwd: anchor }))
check('routing listDir re-encodes child ssh://', rlist.length >= 2 && rlist.every((e) => e.target.targetKey.startsWith('ssh://')), `${rlist.length} entries`)

// ---------------------------------------------------------------------------
// 4. Shell executor: remote run through an anchor workdir.
// ---------------------------------------------------------------------------
const ex = new SshShellExecutor({ clientForRemote: () => client, getPolicy: () => undefined, getSandbox: () => undefined, getSubprocess: () => undefined })
const shspec = ex.resolve({ command: 'pwd', workdir: anchor })
check('shell translates anchor → ssh://', shspec.workdir.startsWith('ssh://'), shspec.workdir)
const shres = await ex.run(shspec)
check('shell remote run pwd', shres.exitCode === 0 && shres.stdout.text.trim() === REMOTE_DIR, shres.stdout.text.trim())

// ---------------------------------------------------------------------------
// 5. grep / glob: search tools run ripgrep on the remote via the anchor cwd.
// ---------------------------------------------------------------------------
const deps = { clientForRemote: () => client, getSubprocess: () => { throw new Error('not used remotely') } }
const { grep, glob } = createSearchTools(deps)
const execCtx = { agent: { session: { header: { cwd: anchor } } }, signal: undefined }

const g = await grep.execute({ pattern: 'hello', path: '.' }, execCtx)
check('grep finds remote match', g.matches.some((m) => m.path.includes('hello.txt')), JSON.stringify(g.matches))

const gl = await glob.execute({ pattern: '*.txt', path: '.' }, execCtx)
check('glob finds remote *.txt', gl.paths.some((p) => p.includes('hello.txt')), JSON.stringify(gl.paths))

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------
rmSync(home, { recursive: true, force: true })
const cleanup = await client.run(`rm -rf ${REMOTE_DIR}`)
check('cleanup remote dir', cleanup.ok, cleanup.ok ? '' : cleanup.error)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
