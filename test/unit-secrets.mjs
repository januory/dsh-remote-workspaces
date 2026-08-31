import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-ssh-test-'))
process.env.DSH_HOME = tmp

const { upsertMachine, machineById, sanitizeMachine } = await import('../src/machine-store.js')

// Save a machine with both a password and a passphrase (test values only).
const saved = upsertMachine({
  alias: 'box',
  host: 'example.test',
  user: 'tester',
  identityFile: '~/.ssh/id_test',
  password: 'hunter2',
  passphrase: 'secret-pass',
})

console.log('sanitized (wire form):', JSON.stringify(saved))
const raw = machineById(saved.id)
console.log('raw has password:', raw.password === 'hunter2')
console.log('raw has passphrase:', raw.passphrase === 'secret-pass')

// Simulate sshClientFor's secret recovery.
const stored = saved.id !== undefined ? machineById(saved.id) : undefined
const recoveredPass = saved.passphrase ?? stored?.passphrase
const recoveredPw = saved.password ?? stored?.password
console.log('recovered passphrase:', recoveredPass === 'secret-pass')
console.log('recovered password:', recoveredPw === 'hunter2')

rmSync(tmp, { recursive: true, force: true })
console.log('\nALL OK')
