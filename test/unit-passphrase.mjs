import { SshClient } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'

const machine = loadMachines().find((m) => m.alias === 'master')
if (!machine || !machine.identityFile || !machine.passphrase) {
  console.log('SKIP: needs a passphrase-protected "master" machine in the registry')
  process.exit(0)
}

// Wrong passphrase -> should fail at key parse (before any network), NOT succeed.
const wrong = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: 'definitely-wrong-passphrase',
})
const r1 = await wrong.run('echo ok', { timeoutMs: 8000 })
console.log('wrong passphrase result:', JSON.stringify({ ok: r1.ok, error: r1.error }))
console.log('  -> parsed-as-key-failure:', /私钥|口令|parse/i.test(r1.error || ''))

// Correct passphrase -> should NOT hit a key-parse failure.
const right = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})
const r2 = await right.run('echo ok', { timeoutMs: 12000 })
console.log('correct passphrase result:', JSON.stringify({ ok: r2.ok, error: r2.error }))
console.log('  -> not a parse failure:', !/私钥|口令|parse/i.test(r2.error || ''))
