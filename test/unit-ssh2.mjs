import { SshClient } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'

const machine = loadMachines().find((m) => m.alias === 'mac') || loadMachines()[0]
const client = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})

console.log('== testConnection (key auth via ssh2) ==')
const t = await client.run('echo ok')
console.log('result:', JSON.stringify({ ok: t.ok, ms: t.ms, error: t.error, out: (t.stdout || '').trim() }))

console.log('\n== listRemoteDir (home) ==')
const l = await client.run('ls -1Ap')
console.log('ok:', l.ok, 'entries:', l.ok ? l.stdout.split('\n').filter(Boolean).length : l.error)
console.log('first entries:', l.stdout.split('\n').filter(Boolean).slice(0, 8).join(', '))
