/**
 * Append-only sync history log (JSONL), stored at
 * `<dsh-home>/remote-workspaces/.dsh-sync-log.jsonl`.
 *
 * Scope rules: every entry records metadata only — timestamp, trigger, machine
 * identity (host/user/port), the remote path, counts, duration, and the changed
 * file PATHS (never file contents). Credentials (password / passphrase / key
 * material) are never written. The log is bounded (last N entries) so it cannot
 * grow without limit.
 */

import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { machinesRoot } from './machine-store.js'

const LOG_NAME = '.dsh-sync-log.jsonl'
const MAX_ENTRIES = 500
const MAX_CHANGES_PER_ENTRY = 200

export function syncLogPath() {
  return join(machinesRoot(), 'remote-workspaces', LOG_NAME)
}

/** Append one entry and trim the file to the last MAX_ENTRIES lines. */
export function appendSyncLog(entry) {
  const path = syncLogPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    let changes = entry.changes
    if (Array.isArray(changes) && changes.length > MAX_CHANGES_PER_ENTRY) {
      changes = changes.slice(0, MAX_CHANGES_PER_ENTRY)
    }
    const line = JSON.stringify({ ...entry, changes: changes ?? [] }) + '\n'
    writeFileSync(path, line, { flag: 'a', encoding: 'utf8' })
    trimLog(path)
  } catch {
    /* logging must never break a sync */
  }
}

function trimLog(path) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '')
    if (lines.length <= MAX_ENTRIES) return
    writeFileSync(path, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf8')
  } catch {
    /* best-effort rotation */
  }
}

/** Read recent entries (most recent first), optionally filtered by host. */
export function readSyncLog({ limit = 20, host } = {}) {
  const path = syncLogPath()
  if (!existsSync(path)) return []
  try {
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l))
      .filter((e) => e && typeof e === 'object')
    const filtered = host !== undefined && host !== '' ? entries.filter((e) => e.host === host) : entries
    return filtered.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES))).reverse()
  } catch {
    return []
  }
}

export function clearSyncLog() {
  try {
    writeFileSync(syncLogPath(), '', 'utf8')
    return true
  } catch {
    return false
  }
}
