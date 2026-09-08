import { randomUUID } from 'node:crypto'

/**
 * In-process registry of interactive UI shell sessions (S0: local only).
 *
 * Every `openLocal` allocates an INDEPENDENT PTY process through the harness's
 * `ctx.subprocess.spawnTerminal` seam — sessions never share a process, cwd,
 * stdin/stdout, or buffer. Lifecycle is process-local (matches ctx.terminals
 * semantics): no persistence, no cross-process recovery.
 *
 * The seam's SubprocessTerminalHandle has NO resize method (S0 finding), so a
 * session is allocated with a fixed rows/cols and the browser renders it at a
 * fixed size for now.
 */

export function createShellSessions(getSubprocess) {
  const sessions = new Map()

  async function openLocal(opts = {}) {
    const subprocess = getSubprocess()
    if (subprocess === undefined || typeof subprocess.spawnTerminal !== 'function') {
      throw new Error('subprocess service unavailable (no spawnTerminal)')
    }
    const win = process.platform === 'win32'
    const argv = win ? ['powershell.exe', '-NoLogo'] : ['bash', '-i']
    const cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : process.cwd()
    const rows = Number.isInteger(opts.rows) && opts.rows > 0 ? opts.rows : 24
    const cols = Number.isInteger(opts.cols) && opts.cols > 0 ? opts.cols : 80
    const handle = await subprocess.spawnTerminal({
      argv,
      cwd,
      rows,
      cols,
      graceMs: 3000,
    })
    const id = randomUUID()
    const session = { id, handle, chunks: [] }
    handle.output.on('data', (chunk) => { session.chunks.push(Buffer.from(chunk)) })
    sessions.set(id, session)
    return { id, pid: handle.pid }
  }

  function requireSession(id) {
    const session = sessions.get(id)
    if (session === undefined) throw new Error(`shell session not found: ${id}`)
    return session
  }

  async function write(id, data) {
    const session = requireSession(id)
    if (typeof data === 'string' && data !== '') await session.handle.write(data)
  }

  function read(id) {
    const session = requireSession(id)
    const text = Buffer.concat(session.chunks).toString('utf8')
    session.chunks.length = 0
    return { text }
  }

  async function close(id) {
    const session = sessions.get(id)
    if (session === undefined) return { closed: false }
    sessions.delete(id)
    await session.handle.terminate()
    return { closed: true }
  }

  function list() {
    return [...sessions.values()].map(session => ({ id: session.id, pid: session.handle.pid }))
  }

  return { openLocal, write, read, close, list }
}
