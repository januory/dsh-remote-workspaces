/**
 * Workspace-write containment, mirrored from the harness's
 * `@deepseek-ai/dsh-sandbox` (roots.ts) and `@deepseek-ai/dsh-fs-sandbox`
 * (containment.ts) so the plugin's LOCAL half fences writes with the exact
 * same semantics without importing harness packages (which would dual-package
 * the Cordis context).
 *
 * `workspace-write` = "the policy's workspace root plus the platform temp
 * areas", canonicalized; containment is lexical-prefix with a filesystem-
 * identity fallback for Windows 8.3/case aliases.
 */

import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    // Missing root matches nothing until it exists — the conservative outcome.
    return path
  }
}

/** The canonical writable roots for a policy (empty under anything but workspace-write). */
export function writableRoots(policy) {
  if (policy === undefined || policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}

function comparablePath(path, caseSensitive) {
  return caseSensitive ? path : path.toLowerCase()
}

function isLexicallyUnder(path, root, caseSensitive) {
  const target = comparablePath(path, caseSensitive)
  const base = comparablePath(root, caseSensitive)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  return target.startsWith(prefix)
}

async function statIfPresent(path) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (MISSING_CODES.has(error.code)) return undefined
    throw error
  }
}

/** Whether `path` is `root` or a descendant of it (canonical spellings). */
export async function isPathUnder(path, root, caseSensitive = process.platform !== 'win32') {
  if (isLexicallyUnder(path, root, caseSensitive)) return true
  const rootInfo = await statIfPresent(root)
  if (!rootInfo) return false
  let ancestor = path
  while (true) {
    const info = await statIfPresent(ancestor)
    if (info && info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

export default { writableRoots, isPathUnder }
