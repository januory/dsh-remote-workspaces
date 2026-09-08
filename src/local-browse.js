/**
 * Local-directory listing for the workspace-add flow's "本地文件夹" tab when
 * the page is NOT served from the host's own loopback (remote access): the OS
 * chooser would open on an unattended desktop, so the plugin browses the host
 * filesystem in-app instead. Pure Node stdlib (the plugin cannot import
 * harness packages); mirrors the `listRemoteDir` contract so the client reuses
 * the same entry rendering.
 *
 * Security posture: read-only one-level directory listing, driven by the user's
 * own GUI action. Never writes, never executes, and never enters the agent
 * toolchain's sandboxPolicy/approval line (same trust surface as the harness
 * `directory-picker-browse` backend).
 */

import { access, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'

/**
 * Wire value for the virtual Windows drive-selection level: listing it returns
 * the available drive roots. It is not a filesystem path, so it is fenced out
 * of every real-path branch (never fully qualified). The client sends it only
 * when a drive root's "上一级" is pressed on a win32 host (the client keeps an
 * identical copy of this constant).
 */
export const LOCAL_DRIVES = '::drives::'

/** The host account's home directory (listing default + `~` expansion). */
export function localHome() {
  return homedir()
}

/**
 * Available Windows drive roots (`C:\`, `D:\`, …) for the virtual drive level.
 * Empty on non-win32 platforms. Probes `A:`–`Z:` with fs access.
 * @param platform - replaces `process.platform` for deterministic tests.
 */
export async function localDriveRoots(platform = process.platform) {
  if (platform !== 'win32') return []
  const found = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      await access(root)
      found.push(root)
    } catch { /* absent drive */ }
  }
  return found
}

/**
 * True when the path names one fixed filesystem location regardless of process
 * state: POSIX-absolute on POSIX; on Windows only drive-qualified (`C:\…`) or
 * complete UNC (`\\server\share…`) forms. Rooted drive-less forms and
 * incomplete UNC prefixes pass `isAbsolute` yet still resolve against the
 * process's current drive — mirroring the harness browse backend's fence so a
 * wire value never rebases under the host cwd.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 */
export function localFullyQualified(path, platform = process.platform) {
  if (typeof path !== 'string') return false
  if (platform === 'win32') {
    return win32.isAbsolute(path)
      && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
  }
  return posix.isAbsolute(path)
}

/** Not-absolute / non-`~` input: never rebase under the host cwd. */
function notAbsolute(raw) {
  const error = new Error(`不是完整路径（需要绝对路径或以 ~ 开头）：${String(raw)}`)
  error.code = 'DSH_NOT_ABSOLUTE'
  return error
}

/** Resolve + normalize one fully qualified target on the platform. */
function normalizeTarget(input, platform) {
  return platform === 'win32' ? win32.resolve(input) : posix.resolve(input)
}

/** Platform-consistent segment join (node's default join is host-flavored). */
function platformJoin(a, b, platform) {
  return platform === 'win32' ? win32.join(a, b) : posix.join(a, b)
}

/**
 * Turn the RPC's raw `path` argument into a concrete absolute listing target.
 * `''`/undefined/`~`/`~/…` expand to the home directory; anything else must be
 * fully qualified (client-browsed paths are, and `..` segments are resolved by
 * the platform resolver, so the client's "上一级" can send `<path>/..`).
 * @param raw - the wire value (may be undefined).
 * @param home - home directory to expand against.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns the absolute listing target.
 * @throws {Error} with `code === 'DSH_NOT_ABSOLUTE'` for non-`~` relative input.
 */
export function expandLocalTarget(raw, home, platform = process.platform) {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (input === '' || input === '~') return normalizeTarget(home, platform)
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return normalizeTarget(platformJoin(home, input.slice(2), platform), platform)
  }
  if (!localFullyQualified(input, platform)) throw notAbsolute(raw)
  return normalizeTarget(input, platform)
}

/** Classify one dirent: directories (symlinked dirs probed) are enterable rows. */
async function entryRow(target, dirent) {
  const isDirectory = dirent.isDirectory()
  if (!isDirectory && dirent.isSymbolicLink()) {
    try {
      return { name: dirent.name, dir: (await stat(join(target, dirent.name))).isDirectory() }
    } catch {
      // Broken/cyclic link: keep a plain (non-enterable) row.
      return { name: dirent.name, dir: false }
    }
  }
  return { name: dirent.name, dir: isDirectory }
}

/**
 * List one directory level. Directories and files both return (files render
 * muted and non-clickable, mirroring the remote tab); `.`/`..` are dropped;
 * rows are name-sorted. The complete level is bounded at `maxEntries` rows with
 * `truncated` flagging a cut tail.
 * @param target - absolute listing target (already expanded).
 * @param opts - `maxEntries` bound (default 1000, like the harness browse
 * backend); `platform` for tests.
 * @returns `{ path, entries: [{name, dir}], truncated }`.
 * @throws filesystem errors (`ENOENT`/`ENOTDIR`/`EACCES`…) unchanged.
 */
export async function localLevelListing(target, opts = {}) {
  const maxEntries = opts.maxEntries === undefined ? 1000 : opts.maxEntries
  const entries = (await readdir(target, { withFileTypes: true }))
    .filter((d) => d.name !== '.' && d.name !== '..')
  const rows = []
  for (const dirent of entries) {
    if (rows.length === maxEntries) break
    // eslint-disable-next-line no-await-in-loop -- per-entry symlink probes are sequential like the remote backend.
    rows.push(await entryRow(target, dirent))
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return {
    path: target,
    entries: rows,
    truncated: entries.length > maxEntries,
  }
}

/**
 * Operator-facing text for a failed local listing.
 * @param error - thrown value (filesystem error or DSH_NOT_ABSOLUTE).
 * @param target - resolved target (for messages naming the directory).
 */
export function localListError(error, target) {
  const code = error && error.code
  if (code === 'DSH_NOT_ABSOLUTE') {
    return error.message || '路径无效'
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return `目录不存在：${target}`
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `无权限读取：${target}`
  }
  return `无法读取目录：${target}（${error instanceof Error ? error.message : String(error)}）`
}
