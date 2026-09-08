import { randomUUID } from 'node:crypto'

/**
 * In-process registry of interactive UI shell sessions (local + remote).
 *
 * Every `openLocal` allocates an INDEPENDENT PTY process through the harness's
 * `ctx.subprocess.spawnTerminal` seam; every `openRemote` opens an INDEPENDENT
 * ssh2 shell channel through `SshClient.openShell`. Sessions never share a
 * process/connection, cwd, stdin/stdout, or buffer (the §3.1 isolation model).
 * Lifecycle is process-local (matches ctx.terminals semantics): no persistence,
 * no cross-process recovery.
 *
 * A session keeps TWO buffers over the same stream:
 *   - `unread` — drained by `read` (incremental polling);
 *   - `history` — the full (capped) output, returned on ATTACH so a re-mounted
 *     tab replays its scrollback instead of coming back blank.
 *
 * Attach: an `open*` carrying a stable `key` REUSES a still-live session under
 * that key instead of spawning a new one — this is what keeps a Shell tab's
 * terminal alive across the client unmounting it on a DSH-session switch.
 */

const MAX_UNREAD = 256 * 1024
const MAX_HISTORY = 512 * 1024

export function createShellSessions({ getSubprocess, openRemote: openRemoteChannel, sweepMs = 10 * 60 * 1000 }) {
  const sessions = new Map()

  // Reap sessions no client has read from or written to within `sweepMs`: a
  // shell whose tab was lost to a refresh (or an archived session) has nobody
  // left to close it. An on-screen tab polls continuously, so only abandoned
  // shells — or ones hidden longer than the threshold — are collected.
  function sweep(now = Date.now()) {
    for (const [id, session] of [...sessions]) {
      if (!session.ended && now - session.lastActivityAt > sweepMs) {
        sessions.delete(id)
        void session.handle.terminate()
      }
    }
  }
  const sweepTimer = setInterval(sweep, 60 * 1000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  function liveSession(key) {
    if (typeof key !== 'string' || key === '') return undefined
    const existing = sessions.get(key)
    return existing !== undefined && !existing.ended ? existing : undefined
  }

  function pushCapped(bag, cap, buf) {
    bag.chunks.push(buf)
    bag.bytes += buf.length
    while (bag.bytes > cap && bag.chunks.length > 1) {
      bag.bytes -= bag.chunks.shift().length
    }
  }

  function register(handle, meta, key) {
    const id = typeof key === 'string' && key !== '' ? key : randomUUID()
    const session = {
      id,
      handle,
      meta,
      unread: { chunks: [], bytes: 0 },
      history: { chunks: [], bytes: 0 },
      ended: false,
      lastActivityAt: Date.now(),
    }
    handle.output.on('data', (chunk) => {
      const buf = Buffer.from(chunk)
      pushCapped(session.unread, MAX_UNREAD, buf)
      pushCapped(session.history, MAX_HISTORY, buf)
    })
    handle.output.on('end', () => { session.ended = true })
    handle.output.on('close', () => { session.ended = true })
    sessions.set(id, session)
    return session
  }

  function historyText(session) {
    return Buffer.concat(session.history.chunks).toString('utf8')
  }

  async function openLocal(opts = {}) {
    const key = typeof opts.key === 'string' && opts.key !== '' ? opts.key : undefined
    const existing = liveSession(key)
    if (existing !== undefined) {
      const history = historyText(existing)
      // The attach hands the client the full scrollback, so the unread tail is
      // now covered — start incremental reads fresh to avoid double replay.
      existing.unread.chunks.length = 0
      existing.unread.bytes = 0
      return { id: existing.id, pid: existing.handle.pid, kind: 'local', attached: true, history }
    }
    const subprocess = getSubprocess()
    if (subprocess === undefined || typeof subprocess.spawnTerminal !== 'function') {
      throw new Error('subprocess service unavailable (no spawnTerminal)')
    }
    const win = process.platform === 'win32'
    const argv = win ? ['powershell.exe', '-NoLogo'] : ['bash', '-i']
    const cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : process.cwd()
    const rows = Number.isInteger(opts.rows) && opts.rows > 0 ? opts.rows : 24
    const cols = Number.isInteger(opts.cols) && opts.cols > 0 ? opts.cols : 80
    const handle = await subprocess.spawnTerminal({ argv, cwd, rows, cols, graceMs: 3000 })
    const session = register(handle, { kind: 'local', label: win ? 'PowerShell' : 'bash' }, key)
    return { id: session.id, pid: handle.pid, kind: 'local', attached: false }
  }

  async function openRemote(machine, opts = {}) {
    const key = typeof opts.key === 'string' && opts.key !== '' ? opts.key : undefined
    const existing = liveSession(key)
    if (existing !== undefined) {
      const history = historyText(existing)
      existing.unread.chunks.length = 0
      existing.unread.bytes = 0
      return { id: existing.id, pid: null, kind: 'remote', attached: true, history }
    }
    if (typeof openRemoteChannel !== 'function') throw new Error('remote shell unavailable (no openShell)')
    const rows = Number.isInteger(opts.rows) && opts.rows > 0 ? opts.rows : 24
    const cols = Number.isInteger(opts.cols) && opts.cols > 0 ? opts.cols : 80
    const cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : undefined
    const handle = await openRemoteChannel(machine ?? {}, { rows, cols, ...(cwd ? { cwd } : {}) })
    const session = register(handle, {
      kind: 'remote',
      label: (machine && (machine.alias || machine.host)) || 'remote',
    }, key)
    return { id: session.id, pid: null, kind: 'remote', attached: false }
  }

  function requireSession(id) {
    const session = sessions.get(id)
    if (session === undefined) throw new Error(`shell session not found: ${id}`)
    return session
  }

  async function write(id, data) {
    const session = requireSession(id)
    session.lastActivityAt = Date.now()
    if (!session.ended && typeof data === 'string' && data !== '') await session.handle.write(data)
  }

  function read(id) {
    const session = requireSession(id)
    session.lastActivityAt = Date.now()
    const text = Buffer.concat(session.unread.chunks).toString('utf8')
    session.unread.chunks.length = 0
    session.unread.bytes = 0
    return { text, eof: session.ended }
  }

  async function resize(id, rows, cols) {
    const session = requireSession(id)
    if (session.ended) return { resized: false }
    if (typeof session.handle.resize === 'function') {
      session.handle.resize(rows, cols)
      return { resized: true }
    }
    return { resized: false }
  }

  async function close(id) {
    const session = sessions.get(id)
    if (session === undefined) return { closed: false }
    sessions.delete(id)
    await session.handle.terminate()
    return { closed: true }
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      id: session.id,
      pid: session.handle.pid ?? null,
      kind: session.meta.kind,
      label: session.meta.label,
      ended: session.ended,
    }))
  }

  return { openLocal, openRemote, write, read, resize, close, list, sweep }
}
