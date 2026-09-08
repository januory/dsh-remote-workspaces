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
import { join } from 'node:path'
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

/** Record an anchor (idempotent by anchorPath). Returns the stored record.
 * `os` (optional) is the probed remote profile `{ family, os, shell }` used
 * by prompt/dialect hints; older rows without it are backfilled lazily. */
export function registerAnchor({ anchorPath, machineId, host, port, user, remotePath, os }) {
  const anchors = loadAnchors()
  const rec = { machineId, host, port, user, remotePath, registeredAt: new Date().toISOString() }
  if (os !== undefined && os !== null) rec.os = os
  anchors[anchorPath] = rec
  saveAnchors(anchors)
  return anchors[anchorPath]
}

/** Backfill (or replace) the probed remote profile on an existing anchor row. */
export function updateAnchorOs(anchorPath, os) {
  const anchors = loadAnchors()
  const rec = anchors[anchorPath]
  if (rec === undefined) return undefined
  rec.os = os
  saveAnchors(anchors)
  return rec
}

/** Remove one anchor by its local path. */
export function unregisterAnchor(anchorPath) {
  const anchors = loadAnchors()
  delete anchors[anchorPath]
  saveAnchors(anchors)
}

/**
 * Resolve a session cwd — the anchor path, any descendant, or the Files tree's
 * `/`-joined child spelling of either — to its remote origin. Returns
 * `{ anchorPath, remotePath, remoteSubpath, host, port, user, machineId }` or
 * `undefined` when the cwd is not under any registered anchor.
 *
 * Matching is done on separator-normalized forms: anchor keys are stored with
 * the native `sep` (`\` on Windows), while harness session cwds and the right
 * Sidebar Files tree spell paths with `/` (and children are `root + '/' + name`
 * even when the root is `\`-spelled). `remoteSubpath` is always `/`-joined.
 */
export function findByCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const anchors = loadAnchors()
  const flat = (p) => p.replace(/\\/g, '/')
  const query = flat(cwd)
  let best
  let bestLen = -1
  for (const [anchorPath, rec] of Object.entries(anchors)) {
    const base = flat(anchorPath)
    const prefix = base.endsWith('/') ? base : `${base}/`
    if (query === base || query.startsWith(prefix)) {
      if (base.length > bestLen) {
        bestLen = base.length
        best = { anchorPath, base, rec }
      }
    }
  }
  if (best === undefined) return undefined
  const rel = query === best.base ? '' : query.slice(best.base.length + 1)
  return { ...best.rec, anchorPath: best.anchorPath, remoteSubpath: rel }
}

export default { loadAnchors, registerAnchor, unregisterAnchor, updateAnchorOs, findByCwd, remoteWorkspacesRoot }
