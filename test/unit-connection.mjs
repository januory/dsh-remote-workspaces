import { SshClient } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'

const machine = loadMachines().find((m) => m.alias === 'test') || loadMachines()[0]
if (!machine) {
  console.log('SKIP: no machine in the registry (~/.dsh/remote-workspaces/machines.json)')
  process.exit(0)
}
const client = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})

console.log('== testConnection (passphrase key via ssh2) ==')
const t = await client.run('echo ok', { timeoutMs: 20000 })
console.log('result:', JSON.stringify({ ok: t.ok, ms: t.ms, error: t.error, out: (t.stdout || '').trim() }))

if (t.ok) {
  console.log('\n== listRemoteDir (home) ==')
  const l = await client.run('ls -1Ap', { timeoutMs: 20000 })
  console.log('ok:', l.ok, 'entries:', l.ok ? l.stdout.split('\n').filter(Boolean).length : l.error)
  if (l.ok) console.log('first:', l.stdout.split('\n').filter(Boolean).slice(0, 10).join(', '))
}
