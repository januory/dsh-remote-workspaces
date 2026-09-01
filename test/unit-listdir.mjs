import { SshClient, shellQuote } from '../src/transport.js'
import { loadMachines } from '../src/machine-store.js'

const machines = loadMachines()
const machine = machines.find((m) => m.alias === 'test') || machines[0]
console.log('machine:', JSON.stringify({ alias: machine.alias, host: machine.host, user: machine.user, port: machine.port, identityFile: machine.identityFile, hasPassphrase: !!machine.passphrase }))

const client = new SshClient({
  host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase,
})

async function resolve(raw) {
  const trimmed = raw === undefined || raw === null ? '' : String(raw).trim()
  let sftp
  try {
    if (trimmed === '' || trimmed === '~' || trimmed === '~/') { sftp = await client.sftp(); return await sftp.realpath('.') }
    if (trimmed.startsWith('~/')) { sftp = await client.sftp(); const h = String(await sftp.realpath('.')).replace(/\/+$/, ''); return h + '/' + trimmed.slice(2) }
    if (!trimmed.startsWith('/')) { sftp = await client.sftp(); return await sftp.realpath(trimmed) }
    return trimmed
  } finally { if (sftp) sftp.end() }
}

async function ls(path) {
  const abs = await resolve(path)
  const cmd = abs === '' ? 'ls -1Ap' : `ls -1Ap ${shellQuote(abs)}`
  const res = await client.run(cmd)
  const lines = (res.stdout || '').split('\n').filter((s) => s !== '')
  return { abs, cmd, ok: res.ok, error: res.error, stderr: (res.stderr || '').trim(), count: lines.length, sample: lines.slice(0, 8) }
}

for (const p of ['', '/', '/etc', '/tmp']) {
  console.log(`\n=== ls(${JSON.stringify(p)}) ===`)
  console.log(JSON.stringify(await ls(p)))
}
