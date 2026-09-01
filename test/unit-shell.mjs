import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

const anchor = join(home, 'remote-workspaces', 'test-root-22', 'root--test')
registerAnchor({ anchorPath: anchor, machineId: 'm1', host: '192.168.1.1', port: 22, user: 'root', remotePath: '/root/test' })

const ex = new SshShellExecutor({ clientForRemote: () => ({}), getPolicy: () => undefined, getSandbox: () => undefined, getSubprocess: () => undefined })

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

rmSync(home, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
