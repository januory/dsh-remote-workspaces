/**
 * Remote-workspace registry: the durable map from a LOCAL anchor directory to
 * its remote origin (machine + remote path). This is the routing key the
 * `RoutingFileSystem` and `SshShellExecutor` consult per session cwd.
 *
 * An anchor is an EMPTY local directory adopted by the harness as the
 * workspace identity (`fs.realpath` must resolve it); all file/command I/O is
 * routed to the remote, never through the anchor's contents.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { remoteWorkspacesRoot } from './anchor.js'

function anchorsPath() {
  return join(remoteWorkspacesRoot(), 'anchors.json')
}

/** Load the anchor map (anchorPath → record). Returns {} when absent. */
export function loadAnchors() {
  const file = anchorsPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveAnchors(anchors) {
  const root = remoteWorkspacesRoot()
  try { mkdirSync(root, { recursive: true }) } catch {}
  writeFileSync(anchorsPath(), JSON.stringify(anchors, null, 2) + '\n', 'utf8')
}

/** Record an anchor (idempotent by anchorPath). Returns the stored record. */
export function registerAnchor({ anchorPath, machineId, host, port, user, remotePath }) {
  const anchors = loadAnchors()
  anchors[anchorPath] = { machineId, host, port, user, remotePath, registeredAt: new Date().toISOString() }
  saveAnchors(anchors)
  return anchors[anchorPath]
}

/** Remove one anchor by its local path. */
export function unregisterAnchor(anchorPath) {
  const anchors = loadAnchors()
  delete anchors[anchorPath]
  saveAnchors(anchors)
}

/**
 * Resolve a session cwd (the anchor path, or any descendant) to its remote
 * origin. Returns `{ anchorPath, remotePath, remoteSubpath, host, port, user, machineId }`
 * or `undefined` when the cwd is not under any registered anchor.
 */
export function findByCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const anchors = loadAnchors()
  let best
  let bestLen = -1
  for (const [anchorPath, rec] of Object.entries(anchors)) {
    const base = anchorPath.endsWith(sep) ? anchorPath : anchorPath + sep
    if (cwd === anchorPath || cwd.startsWith(base)) {
      if (anchorPath.length > bestLen) {
        bestLen = anchorPath.length
        best = { anchorPath, ...rec }
      }
    }
  }
  if (best === undefined) return undefined
  const rel = cwd === best.anchorPath ? '' : cwd.slice(best.anchorPath.length + sep.length)
  return { ...best, remoteSubpath: rel === '' ? '' : rel.split(sep).join('/') }
}

export default { loadAnchors, registerAnchor, unregisterAnchor, findByCwd, remoteWorkspacesRoot }
