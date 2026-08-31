/**
 * Local mirror of a remote workspace — the "open remote folder as a DSH
 * workspace" half.
 *
 * The mirror is a plain local directory under `<dsh-home>/remote-workspaces/
 * <host>-<user>-<port>/<basename>` plus a `.dsh-remote-meta.json` describing
 * its remote origin. Because it is a real local directory, `fs.realpath`
 * succeeds and the harness adopts it through `ctx.workspaceRegistry.create`
 * with zero core modification — exactly the approach of the reference project
 * (flymysql/dsh-remote).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machinesRoot } from './machine-store.js'

/** Root holding every remote host's mirrors (alongside machines.json). */
export function remoteWorkspacesRoot() {
  return join(machinesRoot(), 'remote-workspaces')
}

/** Local mirrors of one machine: `<dsh-home>/remote-workspaces/<host>-<user>-<port>`. */
export function mirrorRootFor(machine) {
  const m = machine ?? {}
  const tag = [m.host, m.user, m.port]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join('-')
    .replace(/[^a-zA-Z0-9._-]/g, '_') || 'host'
  return join(remoteWorkspacesRoot(), tag)
}

function safeBase(name) {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '--') // path separators + Windows-illegal chars → '--'
    .replace(/^--+|--+$/g, '')       // trim leading/trailing separators
  return base === '' || base === '.' || base === '..' ? 'workspace' : base
}

/**
 * Local mirror dir for a specific remote path (idempotent). The FULL remote
 * path is encoded (not just its basename), so two different directories that
 * share a basename — e.g. `/home/test` vs `/data/test` — land in distinct
 * local dirs (`home--test` vs `data--test`) instead of colliding on `test`.
 */
export function mirrorDirFor(machine, remotePath) {
  const rel = String(remotePath || '').replace(/^\/+/, '')
  return join(mirrorRootFor(machine), safeBase(rel))
}

/** Create the mirror dir and stamp its remote-origin metadata. */
export function ensureMirror(machine, remotePath) {
  const dir = mirrorDirFor(machine, remotePath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.dsh-remote-meta.json'),
    JSON.stringify({
      host: machine?.host ?? null,
      port: machine?.port ?? null,
      username: machine?.user ?? null,
      remotePath,
      createdAt: new Date().toISOString(),
    }, null, 2) + '\n',
    'utf8',
  )
  return dir
}

/**
 * One-way recursive SFTP pull (remote → local mirror), bounded by depth, file
 * count, and per-file size. Returns a plain-JSON stats object.
 */
export async function pullTree(sftp, remoteDir, localDir, opts = {}) {
  const { maxDepth = 4, maxFiles = 1000, maxFileBytes = 8 * 1024 * 1024 } = opts
  const stats = { files: 0, dirs: 0, skippedLarge: 0 }
  mkdirSync(localDir, { recursive: true })

  async function walk(rDir, lDir, depth) {
    let entries
    try { entries = await sftp.readdir(rDir) } catch { return }
    if (!Array.isArray(entries)) return
    for (const e of entries) {
      if (stats.files >= maxFiles) return
      const name = String(e.filename)
      if (name === '.' || name === '..') continue
      const isDir = !!(e.attrs && typeof e.attrs.isDirectory === 'function' && e.attrs.isDirectory())
      const rp = rDir.endsWith('/') ? rDir + name : rDir + '/' + name
      const lp = join(lDir, name)
      if (isDir) {
        if (depth <= 0) continue
        mkdirSync(lp, { recursive: true })
        await walk(rp, lp, depth - 1)
        stats.dirs++
        continue
      }
      try {
        const st = await sftp.stat(rp)
        if (maxFileBytes > 0 && st && typeof st.size === 'number' && st.size > maxFileBytes) {
          stats.skippedLarge++
          continue
        }
        const buf = await sftp.readFile(rp)
        writeFileSync(lp, buf)
        stats.files++
      } catch { /* skip unreadable */ }
    }
  }

  await walk(remoteDir, localDir, maxDepth)
  return stats
}
