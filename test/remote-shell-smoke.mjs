/**
 * Real-machine smoke test for the interactive remote shell channel
 * (`SshClient.openShell`): open a PTY shell, prove stdin→stdout round-trip via
 * an `echo` marker, exercise `resize` (`setWindow`), then `exit` and verify the
 * channel closes cleanly.
 *
 * Target selection: `$DSH_RW_TEST_ALIAS`, else the alias `test`, else the first
 * machine in the registry. Runs on any POSIX or Windows OpenSSH target (the
 * shell channel is the same mechanism on both).
 */

import { loadMachines } from '../src/machine-store.js'
import { SshClient } from '../src/transport.js'

const alias = process.env.DSH_RW_TEST_ALIAS
const machines = loadMachines()
const machine = (alias && machines.find((m) => m.alias === alias)) || machines.find((m) => m.alias === 'test') || machines[0]
if (machine === undefined) {
  console.log('FAIL  no configured machine to test against')
  process.exit(1)
}

const client = new SshClient({
  alias: machine.alias, host: machine.host, user: machine.user, port: machine.port,
  identityFile: machine.identityFile, passphrase: machine.passphrase, readyTimeoutMs: 15000,
})

const results = []
function check(label, cond, detail = '') {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function readUntil(handle, predicate, timeoutMs) {
  return new Promise((resolve) => {
    let buf = ''
    let timer
    const onData = (chunk) => {
      buf += String(chunk)
      if (predicate(buf)) { cleanup(); resolve(buf) }
    }
    const onClose = () => { cleanup(); resolve(buf) }
    const cleanup = () => {
      clearTimeout(timer)
      handle.output.removeListener('data', onData)
      handle.output.removeListener('close', onClose)
    }
    timer = setTimeout(() => { cleanup(); resolve(buf) }, timeoutMs)
    handle.output.on('data', onData)
    handle.output.on('close', onClose)
  })
}

function waitClose(handle, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { handle.output.removeListener('close', onClose); resolve(false) }, timeoutMs)
    function onClose() { clearTimeout(timer); resolve(true) }
    handle.output.on('close', onClose)
  })
}

console.log(`target: ${machine.alias} (${machine.user}@${machine.host}:${machine.port})`)

let handle
try {
  handle = await client.openShell({ rows: 24, cols: 80 })
} catch (error) {
  check('openShell connects', false, error.message)
  process.exit(1)
}
check('openShell connects + returns handle', Boolean(handle && handle.output && typeof handle.write === 'function'))

// Drain the banner / motd / prompt so the marker read below is unambiguous.
await sleep(1500)
await readUntil(handle, () => true, 500)

handle.write('echo __SHELL_SMOKE_OK__\r')
const echoOut = await readUntil(handle, (t) => t.includes('__SHELL_SMOKE_OK__'), 15000)
check('echo marker round-trips', echoOut.includes('__SHELL_SMOKE_OK__'), JSON.stringify(echoOut.slice(-140)))

handle.resize(30, 100)
check('resize (setWindow) reachable', true)

handle.write('exit\r')
const closed = await waitClose(handle, 15000)
check('channel closes after exit', closed === true, closed ? '' : '(no close event within 15s)')

const failed = results.filter((r) => !r)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
