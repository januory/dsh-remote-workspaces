import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshClient, shellQuote } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'
import { syncMirror, recordInitialBase } from '../src/sync.js'
import { readSyncLog, clearSyncLog } from '../src/sync-log.js'

const machine = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
const client = new SshClient({ host: machine.host, user: machine.user, port: machine.port, identityFile: machine.identityFile, passphrase: machine.passphrase })

clearSyncLog()

const sftp = await client.sftp()
const home = String(await sftp.realpath('.')).replace(/\/+$/, '')
const ts = Date.now()
const remoteTest = `${home}/.dsh-sync-log-test-${ts}`
const localDir = join(tmpdir(), `dsh-sync-log-local-${ts}`)

await sftp.mkdir(remoteTest)
mkdirSync(localDir, { recursive: true })
writeFileSync(join(localDir, '.dsh-remote-meta.json'), JSON.stringify({
  host: machine.host, port: machine.port ?? null, username: machine.user, remotePath: remoteTest, createdAt: new Date().toISOString(),
}, null, 2) + '\n', 'utf8')

await sftp.writeFile(`${remoteTest}/a.txt`, Buffer.from('hello-secret-content'))
writeFileSync(join(localDir, 'a.txt'), 'hello-secret-content')
await recordInitialBase(sftp, remoteTest, localDir)

// one push (local edit) — this should be logged
writeFileSync(join(localDir, 'a.txt'), 'edited-secret-content')
const r = await syncMirror(sftp, localDir, { trigger: 'manual' })
sftp.end()

const entries = readSyncLog({ limit: 50 })
const last = entries[0]
const raw = JSON.stringify(entries)

console.log('=== LOG ENTRY ===')
console.log(JSON.stringify(last, null, 2))

const checks = []
function check(label, cond) { checks.push({ label, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`) }

check('sync result ok', r.ok === true)
check('one entry logged', entries.length === 1)
check('has ts', !!last.ts)
check('trigger=manual', last.trigger === 'manual')
check('host recorded (no secret)', last.host === machine.host)
check('user recorded', last.user === machine.user)
check('remotePath recorded', last.remotePath === remoteTest)
check('localDir is basename only', !!last.localDir && !last.localDir.includes('\\') && !last.localDir.includes('/'))
check('pushed count', last.pushed === 1)
check('change path recorded', Array.isArray(last.changes) && last.changes.length === 1 && last.changes[0].path === 'a.txt')
check('change action=push', last.changes[0] && last.changes[0].action === 'push')
check('NO file content in log', !raw.includes('hello-secret-content') && !raw.includes('edited-secret-content'))
check('NO identityFile path in log', !raw.includes(machine.identityFile || 'IDFILE_SENTINEL'))
check('NO password/passphrase in log', !raw.includes('passphrase') && !raw.includes('password') && !(machine.passphrase && raw.includes(machine.passphrase)))

// cleanup
clearSyncLog()
rmSync(localDir, { recursive: true, force: true })
const rm = await client.run(`rm -rf ${shellQuote(remoteTest)}`)
check('cleanup remote', rm.ok === true)

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
