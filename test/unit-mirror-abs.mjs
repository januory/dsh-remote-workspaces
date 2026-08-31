import { rmSync } from 'node:fs'
import { SshClient } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'
import { ensureMirror, pullTree } from '../src/mirror.js'

const mac = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
const client = new SshClient({ host: mac.host, user: mac.user, port: mac.port, identityFile: mac.identityFile, passphrase: mac.passphrase })

const sftp = await client.sftp()
const remotePath = await sftp.realpath('/tmp') // absolute path, as the client now sends
const localDir = ensureMirror(mac, remotePath)
const stats = await pullTree(sftp, remotePath, localDir, { maxDepth: 2, maxFiles: 30 })
sftp.end()

console.log('remotePath:', remotePath)
console.log('localDir:', localDir)
console.log('stats:', JSON.stringify(stats))
console.log('mirror with absolute path: OK')

rmSync(localDir, { recursive: true, force: true })
console.log('cleaned mirror:', localDir)
