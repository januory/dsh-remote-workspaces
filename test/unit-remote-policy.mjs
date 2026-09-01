import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerAnchor } from '../src/registry.js'
import { RoutingFileSystem } from '../src/routing-fs.js'
import { SshShellExecutor } from '../src/shell-exec.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-remote-policy-'))
process.env.DSH_HOME = home

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

const anchor = join(home, 'remote-workspaces', 'test-root-22', 'root--test')
registerAnchor({ anchorPath: anchor, machineId: 'm1', host: '192.168.1.1', port: 22, user: 'root', remotePath: '/root/test' })

// A fake remote client: `realpath` throws so `resolve` keeps the lexical target
// key; the denial paths below never reach the backend's write.
const fakeClient = { host: '192.168.1.1', sftp: async () => ({ realpath: async () => { throw new Error('no realpath') } }) }
const rfs = new RoutingFileSystem({ getPolicy: () => undefined, clientForRemote: () => fakeClient })

async function expectCode(code, fn, label) {
  try {
    await fn()
    check(label, false, 'did not throw')
  } catch (e) {
    check(label, e !== undefined && e.code === code, e && e.message)
  }
}

// --- remote FS write/edit policy ---
{
  const target = await rfs.resolve('x.txt', { cwd: anchor })
  await expectCode('FS_SANDBOX_DENIED',
    () => rfs.writeText(target, 'x', undefined, undefined, { mode: 'read-only', workspaceRoot: anchor }),
    'remote write denied under read-only')
  await expectCode('FS_SANDBOX_DENIED',
    () => rfs.editText(target, { oldString: 'a', newString: 'b' }, undefined, undefined, { mode: 'read-only', workspaceRoot: anchor }),
    'remote edit denied under read-only')

  // Containment is judged on the decoded remote POSIX path (splitTarget unwraps ssh://).
  const inside = rfs.splitTarget(await rfs.resolve('sub/y.txt', { cwd: anchor })).target
  check('workspace-write allows inside remote root',
    rfs.remoteCheckedTarget(inside, { mode: 'workspace-write', workspaceRoot: anchor }).targetKey === '/root/test/sub/y.txt')

  const outside = rfs.splitTarget(await rfs.resolve('/etc/passwd', { cwd: anchor })).target
  try {
    rfs.remoteCheckedTarget(outside, { mode: 'workspace-write', workspaceRoot: anchor })
    check('workspace-write denies outside remote root', false)
  } catch (e) {
    check('workspace-write denies outside remote root', e && e.code === 'FS_SANDBOX_DENIED', e && e.message)
  }

  check('danger-full-access allows outside remote root',
    rfs.remoteCheckedTarget(outside, { mode: 'danger-full-access', workspaceRoot: anchor }).targetKey === '/etc/passwd')
  check('no policy delegates unfenced', rfs.remoteCheckedTarget(outside, undefined) === outside)
}

// --- remote shell read-only / workspace-write gate ---
{
  const ex = new SshShellExecutor({
    clientForRemote: () => { throw new Error('should not connect') },
    getPolicy: () => undefined,
    getSandbox: () => undefined,
    getSubprocess: () => undefined,
  })
  const workdir = 'ssh://root@192.168.1.1:22/root/test'

  const denied = await ex.run(ex.resolve({ command: 'rm -rf /', workdir, sandboxPolicy: { mode: 'read-only', workspaceRoot: anchor } }))
  check('remote shell run denied under read-only',
    denied.sandbox !== undefined && denied.sandbox.denied === true && denied.sandbox.mode === 'read-only',
    JSON.stringify(denied.sandbox))
  check('remote shell denial reports non-zero exit', denied.exitCode === 1)

  const proc = ex.start(ex.resolve({ command: 'rm -rf /', workdir, sandboxPolicy: { mode: 'read-only', workspaceRoot: anchor } }))
  check('remote shell start denied under read-only',
    proc.status === 'completed' && proc.sandbox !== undefined && proc.sandbox.denied === true)

  const ww = await ex.run(ex.resolve({ command: 'rm -rf /', workdir, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: anchor } }))
  check('remote shell run denied under workspace-write',
    ww.sandbox !== undefined && ww.sandbox.denied === true && ww.sandbox.mode === 'workspace-write',
    JSON.stringify(ww.sandbox))

  const wwProc = ex.start(ex.resolve({ command: 'rm -rf /', workdir, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: anchor } }))
  check('remote shell start denied under workspace-write',
    wwProc.status === 'completed' && wwProc.sandbox !== undefined && wwProc.sandbox.denied === true)

  // danger-full-access passes the gate → reaches the (stubbed) connection path.
  try {
    await ex.run(ex.resolve({ command: 'rm -rf /', workdir, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: anchor } }))
    check('remote shell run allowed under danger-full-access', false, 'did not reach the connection stub')
  } catch (e) {
    check('remote shell run allowed under danger-full-access', /should not connect/.test(String(e && e.message)))
  }
}

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
