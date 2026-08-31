import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshClient, shellQuote } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'
import { syncMirror, recordInitialBase } from '../src/sync.js'

const machine = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
const client = new SshClient({ host: machine.host, user: machine.user, port: machine.port, identityFile: machine.identityFile, passphrase: machine.passphrase })
const sftp = await client.sftp()

const home = String(await sftp.realpath('.')).replace(/\/+$/, '')
const ts = Date.now()
const remoteTest = `${home}/.dsh-sync-test-${ts}`
const localDir = join(tmpdir(), `dsh-sync-local-${ts}`)

await sftp.mkdir(remoteTest)
mkdirSync(localDir, { recursive: true })
writeFileSync(join(localDir, '.dsh-remote-meta.json'), JSON.stringify({
  host: machine.host, port: machine.port ?? null, username: machine.user, remotePath: remoteTest, createdAt: new Date().toISOString(),
}, null, 2) + '\n', 'utf8')

const rp = (rel) => `${remoteTest}/${rel}`
const lp = (rel) => join(localDir, rel)
const rread = async (rel) => { const b = await sftp.readFile(rp(rel)); return b.toString() }
const lread = (rel) => readFileSync(lp(rel), 'utf8')
const rwrite = (rel, s) => sftp.writeFile(rp(rel), Buffer.from(s))
const lwrite = (rel, s) => writeFileSync(lp(rel), s)
const rexists = async (rel) => { try { await sftp.stat(rp(rel)); return true } catch { return false } }
const lexists = (rel) => existsSync(lp(rel))
const rdel = (rel) => sftp.unlink(rp(rel))
const ldel = (rel) => unlinkSync(lp(rel))

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// ---- initial state: a.txt, b.txt on both sides ----
await rwrite('a.txt', 'hello')
await rwrite('b.txt', 'world')
await sftp.readFile(rp('a.txt')) // warm
// pull initial into local so both sides agree
writeFileSync(lp('a.txt'), 'hello')
writeFileSync(lp('b.txt'), 'world')
await recordInitialBase(sftp, remoteTest, localDir, { maxDepth: 4, maxFiles: 1000 })

// ---- S1: local edit + remote unchanged → push ----
lwrite('a.txt', 'hello-local')
let r = await syncMirror(sftp, localDir)
check('S1 push: local edit uploaded', (await rread('a.txt')) === 'hello-local', `pulled=${r.pulled} pushed=${r.pushed}`)

// ---- S2: remote edit + local unchanged → pull ----
await rwrite('b.txt', 'world-remote')
r = await syncMirror(sftp, localDir)
check('S2 pull: remote edit downloaded', lread('b.txt') === 'world-remote', `pulled=${r.pulled} pushed=${r.pushed}`)

// ---- S3: remote edit + local edit → remote wins ----
await rwrite('a.txt', 'remote-wins')
lwrite('a.txt', 'local-wins')
r = await syncMirror(sftp, localDir)
check('S3 conflict: remote wins', lread('a.txt') === 'remote-wins', `local=${lread('a.txt')} pulled=${r.pulled} pushed=${r.pushed}`)

// ---- S4: remote delete + local changed → local delete ----
await rdel('b.txt')
lwrite('b.txt', 'local-modified')
r = await syncMirror(sftp, localDir)
check('S4 remote delete wins: local deleted', !lexists('b.txt'), `pulled=${r.pulled} pushed=${r.pushed}`)
check('S4 remote still gone', !(await rexists('b.txt')))

// ---- S5: remote add → pull ----
await rwrite('c.txt', 'new-remote')
r = await syncMirror(sftp, localDir)
check('S5 remote add downloaded', lexists('c.txt') && lread('c.txt') === 'new-remote', `pulled=${r.pulled}`)

// ---- S6: local add + remote unchanged → push ----
lwrite('d.txt', 'new-local')
r = await syncMirror(sftp, localDir)
check('S6 local add uploaded', (await rexists('d.txt')) && (await rread('d.txt')) === 'new-local', `pushed=${r.pushed}`)

// ---- S7: local delete + remote unchanged → push delete ----
ldel('d.txt')
r = await syncMirror(sftp, localDir)
check('S7 local delete pushed', !(await rexists('d.txt')), `pushed=${r.pushed}`)

// ---- S8: no-op sync ----
r = await syncMirror(sftp, localDir)
check('S8 no-op sync does nothing', r.pulled === 0 && r.pushed === 0, `pulled=${r.pulled} pushed=${r.pushed}`)

sftp.end()

// cleanup remote test dir via shell, and local temp dir
const rm = await client.run(`rm -rf ${shellQuote(remoteTest)}`)
check('cleanup remote test dir', rm.ok === true, rm.stderr || '')
rmSync(localDir, { recursive: true, force: true })

const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
