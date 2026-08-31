import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshClient, shellQuote } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'
import { syncMirror, recordInitialBase } from '../src/sync.js'
import { clearSyncLog } from '../src/sync-log.js'

// Simulate two DSH instances (e.g. 3080 + 3090) syncing the same mirror
// concurrently — the fixed temp name used to collide as "No such file".
const machine = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
clearSyncLog()

const c1 = new SshClient({ host: machine.host, user: machine.user, port: machine.port, identityFile: machine.identityFile, passphrase: machine.passphrase })
const c2 = new SshClient({ host: machine.host, user: machine.user, port: machine.port, identityFile: machine.identityFile, passphrase: machine.passphrase })
const s1 = await c1.sftp()
const s2 = await c2.sftp()

const home = String(await s1.realpath('.')).replace(/\/+$/, '')
const ts = Date.now()
const remoteTest = `${home}/.dsh-sync-concurrent-${ts}`
const localDir = join(tmpdir(), `dsh-sync-concurrent-local-${ts}`)

await s1.mkdir(remoteTest)
mkdirSync(localDir, { recursive: true })
writeFileSync(join(localDir, '.dsh-remote-meta.json'), JSON.stringify({
  host: machine.host, port: machine.port ?? null, username: machine.user, remotePath: remoteTest, createdAt: new Date().toISOString(),
}, null, 2) + '\n', 'utf8')
for (const f of ['a.txt', 'b.txt', 'c.txt']) {
  await s1.writeFile(`${remoteTest}/${f}`, Buffer.from('v0-' + f))
  writeFileSync(join(localDir, f), 'v0-' + f)
}
await recordInitialBase(s1, remoteTest, localDir)

writeFileSync(join(localDir, 'a.txt'), 'edited')

const results = await Promise.all([
  syncMirror(s1, localDir, { trigger: 'auto' }).catch((e) => ({ threw: e.message })),
  syncMirror(s2, localDir, { trigger: 'auto' }).catch((e) => ({ threw: e.message })),
])
console.log('r1:', JSON.stringify(results[0]))
console.log('r2:', JSON.stringify(results[1]))

const threw = results.filter((r) => r.threw)
const noSuchFile = results.filter((r) => r.threw && /no such file/i.test(r.threw))
console.log('\nthrew:', threw.length, '| "No such file":', noSuchFile.length)

const r1 = results[0]
const r2 = results[1]
console.log('\n=== VERDICT ===')
console.log(noSuchFile.length === 0 ? 'PASS: no "No such file" collision' : 'FAIL: "No such file" collision')
console.log((r1.ok === true || r1.threw === undefined) && (r2.ok === true || r2.threw === undefined) ? 'PASS: syncs completed without abort' : 'INFO: one sync saw a transient state')

s1.end(); s2.end()
rmSync(localDir, { recursive: true, force: true })
await c1.run(`rm -rf ${shellQuote(remoteTest)}`)
clearSyncLog()
process.exit(noSuchFile.length === 0 ? 0 : 1)
