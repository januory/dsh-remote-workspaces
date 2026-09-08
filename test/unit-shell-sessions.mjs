/**
 * Pure-logic unit test for the UI shell-session registry: local vs remote
 * open, write/read/close/resize routing, EOF marking on channel close, and
 * session isolation. Uses a FAKE backend handle (no real PTY / ssh2), so it
 * runs anywhere without a configured machine.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createShellSessions } from '../src/shell-sessions.js'

function fakeHandle(pid = 12345) {
  const output = new EventEmitter()
  const calls = { writes: [], resizes: [], terminated: false }
  return {
    output,
    pid,
    write(data) { calls.writes.push(data) },
    terminate() { calls.terminated = true; return Promise.resolve() },
    resize(r, c) { calls.resizes.push([r, c]) },
    calls,
  }
}

const results = []
function check(label, cond, detail = '') {
  results.push(cond)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  [' + detail + ']' : ''}`)
}

let localHandle
let remoteHandle
let remoteArgs
const spawnSpecs = []

const shells = createShellSessions({
  getSubprocess: () => ({
    spawnTerminal: async (spec) => {
      spawnSpecs.push(spec)
      localHandle = fakeHandle()
      return localHandle
    },
  }),
  openRemote: async (machine, opts) => {
    remoteArgs = { machine, opts }
    remoteHandle = fakeHandle(999)
    return remoteHandle
  },
})

// ---------------------------------------------------------------------------
// openLocal: spawn spec + independent session identity.
// ---------------------------------------------------------------------------
const local = await shells.openLocal({ rows: 30, cols: 100 })
const handle1 = localHandle
check('openLocal returns id/pid/kind', Boolean(local.id) && local.pid === 12345 && local.kind === 'local', JSON.stringify(local))
check('spawnTerminal got rows/cols', spawnSpecs[0].rows === 30 && spawnSpecs[0].cols === 100, JSON.stringify({ rows: spawnSpecs[0].rows, cols: spawnSpecs[0].cols }))
check('spawnTerminal argv non-empty', Array.isArray(spawnSpecs[0].argv) && spawnSpecs[0].argv.length > 0, JSON.stringify(spawnSpecs[0].argv))

// ---------------------------------------------------------------------------
// write → handle.write; read → drained buffer; resize → handle.resize.
// ---------------------------------------------------------------------------
await shells.write(local.id, 'echo hi\n')
check('write routes to handle', localHandle.calls.writes.length === 1 && localHandle.calls.writes[0] === 'echo hi\n')

localHandle.output.emit('data', Buffer.from('hello '))
localHandle.output.emit('data', Buffer.from('world'))
const r1 = shells.read(local.id)
check('read drains buffered bytes', r1.text === 'hello world' && r1.eof === false, JSON.stringify(r1))
check('read is destructive', shells.read(local.id).text === '')

const rs = await shells.resize(local.id, 40, 120)
check('resize routes to handle.resize', rs.resized === true && localHandle.calls.resizes.length === 1 && localHandle.calls.resizes[0][0] === 40 && localHandle.calls.resizes[0][1] === 120, JSON.stringify(localHandle.calls.resizes))

// ---------------------------------------------------------------------------
// EOF marking on channel close.
// ---------------------------------------------------------------------------
const local2 = await shells.openLocal({})
localHandle.output.emit('close')
check('read reports eof after close', shells.read(local2.id).eof === true)
await shells.write(local2.id, 'x')
check('write after eof is dropped', localHandle.calls.writes.length === 0, `writes=${localHandle.calls.writes.length}`)

// ---------------------------------------------------------------------------
// openRemote: callback args + null pid + remote kind.
// ---------------------------------------------------------------------------
const machine = { id: 'm1', alias: 'dev', host: '10.0.0.2', user: 'u' }
const remote = await shells.openRemote(machine, { rows: 25, cols: 90 })
check('openRemote returns id/pid=null/kind', Boolean(remote.id) && remote.pid === null && remote.kind === 'remote', JSON.stringify(remote))
check('openRemote forwards machine + opts', remoteArgs.machine === machine && remoteArgs.opts.rows === 25 && remoteArgs.opts.cols === 90)
check('remote resize uses setWindow', (await shells.resize(remote.id, 50, 130)).resized === true && remoteHandle.calls.resizes[0][0] === 50)

// ---------------------------------------------------------------------------
// list + close + isolation.
// ---------------------------------------------------------------------------
const before = shells.list()
check('list shows local + remote sessions', before.length === 3, JSON.stringify(before.map((s) => s.kind)))
check('list labels remote by alias', before.some((s) => s.kind === 'remote' && s.label === 'dev'))

const closed = await shells.close(local.id)
check('close terminates + removes', closed.closed === true && handle1.calls.terminated === true)
check('close missing session → closed:false', (await shells.close('nope')).closed === false)
check('read missing session throws', (() => { try { shells.read(local.id); return false } catch { return true } })())

// Missing remote open callback ⇒ explicit error (not a silent no-op).
const noRemote = createShellSessions({ getSubprocess: () => undefined })
let threw = false
try { await noRemote.openRemote(machine, {}) } catch { threw = true }
check('openRemote without backend throws', threw === true)

// ---------------------------------------------------------------------------
// attach: a stable key reuses a live session instead of spawning anew.
// ---------------------------------------------------------------------------
{
  const k1 = await shells.openLocal({ key: 'attach-k1' })
  const k1again = await shells.openLocal({ key: 'attach-k1' })
  check('local attach reuses the same session id', k1.id === k1again.id && k1again.attached === true, `${k1.id} vs ${k1again.id}`)
  const k2 = await shells.openLocal({ key: 'attach-k2' })
  check('a different key opens a distinct session', k2.id !== k1.id && k2.attached === false)
  const r1 = await shells.openRemote(machine, { key: 'attach-r1' })
  const r1again = await shells.openRemote(machine, { key: 'attach-r1' })
  check('remote attach reuses the same session id', r1.id === r1again.id && r1again.attached === true)
  const r2 = await shells.openRemote(machine, { key: 'attach-r2' })
  check('remote different key opens a distinct session', r2.id !== r1.id && r2.attached === false)
}

// ---------------------------------------------------------------------------
// attach replays the full (capped) history and resets the unread tail.
// ---------------------------------------------------------------------------
{
  const h1 = await shells.openLocal({ key: 'hist-k1' })
  localHandle.output.emit('data', Buffer.from('line1\n'))
  localHandle.output.emit('data', Buffer.from('line2\n'))
  const h1again = await shells.openLocal({ key: 'hist-k1' })
  check('attach replays full history', h1again.attached === true && h1again.history === 'line1\nline2\n', JSON.stringify(h1again.history))
  check('attach resets unread (no double replay)', shells.read(h1again.id).text === '')
}

// ---------------------------------------------------------------------------
// sweep: reaps sessions idle beyond the threshold, keeps fresh ones.
// ---------------------------------------------------------------------------
{
  let sweepHandle
  const sweepShells = createShellSessions({
    getSubprocess: () => ({ spawnTerminal: async () => { sweepHandle = fakeHandle(); return sweepHandle } }),
    sweepMs: 1000,
  })
  const s1 = await sweepShells.openLocal({ key: 'sweep-k1' })
  sweepShells.sweep(Date.now())
  check('sweep keeps a fresh session', sweepShells.list().length === 1)
  sweepShells.sweep(Date.now() + 5000)
  check('sweep reaps an idle session', sweepShells.list().length === 0)
  // An ended session is not touched by sweep (its handle already closed).
  const s2 = await sweepShells.openLocal({ key: 'sweep-k2' })
  sweepHandle.output.emit('close')
  sweepShells.sweep(Date.now() + 99999)
  check('sweep leaves ended sessions for close()', sweepShells.list().length === 1 && sweepShells.list()[0].ended === true)
}

const failed = results.filter((r) => !r)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
