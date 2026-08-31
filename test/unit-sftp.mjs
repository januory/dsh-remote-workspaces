import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshClient } from '../src/transport.js'
import { pullTree } from '../src/mirror.js'
import { loadMachines } from '../src/machine-store.js'

const machine = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
const client = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})

const sftp = await client.sftp()
console.log('sftp opened:', !!sftp)

const home = await sftp.realpath('.')
console.log('realpath(.) =', home)

// Pull a small subtree (home is large; use maxDepth 2 and maxFiles 50 to bound).
const tmp = mkdtempSync(join(tmpdir(), 'dsh-mirror-'))
const stats = await pullTree(sftp, home, tmp, { maxDepth: 2, maxFiles: 60, maxFileBytes: 2 * 1024 * 1024 })
console.log('pull stats:', JSON.stringify(stats))

const top = existsSync(tmp) ? readdirSync(tmp) : []
console.log('mirror top-level count:', top.length, 'sample:', top.slice(0, 8).join(', '))

sftp.end()
rmSync(tmp, { recursive: true, force: true })
console.log('\nDONE')
