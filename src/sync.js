/**
 * Bidirectional sync between a local mirror and its remote origin.
 *
 * Model: a per-mirror "base manifest" records, for every synced file, the last
 * agreed remote state (`{ size, mtime }`, seconds) and local state
 * (`{ size, mtimeMs }`, milliseconds). A sync pass walks both sides, compares
 * each against the base, and reconciles with **remote-wins** semantics:
 *
 *   - remote changed (added/edited/deleted)  → applied to local
 *   - otherwise local changed (added/edited/deleted) → pushed to remote
 *
 * So when both sides changed the same file, the remote version wins (local is
 * overwritten); when the remote deleted a file the local side also touched, the
 * local copy is deleted too — the remote is authoritative.
 *
 * The manifest lives in `.dsh-remote-manifest.json` (separate from the
 * `.dsh-remote-meta.json` origin stamp), and is rebuilt after every pass.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, basename, relative } from 'node:path'
import { dirname as posixDirname, join as posixJoin } from 'node:path/posix'
import { remoteWorkspacesRoot } from './mirror.js'
import { appendSyncLog } from './sync-log.js'

const META_NAME = '.dsh-remote-meta.json'
const MANIFEST_NAME = '.dsh-remote-manifest.json'

// ---------------------------------------------------------------------------
// Meta / manifest persistence.
// ---------------------------------------------------------------------------
export function metaPath(localDir) {
  return join(localDir, META_NAME)
}

export function readMeta(localDir) {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(localDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function manifestPath(localDir) {
  return join(localDir, MANIFEST_NAME)
}

export function readManifest(localDir) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(localDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeManifest(localDir, manifest) {
  mkdirSync(localDir, { recursive: true })
  writeFileSync(manifestPath(localDir), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Tree walking (bounded). Manifest keys are POSIX relative paths (`a/b/c.js`).
// ---------------------------------------------------------------------------
async function walkRemote(sftp, root, maxDepth, maxFiles) {
  const map = new Map()
  let count = 0
  async function walk(dir, rel, depth) {
    let entries
    try {
      entries = await sftp.readdir(dir)
    } catch {
      return
    }
    for (const e of entries ?? []) {
      if (count >= maxFiles) return
      const name = String(e.filename)
      if (name === '.' || name === '..' || name.startsWith('.dsh-')) continue
      const rp = dir.endsWith('/') ? dir + name : dir + '/' + name
      const relP = rel === '' ? name : rel + '/' + name
      const attrs = e.attrs
      const isDir = !!(attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory())
      if (isDir) {
        if (depth > 0) await walk(rp, relP, depth - 1)
        continue
      }
      const size = attrs && typeof attrs.size === 'number' ? attrs.size : 0
      const mtime = attrs && typeof attrs.mtime === 'number' ? attrs.mtime : 0
      map.set(relP, { type: 'file', size, mtime })
      count++
    }
  }
  await walk(root, '', maxDepth)
  return map
}

function walkLocal(root, maxDepth, maxFiles) {
  const map = new Map()
  let count = 0
  function walk(dir, rel, depth) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const de of entries) {
      if (count >= maxFiles) return
      const name = de.name
      if (name.startsWith('.dsh-')) continue
      const lp = join(dir, name)
      const relP = rel === '' ? name : rel + '/' + name
      if (de.isDirectory()) {
        if (depth > 0) walk(lp, relP, depth - 1)
        continue
      }
      let st
      try {
        st = statSync(lp)
      } catch {
        continue
      }
      map.set(relP, { type: 'file', size: st.size, mtimeMs: st.mtimeMs })
      count++
    }
  }
  walk(root, '', maxDepth)
  return map
}

// ---------------------------------------------------------------------------
// Change detection against the base.
// ---------------------------------------------------------------------------
function remoteChanged(cur, base) {
  if (cur === undefined) return base !== undefined
  if (base === undefined) return true
  return cur.size !== base.size || cur.mtime !== base.mtime
}

function localChanged(cur, base) {
  if (cur === undefined) return base !== undefined
  if (base === undefined) return true
  return cur.size !== base.size || cur.mtimeMs !== base.mtimeMs
}

function buildBase(remote, local, localDir) {
  const base = {}
  for (const [relPath, l] of local) {
    const r = remote.get(relPath)
    if (r && r.type === 'file') {
      let hash = null
      try {
        hash = hashBuf(readFileSync(join(localDir, relPath)))
      } catch {
        /* unreadable — leave hash empty */
      }
      base[relPath] = {
        remote: { size: r.size, mtime: r.mtime },
        local: { size: l.size, mtimeMs: l.mtimeMs },
        hash,
      }
    }
  }
  return base
}

function hashBuf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function hashRemoteFile(sftp, rp) {
  return hashBuf(await sftp.readFile(rp))
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Verify, immediately before unlinking a remote file, that it is still the
 * version we agreed on. Returns false when the file is already gone (nothing to
 * delete) or has changed since classification (a remote edit raced in — remote
 * wins, so we back off and let the next pass pull it). Content-hash comparison
 * catches same-second/same-size edits that mtime alone would miss.
 */
async function remoteStillMatchesBase(sftp, rp, b) {
  let st
  try {
    st = await sftp.stat(rp)
  } catch {
    return false // already gone remotely — nothing to delete
  }
  if (b && b.remote && typeof b.remote.size === 'number') {
    const stSize = typeof st.size === 'number' ? st.size : 0
    const stMtime = typeof st.mtime === 'number' ? st.mtime : 0
    if (stSize !== b.remote.size || stMtime !== b.remote.mtime) return false
  }
  if (b && b.hash) {
    try {
      if ((await hashRemoteFile(sftp, rp)) !== b.hash) return false
    } catch {
      /* unreadable — fall back to the size/mtime check above */
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Apply helpers.
// ---------------------------------------------------------------------------
function writeLocalFile(lp, buf) {
  mkdirSync(dirname(lp), { recursive: true })
  writeFileSync(lp, buf)
}

function deleteLocalFile(lp) {
  try {
    unlinkSync(lp)
    return true
  } catch {
    return false
  }
}

async function mkdirpRemote(sftp, posixDir) {
  const parts = posixDir.split('/').filter(Boolean)
  let cur = ''
  for (const p of parts) {
    cur = cur === '' ? '/' + p : cur + '/' + p
    try {
      await sftp.mkdir(cur)
    } catch {
      /* already exists or not permitted — keep going */
    }
  }
}

async function atomicWriteRemote(sftp, rp, buf) {
  const dir = posixDirname(rp)
  await mkdirpRemote(sftp, dir)
  // Unique temp name: a fixed `.dsh-sync-tmp` collides when two watcher
  // processes (e.g. the 3080 session + a 3090 test instance) sync the same
  // mirror concurrently — one renames the temp away while the other still
  // expects it, surfacing as "No such file". The `.dsh-` prefix also keeps
  // leftover temps out of `walkRemote`/`walkLocal`.
  const tmp = `${dir}/.dsh-sync-tmp-${randomBytes(6).toString('hex')}`
  await sftp.writeFile(tmp, buf)
  try {
    await sftp.unlink(rp)
  } catch {
    /* target absent — first upload */
  }
  try {
    await sftp.rename(tmp, rp)
  } catch (error) {
    await sftp.unlink(tmp).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Sync entry point.
// ---------------------------------------------------------------------------
export async function syncMirror(sftp, localDir, opts = {}) {
  const meta = readMeta(localDir)
  if (meta === null) return { ok: false, error: '不是远程工作区镜像（缺少 .dsh-remote-meta.json）' }
  const remotePath = meta.remotePath
  if (typeof remotePath !== 'string' || remotePath === '') {
    return { ok: false, error: '镜像缺少 remotePath' }
  }

  const maxDepth = opts.maxDepth ?? 4
  const maxFiles = opts.maxFiles ?? 1000
  const maxFileBytes = opts.maxFileBytes ?? 8 * 1024 * 1024
  const started = Date.now()
  const changes = []

  const base = readManifest(localDir).base ?? {}
  const remote = await walkRemote(sftp, remotePath, maxDepth, maxFiles)
  const local = walkLocal(localDir, maxDepth, maxFiles)

  const toPull = []
  const toPush = []
  const keys = new Set([...Object.keys(base), ...remote.keys(), ...local.keys()])
  for (const relPath of keys) {
    const b = base[relPath]
    const r = remote.get(relPath)
    const l = local.get(relPath)
    const rChanged = remoteChanged(r, b ? b.remote : undefined)
    const lChanged = localChanged(l, b ? b.local : undefined)
    if (rChanged) {
      toPull.push({ relPath, entry: r })
    } else if (lChanged) {
      // SFTP mtime has 1s granularity, so a same-size remote edit within the
      // same second is invisible to mtime. Verify by content hash before
      // trusting that the remote is truly unchanged (remote wins if it moved).
      let remoteReallyChanged = false
      if (r !== undefined && b && b.hash) {
        try {
          const remoteHash = await hashRemoteFile(sftp, posixJoin(remotePath, relPath))
          if (remoteHash !== b.hash) remoteReallyChanged = true
        } catch {
          /* unreadable — fall back to the mtime heuristic */
        }
      }
      if (remoteReallyChanged) toPull.push({ relPath, entry: r })
      else toPush.push({ relPath, entry: l })
    }
  }

  let pulled = 0
  let pushed = 0
  let skippedLarge = 0
  let failed = 0

  // Remote wins: apply remote state to local.
  for (const { relPath, entry } of toPull) {
    const lp = join(localDir, relPath)
    if (entry === undefined) {
      if (deleteLocalFile(lp)) {
        pulled++
        changes.push({ path: relPath, action: 'delete-local' })
      }
    } else {
      let buf
      try {
        buf = await sftp.readFile(posixJoin(remotePath, relPath))
      } catch {
        continue
      }
      if (buf.length > maxFileBytes) {
        skippedLarge++
        changes.push({ path: relPath, action: 'skip-large' })
      } else {
        writeLocalFile(lp, buf)
        pulled++
        changes.push({ path: relPath, action: 'pull' })
      }
    }
  }

  // Before pushing local deletes to the remote, distinguish a genuine delete
  // from a transient save window (editors write a temp file and rename it over
  // the target, briefly removing the target). Deleting a remote file is
  // irreversible, so wait one short window and re-walk the local tree; a file
  // that reappeared is an edit-in-progress, not a delete.
  const deleteCandidates = toPush.filter((p) => p.entry === undefined)
  if (deleteCandidates.length > 0) {
    const confirmMs = opts.deleteConfirmMs ?? 1500
    if (confirmMs > 0) {
      await sleep(confirmMs)
      const localAfter = walkLocal(localDir, maxDepth, maxFiles)
      for (const cand of deleteCandidates) {
        if (localAfter.has(cand.relPath)) cand.skip = true
      }
    }
  }

  // Local-only changes: push to remote.
  for (const { relPath, entry, skip } of toPush) {
    const rp = posixJoin(remotePath, relPath)
    if (skip) {
      continue // reappeared during the confirm window — the next pass syncs it
    }
    if (entry === undefined) {
      // Re-verify the remote file still exists and still matches the base
      // before unlinking (a remote edit may have raced in — remote wins).
      if (!(await remoteStillMatchesBase(sftp, rp, base[relPath]))) {
        continue
      }
      try {
        await sftp.unlink(rp)
        pushed++
        changes.push({ path: relPath, action: 'delete-remote' })
      } catch (error) {
        failed++
        changes.push({ path: relPath, action: 'error', error: message(error) })
      }
    } else {
      let buf
      try {
        buf = readFileSync(join(localDir, relPath))
      } catch {
        continue
      }
      if (buf.length > maxFileBytes) {
        skippedLarge++
        changes.push({ path: relPath, action: 'skip-large' })
      } else {
        try {
          await atomicWriteRemote(sftp, rp, buf)
          pushed++
          changes.push({ path: relPath, action: 'push' })
        } catch (error) {
          // One file failing (transient race, permissions) must not abort the
          // rest of the sync — record it and continue.
          failed++
          changes.push({ path: relPath, action: 'error', error: message(error) })
        }
      }
    }
  }

  // Rebuild the base from the reconciled state.
  const remote2 = await walkRemote(sftp, remotePath, maxDepth, maxFiles)
  const local2 = walkLocal(localDir, maxDepth, maxFiles)
  writeManifest(localDir, {
    remotePath,
    lastSyncedAt: new Date().toISOString(),
    base: buildBase(remote2, local2, localDir),
  })

  const files = Object.keys(readManifest(localDir).base ?? {}).length
  const durationMs = Date.now() - started
  const result = { ok: true, pulled, pushed, skippedLarge, failed, files, remotePath, changes, durationMs }

  appendSyncLog({
    ts: new Date().toISOString(),
    trigger: opts.trigger ?? 'manual',
    host: meta.host ?? null,
    user: meta.username ?? null,
    port: meta.port ?? null,
    remotePath,
    localDir: basename(localDir),
    durationMs,
    ok: true,
    pulled,
    pushed,
    skippedLarge,
    failed,
    files,
    changes,
  })

  return result
}

/**
 * Record the initial base manifest right after a fresh `pullTree`, so the very
 * first sync is a no-op instead of a full re-download.
 */
export async function recordInitialBase(sftp, remotePath, localDir, opts = {}) {
  const maxDepth = opts.maxDepth ?? 4
  const maxFiles = opts.maxFiles ?? 1000
  const remote = await walkRemote(sftp, remotePath, maxDepth, maxFiles)
  const local = walkLocal(localDir, maxDepth, maxFiles)
  writeManifest(localDir, {
    remotePath,
    lastSyncedAt: new Date().toISOString(),
    base: buildBase(remote, local, localDir),
  })
}

// ---------------------------------------------------------------------------
// Mirror enumeration (for the settings list + the file watcher).
// ---------------------------------------------------------------------------
export function enumerateMirrors() {
  const root = remoteWorkspacesRoot()
  const out = []
  let machineDirs
  try {
    machineDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const md of machineDirs) {
    if (!md.isDirectory()) continue
    const machineDir = join(root, md.name)
    let mirrorDirs
    try {
      mirrorDirs = readdirSync(machineDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sd of mirrorDirs) {
      if (!sd.isDirectory()) continue
      const localDir = join(machineDir, sd.name)
      const meta = readMeta(localDir)
      if (meta !== null) out.push({ localDir, meta })
    }
  }
  return out
}

/**
 * Map a watcher `filename` (relative to the mirrors root) back to the mirror
 * dir it belongs to, so a file change can sync only that mirror instead of
 * every mirror. Returns `undefined` when the name is absent, is a bare
 * basename (ambiguous across mirrors), or matches no mirror — callers then fall
 * back to syncing everything.
 */
export function mirrorForChange(name, root = remoteWorkspacesRoot()) {
  if (typeof name !== 'string' || name === '') return undefined
  const rel = String(name).replace(/[\\/]+/g, '/')
  for (const { localDir } of enumerateMirrors()) {
    const mRel = relative(root, localDir).replace(/[\\/]+/g, '/')
    if (rel === mRel || rel.startsWith(mRel + '/')) return localDir
  }
  return undefined
}

export function summaryOf(localDir, meta) {
  const manifest = readManifest(localDir)
  return {
    localDir,
    remotePath: meta.remotePath ?? null,
    host: meta.host ?? null,
    port: meta.port ?? null,
    user: meta.username ?? null,
    lastSyncedAt: manifest.lastSyncedAt ?? null,
    files: Object.keys(manifest.base ?? {}).length,
  }
}
