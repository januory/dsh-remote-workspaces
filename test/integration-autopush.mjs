import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SshClient, shellQuote } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'
import { ensureMirror, pullTree } from '../src/mirror.js'
import { recordInitialBase } from '../src/sync.js'

// This exercises the host-side fs.watch auto-push loop in the *running* 3090
// instance: we create a mirror under the real ~/.dsh/remote-workspaces, edit a
// local file from THIS separate process, and expect the 3090 watcher to detect
// it and push the edit to the remote.

const machine = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
const client = new SshClient({ host: machine.host, user: machine.user, port: machine.port, identityFile: machine.identityFile, passphrase: machine.passphrase })

const sftp = await client.sftp()
const home = String(await sftp.realpath('.')).replace(/\/+$/, '')
const ts = Date.now()
const remoteTest = `${home}/.dsh-autopush-test-${ts}`
await sftp.mkdir(remoteTest)
await sftp.writeFile(`${remoteTest}/a.txt`, Buffer.from('initial'))
const localDir = ensureMirror(machine, remoteTest)
await pullTree(sftp, remoteTest, localDir, { maxDepth: 2, maxFiles: 100 })
await recordInitialBase(sftp, remoteTest, localDir, { maxDepth: 2, maxFiles: 100 })
sftp.end()

console.log('mirror:', localDir)
console.log('local a.txt before:', readFileSync(join(localDir, 'a.txt'), 'utf8'))

// local edit — the 3090 watcher should auto-push it (debounce ~600ms + sync).
writeFileSync(join(localDir, 'a.txt'), 'edited-by-watcher-test')
console.log('local a.txt edited → waiting for watcher…')

await new Promise((res) => setTimeout(res, 5000))

const sftp2 = await client.sftp()
const remoteContent = (await sftp2.readFile(`${remoteTest}/a.txt`)).toString()
sftp2.end()
console.log('remote a.txt after wait:', JSON.stringify(remoteContent))
console.log(remoteContent === 'edited-by-watcher-test' ? 'AUTOPUSH PASS' : 'AUTOPUSH FAIL')

// cleanup
rmSync(localDir, { recursive: true, force: true })
const rm = await client.run(`rm -rf ${shellQuote(remoteTest)}`)
console.log('cleanup remote:', rm.ok, rm.stderr || '')
