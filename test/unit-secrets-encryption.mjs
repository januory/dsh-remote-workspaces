import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-secrets-enc-'))
process.env.DSH_HOME = tmp

const { upsertMachine, machineById, sanitizeMachine, machinesPath, ensureSecretsEncrypted, loadMachines } = await import('../src/machine-store.js')

const results = []
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

// 1. Save a machine with secrets; the on-disk file must NOT contain plaintext.
const saved = upsertMachine({
  alias: 'box',
  host: 'example.test',
  user: 'tester',
  identityFile: '~/.ssh/id_test',
  password: 'hunter2',
  passphrase: 'secret-pass',
})
const onDisk = readFileSync(machinesPath(), 'utf8')
check('on-disk file has no plaintext password', !onDisk.includes('hunter2'))
check('on-disk file has no plaintext passphrase', !onDisk.includes('secret-pass'))
check('on-disk file uses encrypted marker', onDisk.includes('enc:v1:'))

// 2. In-memory read round-trips back to plaintext.
const raw = machineById(saved.id)
check('decrypt: password round-trips', raw.password === 'hunter2')
check('decrypt: passphrase round-trips', raw.passphrase === 'secret-pass')

// 3. sanitize still exposes only flags, never the secrets.
const wire = sanitizeMachine(raw)
check('sanitize: flags true', wire.hasPassword === true && wire.hasPassphrase === true)
check('sanitize: no secret fields', !('password' in wire) && !('passphrase' in wire))

// 4. Already-encrypted registry → migration is a no-op.
check('ensureSecretsEncrypted: no-op when already encrypted', ensureSecretsEncrypted() === false)

// 5. Legacy plaintext registry → migration rewrites it encrypted, secrets recoverable.
const legacy = {
  machines: [{
    id: 'legacy-1', alias: 'old', host: 'legacy.test', user: 'u',
    identityFile: '~/.ssh/id_old', password: 'legacy-pass', passphrase: 'legacy-phrase',
  }],
}
writeFileSync(machinesPath(), JSON.stringify(legacy, null, 2) + '\n', 'utf8')
check('ensureSecretsEncrypted: migrates plaintext', ensureSecretsEncrypted() === true)
const migratedDisk = readFileSync(machinesPath(), 'utf8')
check('migrated file has no plaintext', !migratedDisk.includes('legacy-pass') && !migratedDisk.includes('legacy-phrase'))
const migrated = loadMachines().find((m) => m.id === 'legacy-1')
check('migrated machine still decrypts', migrated.password === 'legacy-pass' && migrated.passphrase === 'legacy-phrase')

rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((x) => !x.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
