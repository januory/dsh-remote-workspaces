import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Persistent multi-machine SSH registry, stored as a local JSON file under
 * the DSH home (matching the harness's own data location):
 *
 *   <dsh-home>/remote-workspaces/machines.json
 *
 * Secrets (`password`, `passphrase`) are AES-256-GCM encrypted at rest with a
 * key kept in a separate file (`<dsh-home>/remote-workspaces/.secret-key`), so
 * a plaintext dump of machines.json never exposes them. They are decrypted only
 * in memory and never sent back to the browser — `sanitizeMachine` strips them,
 * exposing only a `hasPassword`/`hasPassphrase` flag. On POSIX both files are
 * chmod'd 0600; on Windows the OS ACL applies (the encrypted form still stops
 * casual/grep-style disclosure). Legacy plaintext secrets are read transparently
 * and re-encrypted on the next write (see `ensureSecretsEncrypted`).
 */

const SECRET_PREFIX = 'enc:v1:'
const KEY_NAME = '.secret-key'

function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** Mirror of the harness's `resolveDshHome()`: `$DSH_HOME` (non-blank) else `~/.dsh`. */
export function machinesRoot() {
  const fromEnv = process.env.DSH_HOME
  const selected = fromEnv !== undefined && String(fromEnv).trim().length > 0
    ? fromEnv
    : join(homedir(), '.dsh')
  return resolve(expandHomePath(selected))
}

export function machinesPath() {
  return join(machinesRoot(), 'remote-workspaces', 'machines.json')
}

function keyPath() {
  return join(machinesRoot(), 'remote-workspaces', KEY_NAME)
}

/**
 * Load (or create) the local 32-byte encryption key. Creating it on first use
 * keeps it out of the registry file itself; a machine that loses the key file
 * simply cannot decrypt old secrets (a fresh key is created and the user
 * re-enters the credentials).
 */
function loadKey() {
  const path = keyPath()
  try {
    const hex = readFileSync(path, 'utf8').trim()
    const buf = Buffer.from(hex, 'hex')
    if (buf.length === 32) return buf
  } catch {}
  const key = randomBytes(32)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, key.toString('hex') + '\n', { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(path, 0o600) } catch {}
  } catch {}
  return key
}

/** `enc:v1:<iv><tag><ciphertext>` (base64) for a non-empty, not-yet-encrypted secret. */
function encryptSecret(value) {
  if (value === undefined || value === null) return value
  const s = String(value)
  if (s === '' || s.startsWith(SECRET_PREFIX)) return s
  const key = loadKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return SECRET_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

/** Decrypt an `enc:` secret; pass legacy plaintext through; `undefined` on failure. */
function decryptSecret(value) {
  if (typeof value !== 'string' || !value.startsWith(SECRET_PREFIX)) return value
  try {
    const key = loadKey()
    const raw = Buffer.from(value.slice(SECRET_PREFIX.length), 'base64')
    if (raw.length < 28) return undefined
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const enc = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

function encryptMachineSecrets(machine) {
  const out = { ...machine }
  for (const field of ['password', 'passphrase']) {
    if (out[field] === undefined) continue
    out[field] = encryptSecret(out[field])
  }
  return out
}

function decryptMachineSecrets(machine) {
  const out = { ...machine }
  for (const field of ['password', 'passphrase']) {
    if (out[field] === undefined || out[field] === null) continue
    const plain = decryptSecret(out[field])
    if (plain === undefined) delete out[field]
    else out[field] = plain
  }
  return out
}

function isPlainSecret(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith(SECRET_PREFIX)
}

export function loadMachines() {
  const path = machinesPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const machines = parsed && typeof parsed === 'object' ? parsed.machines : undefined
    return Array.isArray(machines)
      ? machines.filter((m) => m && typeof m === 'object').map(decryptMachineSecrets)
      : []
  } catch {
    return []
  }
}

function persistMachines(machines) {
  const path = machinesPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ machines: machines.map(encryptMachineSecrets) }, null, 2) + '\n', 'utf8')
  try { chmodSync(path, 0o600) } catch {}
}

/**
 * One-time migration: if the on-disk registry still holds plaintext secrets,
 * re-persist it (which encrypts them). Called once at plugin startup so an
 * existing install becomes secure without the user having to edit a host.
 * Returns true when a rewrite happened.
 */
export function ensureSecretsEncrypted() {
  const path = machinesPath()
  if (!existsSync(path)) return false
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const machines = raw && typeof raw === 'object' ? raw.machines : undefined
    if (!Array.isArray(machines)) return false
    const hasPlain = machines.some((m) => m && typeof m === 'object' && (
      isPlainSecret(m.password) || isPlainSecret(m.passphrase)
    ))
    if (!hasPlain) return false
    persistMachines(machines)
    return true
  } catch {
    return false
  }
}

/** Projection safe to cross the Remote boundary (no password, no passphrase). */
export function sanitizeMachine(machine) {
  return {
    id: machine.id,
    alias: machine.alias ?? '',
    host: machine.host ?? '',
    port: machine.port ?? null,
    user: machine.user ?? null,
    identityFile: machine.identityFile ?? null,
    hasPassword: Boolean(machine.password),
    hasPassphrase: Boolean(machine.passphrase),
  }
}

/**
 * Insert or update one machine by id. A missing id creates a new machine.
 * `password`/`passphrase` are one-way writes: an empty string clears the stored
 * secret, and `undefined`/absent leaves the existing value untouched.
 */
export function upsertMachine(input) {
  const machines = loadMachines()
  let machine = input.id === undefined ? undefined : machines.find((m) => m.id === input.id)
  if (machine === undefined) {
    machine = { id: randomUUID() }
    machines.push(machine)
  }
  if (input.alias !== undefined) machine.alias = String(input.alias ?? '')
  if (input.host !== undefined) machine.host = String(input.host ?? '')
  if (input.port !== undefined) machine.port = input.port === null || input.port === '' ? null : Number(input.port) || null
  if (input.user !== undefined) machine.user = input.user === null || input.user === '' ? null : String(input.user)
  if (input.identityFile !== undefined) {
    machine.identityFile = input.identityFile === null || input.identityFile === '' ? null : String(input.identityFile)
  }
  if (input.password === '') delete machine.password
  else if (input.password !== undefined) machine.password = String(input.password)
  if (input.passphrase === '') delete machine.passphrase
  else if (input.passphrase !== undefined) machine.passphrase = String(input.passphrase)
  persistMachines(machines)
  return sanitizeMachine(machine)
}

export function removeMachine(id) {
  const machines = loadMachines()
  const next = machines.filter((m) => m.id !== id)
  persistMachines(next)
  return next.length !== machines.length
}

/** The raw record (with secrets) used to build an SSH connection. */
export function machineById(id) {
  return loadMachines().find((m) => m.id === id)
}

/**
 * Find a saved machine by its connection identity (host + user + effective
 * port). Mirrors record only these fields in their `.dsh-remote-meta.json`,
 * so reconnecting for sync matches them back to a stored machine (and its
 * secret) this way, surviving machine id churn.
 */
export function machineForRemote({ host, port, user }) {
  const h = String(host ?? '')
  const u = String(user ?? '')
  const p = Number(port) || 22
  return loadMachines().find((m) => {
    return String(m.host ?? '') === h
      && String(m.user ?? '') === u
      && (Number(m.port) || 22) === p
  })
}
