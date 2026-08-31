import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshClient, shellQuote } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'
import { ensureMirror, pullTree } from '../src/mirror.js'
import { syncMirror, recordInitialBase } from '../src/sync.js'

// Read january's machine from the REAL registry before redirecting DSH_HOME.
const machine = loadMachines().find((m) => m.alias === 'january')
if (!machine) {
  console.log('SKIP: no "january" machine in the registry')
  process.exit(0)
}

// Redirect DSH_HOME so the mirror + sync log land in a throwaway dir instead of
// touching the real ~/.dsh (this keeps the user's sync log and mirror root clean).
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-integ-home-'))
process.env.DSH_HOME = dshHome

const client = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})

const baseDir = '/data/test'
const sftp = await client.sftp()
let baseOk = true
try { await sftp.stat(baseDir) } catch { baseOk = false }
if (!baseOk) {
  console.log('SKIP: /data/test not reachable on january')
  sftp.end()
  rmSync(dshHome, { recursive: true, force: true })
  process.exit(0)
}

const ts = Date.now()
const remoteTest = `${baseDir}/.dsh-race-test-${ts}`
await sftp.mkdir(remoteTest)
await sftp.writeFile(`${remoteTest}/keep.txt`, Buffer.from('survive-me'))

const localDir = ensureMirror(machine, remoteTest)
await pullTree(sftp, remoteTest, localDir, { maxDepth: 2, maxFiles: 100 })
await recordInitialBase(sftp, remoteTest, localDir, { maxDepth: 2, maxFiles: 100 })

const rp = (rel) => `${remoteTest}/${rel}`
const lp = (rel) => join(localDir, rel)
const rexists = async (rel) => { try { await sftp.stat(rp(rel)); return true } catch { return false } }
const rread = async (rel) => (await sftp.readFile(rp(rel))).toString()

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// R1: transient absence (atomic-save window) must NOT delete the remote file.
// Delete locally, start a sync, and restore the file during the confirm window.
rmSync(lp('keep.txt'), { force: true })
const syncing = syncMirror(sftp, localDir, { deleteConfirmMs: 8000, maxDepth: 2, maxFiles: 100 })
const restore = setTimeout(() => writeFileSync(lp('keep.txt'), 'survive-me'), 2000)
const r1 = await syncing
clearTimeout(restore)
check('R1 transient window: remote survives', await rexists('keep.txt'), `pushed=${r1.pushed} pulled=${r1.pulled}`)
check('R1 transient window: remote content intact', (await rread('keep.txt')) === 'survive-me')
check('R1 local file restored', existsSync(lp('keep.txt')))

// R2: genuine local delete still propagates to the remote.
rmSync(lp('keep.txt'), { force: true })
const r2 = await syncMirror(sftp, localDir, { deleteConfirmMs: 500, maxDepth: 2, maxFiles: 100 })
check('R2 genuine delete: remote removed', !(await rexists('keep.txt')), `pushed=${r2.pushed}`)

// cleanup
sftp.end()
rmSync(localDir, { recursive: true, force: true })
const rm = await client.run(`rm -rf ${shellQuote(remoteTest)}`)
check('cleanup remote test dir', rm.ok === true, rm.stderr || '')
rmSync(dshHome, { recursive: true, force: true })

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
