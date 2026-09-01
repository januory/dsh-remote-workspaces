/**
 * Local anchor of a remote workspace — the "open a remote folder as a DSH
 * workspace" half.
 *
 * An anchor is a plain EMPTY local directory under
 * `<dsh-home>/remote-workspaces/<host>-<user>-<port>/<encoded-path>` plus a
 * `.dsh-remote-meta.json` describing its remote origin. Because it is a real
 * local directory, `fs.realpath` succeeds and the harness adopts it through
 * `ctx.workspaceRegistry.create` with zero core modification — but it holds NO
 * file content: all file and command I/O is routed straight to the remote over
 * SSH (see registry.js / routing-fs.js / shell-exec.js).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { machinesRoot } from './machine-store.js'

/** Root holding every remote host's anchors (alongside machines.json). */
export function remoteWorkspacesRoot() {
  return join(machinesRoot(), 'remote-workspaces')
}

/** Per-machine anchor root: `<dsh-home>/remote-workspaces/<host>-<user>-<port>`. */
export function anchorRootFor(machine) {
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
 * Local anchor dir for a specific remote path (idempotent). The FULL remote
 * path is encoded (not just its basename), so two different directories that
 * share a basename — e.g. `/home/test` vs `/data/test` — land in distinct
 * local dirs (`home--test` vs `data--test`) instead of colliding on `test`.
 */
export function anchorDirFor(machine, remotePath) {
  const rel = String(remotePath || '').replace(/^\/+/, '')
  return join(anchorRootFor(machine), safeBase(rel))
}

/** Create the anchor dir and stamp its remote-origin metadata. */
export function ensureAnchor(machine, remotePath) {
  const dir = anchorDirFor(machine, remotePath)
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
